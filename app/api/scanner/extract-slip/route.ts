import { NextResponse } from "next/server";
import { getOrganizationOpenAIApiKey } from "@/lib/organization-openai-key";
import { parseSlipVisionExtractFromContent, type SlipVisionExtract } from "@/lib/scanner/slip-extract-parse";

const VISION_MODEL = "gpt-4o";

const SLIP_VISION_PROMPT = `You are an OCR assistant for warehouse returns packing slips (Amazon removal / VRET style).

Read the image carefully and return ONLY valid JSON — no markdown, no code fences — with exactly this shape:
{
  "vret_id": string | null,
  "shipment_id": string | null,
  "carrier": string | null,
  "amazon_order_id": string | null,
  "items": [
    {
      "sku": string | null,
      "asin": string | null,
      "barcode": string | null,
      "description": string | null,
      "expected_qty": number
    }
  ]
}

Rules:
- vret_id: Amazon removal / RMA style IDs like VRET7623723875531 when visible; otherwise null.
- shipment_id: Carrier tracking (e.g. UPS starting with 1Z), Amazon TRACK-..., or primary outbound tracking; otherwise null.
- carrier: Shipping carrier name when visible (e.g. "UPS", "FedEx", "USPS", "Amazon", "DHL"). Use the exact label printed on the slip. Otherwise null.
- amazon_order_id: Amazon marketplace order id printed on the slip in the format 111-1234567-8901234 (three digits, dash, seven digits, dash, seven digits). Otherwise null.
- items: one entry per distinct product line on the slip with quantities from the slip (non-negative integers).
- barcode: UPC, EAN, or FNSKU printed on the slip when visible; otherwise null.
- Use null for unknown strings. If no line items are readable, use "items": [].`;

export async function POST(req: Request) {
  let body: { imageBase64?: string; mimeType?: string; organizationId?: string };
  try {
    body = (await req.json()) as { imageBase64?: string; mimeType?: string; organizationId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const b64 = body.imageBase64?.trim();
  if (!b64) {
    return NextResponse.json({ error: "Missing imageBase64" }, { status: 400 });
  }

  const mime = body.mimeType?.trim() || "image/jpeg";
  const dataUrl = `data:${mime};base64,${b64}`;

  const auth = req.headers.get("authorization");
  let apiKey = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!apiKey && body.organizationId?.trim()) {
    apiKey = (await getOrganizationOpenAIApiKey(body.organizationId.trim())) ?? "";
  }
  if (!apiKey) {
    apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  }

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "No OpenAI API key: pass Authorization: Bearer sk-…, configure org OpenAI in Settings, or set OPENAI_API_KEY on the server.",
      },
      { status: 401 },
    );
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      temperature: 0.1,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: SLIP_VISION_PROMPT },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    }),
  });

  const json = (await res.json()) as {
    error?: { message?: string };
    choices?: { message?: { content?: string | null } }[];
  };

  if (!res.ok) {
    return NextResponse.json(
      { error: json.error?.message ?? `OpenAI error (${res.status})` },
      { status: res.status >= 400 && res.status < 600 ? res.status : 502 },
    );
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    return NextResponse.json({ error: "Empty OpenAI response" }, { status: 502 });
  }

  let slip: SlipVisionExtract;
  try {
    slip = parseSlipVisionExtractFromContent(content);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not parse slip JSON from model output" },
      { status: 422 },
    );
  }

  return NextResponse.json({ slip });
}
