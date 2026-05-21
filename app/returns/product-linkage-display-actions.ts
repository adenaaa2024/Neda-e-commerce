"use server";

import {
  buildProductLinkageDisplayContracts as buildContractsImpl,
  fetchProductLinkageDisplayContract as fetchContractImpl,
  type ProductLinkageDisplayInput,
} from "@/lib/product-linkage-display-enrich";
import type { ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";

export async function buildProductLinkageDisplayContracts(
  organizationId: string,
  items: ProductLinkageDisplayInput[],
): Promise<ProductLinkageDisplayContract[]> {
  return buildContractsImpl(organizationId, items);
}

export async function fetchProductLinkageDisplayContract(input: {
  organizationId: string;
  source_table: string;
  source_row_id: string;
  row: Record<string, unknown>;
}): Promise<ProductLinkageDisplayContract> {
  return fetchContractImpl(input);
}
