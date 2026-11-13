import type { AhClient } from "./client.ts";

export interface Store {
  id: number;
  name: string;
  storeType?: string;
  address?: { street?: string; houseNumber?: string; postalCode?: string; city?: string };
}

/** Stores nearest to a Dutch postal code. */
export async function searchStores(c: AhClient, postalCode: string): Promise<Store[]> {
  const query = `query SearchStores($filter: StoresFilterInput) {
  storesSearch(filter: $filter, limit: 5) {
    result { id name storeType address { street houseNumber postalCode city } }
  }
}`;
  const data = await c.graphql<{ storesSearch: { result: Store[] | null } }>(query, { filter: { postalCode } });
  return data.storesSearch.result ?? [];
}

/** The member's favourite store, as set in the AH app, or undefined if none is set. */
export async function favouriteStore(c: AhClient): Promise<Store | undefined> {
  const query = `query FavouriteStore {
  storesFavouriteStore { id name storeType address { street houseNumber postalCode city } }
}`;
  const data = await c.graphql<{ storesFavouriteStore: Store | null }>(query);
  return data.storesFavouriteStore?.id ? data.storesFavouriteStore : undefined;
}

/** Last-chance (vandaag-af) markdown item. */
export interface Bargain {
  productId: number;
  title: string;
  brand?: string;
  category?: string;
  markdownType?: string;
  /** Discount percentage. */
  discount?: number;
  expirationDate?: string;
  stock?: number;
  priceWas?: string;
  priceNow?: string;
}

export async function getBargains(c: AhClient, storeId: number): Promise<Bargain[]> {
  const query = `query Bargains($storeId: String!) {
  bargainItems(storeId: $storeId) {
    product { id title brand }
    categoryTitle
    stock
    markdown { markdownType markdownExpirationDate markdownPercentage }
    bargainPrice { priceWas priceNow }
  }
}`;
  const data = await c.graphql<{
    bargainItems: {
      product: { id: number; title: string; brand?: string };
      categoryTitle?: string;
      stock?: number;
      markdown?: { markdownType?: string; markdownExpirationDate?: string; markdownPercentage?: number };
      bargainPrice?: { priceWas?: string; priceNow?: string };
    }[] | null;
  }>(query, { storeId: String(storeId) });
  return (data.bargainItems ?? []).map((b) => ({
    productId: b.product.id,
    title: b.product.title,
    brand: b.product.brand,
    category: b.categoryTitle,
    markdownType: b.markdown?.markdownType,
    discount: b.markdown?.markdownPercentage,
    expirationDate: b.markdown?.markdownExpirationDate,
    stock: b.stock,
    priceWas: b.bargainPrice?.priceWas,
    priceNow: b.bargainPrice?.priceNow,
  }));
}
