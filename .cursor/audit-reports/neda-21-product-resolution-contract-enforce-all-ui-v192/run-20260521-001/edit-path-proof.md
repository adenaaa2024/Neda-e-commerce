# Edit path proof

| Check | Result |
|-------|--------|
| `updateReturn` calls enrichment on identifier change | yes |
| Edit barcode preview (no write) | `previewOperatorItemBarcodeLinkageAction` in drawer |
| Post-save detail reload | `fetchReturnItemProductLinkageAction` |
| Staging enrich + hydrate probe | PASS — known=resolved fnsku=X00525Q5XZ unknown=unresolved rows=2 pkg=1871fd1e |

**Verdict:** PASS

Note: Returns `PackageDrawerContent` still has a **read-only** client fallback `supabaseBrowser.from(return_items).select` when page state is empty — not a save path.
