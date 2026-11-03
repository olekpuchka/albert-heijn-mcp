import type { AhClient } from "./client.ts";

/** Product card from search and detail responses. */
export interface Product {
  webshopId: number;
  title: string;
  brand?: string;
  mainCategory?: string;
  salesUnitSize?: string;
  unitPriceDescription?: string | null;
  descriptionHighlights?: string;
  nutriscore?: string | null;
  propertyIcons?: string[];
  images?: { url: string; width: number; height: number }[];
  /** Price now, bonus discount included. */
  currentPrice?: number;
  /** Regular price. */
  priceBeforeBonus?: number;
  isBonus?: boolean;
  bonusMechanism?: string | null;
  isOrderable?: boolean;
}

/**
 * Regular price, and the bonus price for products on bonus (else 0). Deals like
 * "2 voor 1.19" have no single bonus price: AH sends the regular price as both.
 */
export function productPrices(p: Product): { regular: number; bonus: number } {
  const now = p.currentPrice || p.priceBeforeBonus || 0;
  const regular = p.priceBeforeBonus || now;
  return { regular, bonus: p.isBonus && now < regular ? now : 0 };
}

/** Product page on ah.nl: /producten/product/wi<id>/<title slug>. */
export function productUrl(id: number, title = ""): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `https://www.ah.nl/producten/product/wi${id}${slug ? `/${slug}` : ""}`;
}

/** URL of the first image, or "". */
export function productImage(p: Product): string {
  return p.images?.[0]?.url ?? "";
}

/** Product fields shared by GraphQL queries; map with fromGraphqlProduct. */
export const GRAPHQL_PRODUCT_FIELDS =
  "id title brand salesUnitSize priceV2 { now { amount } was { amount } discount { description } }";

export interface GraphqlProduct {
  id: number;
  title: string;
  brand?: string;
  salesUnitSize?: string;
  priceV2?: {
    now?: { amount: number } | null;
    was?: { amount: number } | null;
    /** The bonus deal, e.g. "2 voor 1.19"; null if none. */
    discount?: { description?: string | null } | null;
  };
}

export function fromGraphqlProduct(p: GraphqlProduct): Product {
  const now = p.priceV2?.now?.amount;
  const was = p.priceV2?.was?.amount;
  const deal = p.priceV2?.discount;
  return {
    webshopId: p.id,
    title: p.title,
    brand: p.brand,
    salesUnitSize: p.salesUnitSize,
    currentPrice: now,
    priceBeforeBonus: was,
    // Multi-buy deals ("2 voor 1.19") keep the regular price, so the deal itself marks a bonus.
    isBonus: Boolean(deal) || (now !== undefined && was !== undefined && now < was),
    bonusMechanism: deal?.description,
  };
}

/** Products AH suggests instead of id (similar or substitute products). */
export async function getProductAlternatives(c: AhClient, id: number, size: number): Promise<Product[]> {
  const query = `query ProductAlternatives($id: Int!, $size: PageSize!) {
  productAlternatives(id: $id, size: $size) { products { ${GRAPHQL_PRODUCT_FIELDS} } }
}`;
  const data = await c.graphql<{ productAlternatives: { products: GraphqlProduct[] } | null }>(query, { id, size });
  return (data.productAlternatives?.products ?? []).map(fromGraphqlProduct);
}

export type SearchSort = "RELEVANCE" | "PRICELOWHIGH" | "PRICEHIGHLOW" | "PURCHASE_FREQUENCY" | "NUTRISCORE";

export interface SearchOptions {
  /** AH property ids, e.g. np_biologisch; a product must have all of them. */
  properties?: string[];
  /** Only products on bonus. */
  bonus?: boolean;
  sort?: SearchSort;
}

/** Largest page AH serves. */
const MAX_PAGE = 100;

