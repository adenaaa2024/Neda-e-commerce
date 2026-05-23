# Scanner flow impact

## Save path (scanner → DB)

- **`app/scanner/operator-mobile/item-actions.ts`** — `operatorReceiveItem` inserts via server action **`insertReturn`** in `app/returns/actions.ts`, which writes to **`RETURN_ITEMS_TABLE`** (`return_items`). Rollback deletes use `.from(RETURN_ITEMS_TABLE)`.
- Comments / user-facing error text updated to say **return_items** / **return item** where they previously implied a `returns` table row.

## Read / display path

- **`lib/scanner/operator-tracking-expectations.ts`** — All queries use `RETURN_ITEMS_TABLE` for scanned-unit counts. Exported helpers renamed for clarity:
  - `fetchReturnItemsScannedBySkuFnskuForPallet`
  - `fetchReturnItemsScannedBySkuFnskuForTracking`
- **`app/scanner/operator-mobile/scan/page.tsx`** — Store gate copy updated to “save **return items** …”. Imports already used `RETURN_ITEMS_TABLE` from `returns-constants`.

## Server actions / API touched

- **`app/returns/actions.ts`** — Comments and log prefixes aligned to `return_items` (logic already used `RETURN_ITEMS_TABLE` everywhere for this table).
- **`app/returns/_components.tsx`**, **`app/returns/page.tsx`**, **`app/returns/returns-action-types.ts`**, **`app/returns/claim-condition-labels.ts`** — Developer / operator-facing comments and one UI monospace string now reference **`return_items.*`** where they previously said **`returns.*`** for the physical table.
- **Claim engine helpers** (`claim-object.ts`, `claim-print-html-actions.ts`, `logistics-sync-actions.ts`) — JSDoc table names updated to `return_items` where they described the same physical row.

No new API routes were added; scanner APIs were not changed beyond any shared types/comments.
