import "server-only";

import { getOrganizationOpenAIApiKey } from "./organization-openai-key";

export type CategoryPickInput = { label: string; score: number; source: string }[];

/**
 * When OpenAI (org key or server env) is configured, pick one label from the list only.
 * Returns null if no key, too few candidates, or model returns invalid / NONE.
 */
export async function pickAmazonCategoryLabelWithOpenAI(params: {
  organizationId: string;
  productTitle: string | null;
  candidates: CategoryPickInput;
}): Promise<string | null> {
  const labels = params.candidates.map((c) => c.label.trim()).filter(Boolean);
  const unique = [...new Set(labels)];
  if (unique.length < 2) return null;
  const key = await getOrganizationOpenAIApiKey(params.organizationId);
  if (!key) return null;

  const top = params.candidates
    .filter((c) => c.label.trim())
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 8);

  const allowed = [...new Set(top.map((t) => t.label.trim()))];
  if (allowed.length < 2) return null;

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
            "You help organize retail catalog categories. Pick exactly one string from the provided `allowed` array that best fits the product title as a department/category label, or use {\"label\":null} if none are acceptable. Never invent a label outside `allowed`. JSON only.",
        },
        {
          role: "user",
          content: JSON.stringify({
            product_title: params.productTitle ?? "",
            allowed,
          }),
        },
      ],
    }),
    cache: "no-store",
  });
  const raw = (await res.json().catch(() => null)) as unknown as Record<string, unknown> | null;
  if (!res.ok || !raw) return null;
  const choice = raw.choices;
  if (!Array.isArray(choice) || !choice[0] || typeof choice[0] !== "object") return null;
  const msg = (choice[0] as unknown as Record<string, unknown>).message as unknown as Record<string, unknown> | undefined;
  const content = typeof msg?.content === "string" ? msg.content.trim() : "";
  if (!content) return null;
  let parsed: { label?: string | null } | null = null;
  try {
    parsed = JSON.parse(content) as { label?: string | null };
  } catch {
    return null;
  }
  const picked = typeof parsed?.label === "string" ? parsed.label.trim() : null;
  if (!picked || /^none$/i.test(picked)) return null;
  const hit = allowed.find((a) => a.toLowerCase() === picked.toLowerCase());
  return hit ?? null;
}
