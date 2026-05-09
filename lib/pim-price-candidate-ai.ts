import "server-only";

import { getOrganizationOpenAIApiKey } from "./organization-openai-key";

export type AmazonApiPriceCandidate = {
  amount: number;
  currency: string;
  /** Human-readable source for the model (must stay within API-returned data). */
  source: string;
};

/**
 * When two distinct Amazon API price candidates exist (offers vs catalog list), pick an index only.
 * Never invents amounts — must return a valid index into `params.candidates` or null.
 */
export async function pickAmazonApiPriceCandidateIndexWithOpenAI(params: {
  organizationId: string;
  productTitle: string | null;
  candidates: AmazonApiPriceCandidate[];
}): Promise<number | null> {
  const indexed = params.candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => Number.isFinite(c.amount) && c.amount > 0 && String(c.currency ?? "").trim().length > 0);
  if (indexed.length < 2) return null;
  const key = await getOrganizationOpenAIApiKey(params.organizationId);
  if (!key) return null;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You rank which single pre-validated price candidate is best for catalog display from the product title context. " +
            "You MUST pick exactly one index from `allowed_indices` (0..n-1). " +
            "Never invent or restate numeric prices — only choose an index. Each candidate amount was returned by Amazon APIs and is immutable. " +
            "If uncertain, prefer the index labeled as Product Pricing item offers (New) over Catalog list price. " +
            "Return JSON only: {\"index\": <int>} with index in allowed_indices.",
        },
        {
          role: "user",
          content: JSON.stringify({
            product_title: params.productTitle ?? "",
            candidates: indexed.map(({ c, i }) => ({
              index: i,
              amount: c.amount,
              currency: c.currency,
              source: c.source,
            })),
            allowed_indices: indexed.map(({ i }) => i),
          }),
        },
      ],
    }),
    cache: "no-store",
  });
  const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !raw) return null;
  const choice = raw.choices;
  if (!Array.isArray(choice) || !choice[0] || typeof choice[0] !== "object") return null;
  const msg = (choice[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
  const content = typeof msg?.content === "string" ? msg.content.trim() : "";
  if (!content) return null;
  let parsed: { index?: unknown } | null = null;
  try {
    parsed = JSON.parse(content) as { index?: unknown };
  } catch {
    return null;
  }
  const idx = typeof parsed?.index === "number" && Number.isInteger(parsed.index) ? parsed.index : null;
  if (idx == null) return null;
  const hit = indexed.find((x) => x.i === idx);
  if (!hit) return null;
  const orig = params.candidates[idx];
  if (
    !orig ||
    !Number.isFinite(orig.amount) ||
    !Number.isFinite(hit.c.amount) ||
    orig.amount !== hit.c.amount ||
    String(orig.currency ?? "").trim().toUpperCase() !== String(hit.c.currency ?? "").trim().toUpperCase()
  ) {
    return null;
  }
  return idx;
}
