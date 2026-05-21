# Build results

## npm run build

**PASS**

```
> ecommerce-os@0.1.0 build
> next build

▲ Next.js 16.1.7 (Turbopack)
- Environments: .env.local
- Experiments (use with caution):
  · serverActions

  Creating an optimized production build ...
✓ Compiled successfully in 14.8s
  Running TypeScript ...
  Collecting page data using 7 workers ...
  Generating static pages using 7 workers (0/41) ...
  Generating static pages using 7 workers (10/41) 
  Generating static pages using 7 workers (20/41) 
  Generating static pages using 7 workers (30/41) 
✓ Generating static pages using 7 workers (41/41) in 846.8ms
  Finalizing page optimization ...

Route (app)
┌ ƒ /
├ ƒ /_not-found
├ ƒ /admin/settings
├ ƒ /api/admin/ledger/upload
├ ƒ /api/admin/reset-password
├ ƒ /api/openai/packing-slip
├ ƒ /api/scanner/extract-box-slip
├ ƒ /api/scanner/extract-slip
├ ƒ /api/settings/imports/chunk
├ ƒ /api/settings/imports/classify-headers
├ ƒ /api/settings/imports/generate-worklist
├ ƒ /api/settings/imports/generic
├ ƒ /api/settings/imports/identity-enrich
├ ƒ /api/settings/imports/process
├ ƒ /api/settings/imports/reports-repo-header-ai
├ ƒ /api/settings/imports/stage
├ ƒ /api/settings/imports/sync
├ ƒ /api/settings/imports/upload-progress
├ ƒ /api/v1/agent/ai/chat/completions
├ ƒ /auth/forgot-password
├ ƒ /auth/reset-password
├ ƒ /claim-engine
├ ƒ /claim-engine/investigation/[submissionId]
├ ƒ /claim-engine/report-history
├ ƒ /home
├ ƒ /imports
├ ƒ /login
├ ƒ /platform/access
├ ƒ /platform/access/catalog
├ ƒ /platform/organizations
├ ƒ /platform/organizations/[id]
├ ƒ /platform/organizations/[id]/modules
├ ƒ /platform/organizations/new
├ ƒ /platform/settings
├ ƒ /platform/users
├ ƒ /profile
├ ƒ /returns
├ ƒ /scanner
├ ƒ /scanner/operator-mobile
├ ƒ /scanner/operator-mobile/scan
├ ƒ /settings
├ ƒ /settings/company
├ ƒ /settings/imports
└ ƒ /users


ƒ Proxy (Middleware)

ƒ  (Dynamic)  server-rendered on demand
```

## npx tsc --noEmit --pretty false

**PASS**

```
(no output)
```

## Stale reference scan (`app/scanner`)

| Pattern | Count | OK |
|---------|------:|:--:|
| package_items | 0 | ✅ |
| .from("returns") | 0 | ✅ |
| packages.package_number select | 0 | ✅ |
| pallets.photo_url select | 0 | ✅ |

**Overall stale:** PASS
