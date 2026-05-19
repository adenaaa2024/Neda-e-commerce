/**
 * PostgREST table name and safe column handling for `public.claim_submissions`.
 * Always use `CLAIM_SUBMISSIONS_TABLE` in `.from()` so renames stay centralized.
 */
import { RETURNS_EMBED_SELECTOR } from "../returns/returns-constants";

export const CLAIM_SUBMISSIONS_TABLE = "claim_submissions" as const;

/** FK to `return_items.id` — one submission row per return item ready to file. */
export const CLAIM_SUBMISSION_RETURN_ID_COLUMN = "return_id" as const;

/** JSON / PostgREST key for the embedded row from `claim_submissions.return_id` → `return_items`. */
export const CLAIM_SUBMISSION_RETURN_ITEMS_EMBED_KEY = "return_items" as const;

/** `claim_submissions` with embedded `return_items` (wildcard columns + store embed — avoids phantom legacy columns). */
export const CLAIM_SUBMISSIONS_WITH_RETURN_ITEMS_EMBED =
  `*,${CLAIM_SUBMISSION_RETURN_ITEMS_EMBED_KEY}(${RETURNS_EMBED_SELECTOR})`;

/** @deprecated Use `CLAIM_SUBMISSIONS_WITH_RETURN_ITEMS_EMBED`. */
export const CLAIM_SUBMISSIONS_WITH_RETURNS_EMBED = CLAIM_SUBMISSIONS_WITH_RETURN_ITEMS_EMBED;
