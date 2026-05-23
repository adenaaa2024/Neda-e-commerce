import { NextResponse } from "next/server";
import { getOrganizationOpenAIApiKey } from "@/lib/organization-openai-key";
import {
  INVALID_SLIP_FORMAT,
  isStructuredBoxSlipExtractValid,
  parseBoxSlipVisionExtractFromContent,
  type BoxSlipVisionExtract,
} from "@/lib/scanner/box-slip-vision-parse";

const VISION_MODEL = "gpt-4o";

const BOX_SLIP_VISION_SYSTEM = `You are a precise warehouse packing-slip extraction engine.

Goal: read the image and output ONE JSON object only (no markdown, no prose, no code fences).

Required JSON shape (types as shown):
{
  "id_slip_contents": string | null,
  "rma_number": string | null,
  "order_id": string | null,
  "items": [
    {
      "upc": string | null,
      "fnsku": string | null,
      "printed_asin": string | null,
      "description": string | null,
      "qty": number,
      "condition": string | null
    }
  ]
}

Field rules:
- id_slip_contents (REQUIRED when visible): The packing-slip document / slip identifier — usually the human-readable or barcode value printed **directly under the slip’s main barcode** (not the carton shipping label). Examples: Amazon-style IDs starting with S, warehouse packing-list numbers, document IDs. Copy exactly as printed. **Never** put an RMA / RA / return-authorization value here; those belong only in rma_number. If you only see a return-auth number and no separate slip document id, set id_slip_contents to null.
- rma_number: Return authorization only (RMA, RA, Return #, etc.). Value only, no label. null if absent. Must not be duplicated into id_slip_contents.
- order_id: The **marketplace / removal / customer order id** printed on the slip (e.g. Amazon order id, hyphenated removal id) if it appears **separately** from the RMA line. Copy exactly as printed. null if not visible or only the RMA token is present (do not duplicate the full RMA string here if it is the same as rma_number).
- items: A CLEAN JSON ARRAY — one object per distinct shippable line that has a product identity and/or quantity.
  For EACH line extract:
  • SKU / seller identifier: put Amazon FNSKU (often X00…) or seller SKU / part number / ASIN printed in the SKU column into "fnsku" when that is the main seller code. Use "printed_asin" for a B0… ASIN when clearly separate from FNSKU.
  • UPC: 12-digit consumer UPC when present (digits only in "upc"); otherwise null.
  • description: product title or line description as printed; null if unreadable.
  • qty: integer ≥ 0 — ordered / shipped quantity for that line (default 0 only if quantity truly missing).
  • condition: New / Used / etc. when shown; else null.
- Use null for unknown strings. Omit extra keys outside the schema.
- If no line items can be read, return "items": [].`;

const BOX_SLIP_VISION_USER =
  "Extract all line items and slip metadata from this packing slip image. For id_slip_contents, use the slip / document identifier printed directly under the slip's own barcode (not shipping labels or RMA text). Return only the JSON object.";

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
        { role: "system", content: BOX_SLIP_VISION_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: BOX_SLIP_VISION_USER },
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

  let slip: BoxSlipVisionExtract;
  try {
    slip = parseBoxSlipVisionExtractFromContent(content);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not parse slip JSON from model output" },
      { status: 422 },
    );
  }

  if (!isStructuredBoxSlipExtractValid(slip)) {
    return NextResponse.json(
      {
        error: INVALID_SLIP_FORMAT,
        message:
          "This image does not look like a packing slip (need slip id, line items with quantities, and product barcodes). Use a clear photo of the slip.",
      },
      { status: 422 },
    );
  }

  return NextResponse.json({ slip });
}
