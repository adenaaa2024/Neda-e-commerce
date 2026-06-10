/**
 * Scanner product resolution — delegates to Phase 10 canonical resolver.
 * @see lib/search/product-identifier-resolve.ts
 */
export {
  resolveProductIdentifier,
  resolveProductForScannerItem,
  type ResolveProductIdentifierInput,
  type ResolveProductIdentifierResult,
  type ResolveProductForScannerItemInput,
  type ResolveProductForScannerItemResult,
} from "@/lib/search/product-identifier-resolve";