/** Searches by keyword; returns at most size products. */
export async function searchProducts(c: AhClient, query: string, size: number, opts: SearchOptions = {}): Promise<Product[]> {
  const properties = opts.properties ?? [];
  // AH takes one filter per request (repeated ones get mixed up), so bonus plus properties is filtered here.
  const filterBonus = Boolean(opts.bonus) && properties.length > 0;
  // Sorting low to high lists unavailable products without a price first (30 of 100 for "kaas"); they are dropped.
  const byPrice = opts.sort === "PRICELOWHIGH" || opts.sort === "PRICEHIGHLOW";
  let fetch = size;
  if (opts.sort === "PRICELOWHIGH") fetch = MAX_PAGE;
  else if (filterBonus) fetch = Math.min(Math.max(size * 4, 40), MAX_PAGE);

  const params = new URLSearchParams({ query, page: "0", size: String(fetch), sortOn: opts.sort ?? "RELEVANCE" });
  // Several properties go comma-separated, which AH combines with AND.
  if (properties.length) params.set("filters", `property=${properties.join(",")}`);
  else if (opts.bonus) params.set("filters", "bonus=Bonus");
  const res = await c.request<{ products?: Product[] }>(`/mobile-services/product/search/v2?${params}`);
  let products = res.products ?? [];
  if (opts.bonus) products = products.filter((p) => p.isBonus);
  if (byPrice) {
    // AH sorts on the regular price; re-sort on what the customer pays now, bonus included.
    const price = (p: Product) => p.currentPrice || p.priceBeforeBonus || 0;
    const dir = opts.sort === "PRICELOWHIGH" ? 1 : -1;
    products = products.filter(price).sort((a, b) => dir * (price(a) - price(b)));
  }
  return products.slice(0, size);
}

export async function getProduct(c: AhClient, id: number): Promise<Product> {
  const res = await c.request<{ productCard: Product }>(`/mobile-services/product/detail/v4/fir/${id}`);
  return res.productCard;
}

/** Ids per productsByIds call that keep the request URL a safe length. */
export const PRODUCT_IDS_BATCH = 50;

/** Returns products in the order of ids. */
export async function productsByIds(c: AhClient, ids: number[]): Promise<Product[]> {
  const params = new URLSearchParams({ sortOn: "INPUT_PRODUCT_IDS" });
  for (const id of ids) params.append("ids", String(id));
  return (await c.request<Product[]>(`/mobile-services/product/search/v2/products?${params}`)) ?? [];
}

/** Nutrition table row. */
export interface Nutrient {
  type: string;
  name: string;
  value: string;
}

/** First nutrition table (usually per 100 g/ml), or undefined if AH has none. */
export async function getNutrition(c: AhClient, id: number): Promise<Nutrient[] | undefined> {
  const query = `query ProductNutrition($id: Int!) {
  product(id: $id) {
    tradeItem { nutritions { nutrients { type name value } } }
  }
}`;
  const data = await c.graphql<{
    product: { tradeItem: { nutritions: { nutrients: Nutrient[] }[] | null } | null };
  }>(query, { id });
  return data.product.tradeItem?.nutritions?.[0]?.nutrients;
}

/** Most till ids convertPosIds takes in one call (one GraphQL request). */
export const POS_IDS_BATCH = 100;

/** Maps up to POS_IDS_BATCH receipt (till) product ids to webshop product ids; ids AH can't map are left out. */
export async function convertPosIds(c: AhClient, posIds: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(posIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length > POS_IDS_BATCH) throw new Error(`at most ${POS_IDS_BATCH} till ids per call`);
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  // Ids are integers, so inlining them is safe.
  const fields = ids.map((id, j) => `p${j}: productConvertId(sourceId: ${id})`).join(" ");
  // An id AH fails on stays unmapped without losing the rest of the batch.
  const { data, errors } = await c.graphqlPartial<Record<string, number | null>>(`query ConvertPosIds { ${fields} }`);
  if (!data) throw errors ?? new Error("AH returned no product ids");
  ids.forEach((id, j) => {
    const webshopId = data[`p${j}`];
    if (webshopId && webshopId > 0) out.set(id, webshopId);
  });
  return out;
}
