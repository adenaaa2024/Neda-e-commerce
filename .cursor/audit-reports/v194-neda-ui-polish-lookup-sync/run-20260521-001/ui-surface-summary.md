# V194 UI surface summary

| Area | Change |
|------|--------|
| Barcode preview | Server classifies ASIN/FNSKU/UPC/SKU via `buildOperatorBarcodeResolverFields` |
| Lookup UX | Blur/scan/enter/paste; try/catch clears loading; unresolved → **No product link yet** |
| Product detail | `?from=` scan/package/pallet/returns + context back link |
| Links | `ProductLinkagePrimaryLink` + meta without duplicate short-id link |
| Package drawer | Items table **Product** column uses `productLinkageFromReturnRecord` |
| Scan / modal | Primary product links on slip, EP, hydrated units |

**Verdict:** PASS (22/22)
