import { type AhClient, hasStatus } from "./client.ts";

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
  /** Only products in this category (see getSubcategories, TOP_CATEGORIES); with an empty query, the whole category. */
  categoryId?: number;
}

/** Largest page AH serves. */
const MAX_PAGE = 100;

interface SearchResponse {
  page?: { totalElements?: number };
  products?: Product[];
  /** Facets, e.g. the "taxonomy" one listing the categories of the results. */
  filters?: { id: string; options?: { id: string; label: string; count: number }[] }[];
}

/** One page of AH's product search. */
function searchPage(c: AhClient, params: URLSearchParams): Promise<SearchResponse> {
  return c.request<SearchResponse>(`/mobile-services/product/search/v2?${params}`);
}

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
  if (opts.categoryId) params.set("taxonomyId", String(opts.categoryId));
  // Several properties go comma-separated, which AH combines with AND.
  if (properties.length) params.set("filters", `property=${properties.join(",")}`);
  else if (opts.bonus) params.set("filters", "bonus=Bonus");
  const res = await searchPage(c, params);
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

/** Ids per productsByIds call that keep the request URL a safe length. */
export const PRODUCT_IDS_BATCH = 50;

/** Returns products in the order of ids, PRODUCT_IDS_BATCH per request; ids AH doesn't know are left out. */
export async function productsByIds(c: AhClient, ids: number[]): Promise<Product[]> {
  const products: Product[] = [];
  // One batch at a time, so a long list doesn't send AH a burst of requests.
  for (let i = 0; i < ids.length; i += PRODUCT_IDS_BATCH) {
    const params = new URLSearchParams({ sortOn: "INPUT_PRODUCT_IDS" });
    for (const id of ids.slice(i, i + PRODUCT_IDS_BATCH)) params.append("ids", String(id));
    products.push(...((await c.request<Product[]>(`/mobile-services/product/search/v2/products?${params}`)) ?? []));
  }
  return products;
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

/**
 * The code AH looks a barcode up by: its digits, a 12-digit UPC-A padded to the EAN-13 it is; undefined
 * unless that is an EAN-8, EAN-13 or GTIN-14.
 */
export function normalizeBarcode(barcode: string): string | undefined {
  // Only digits with spaces or dashes between them, as printed: other text ("x2") would change the number.
  if (!/^[\d\s-]+$/.test(barcode.trim())) return undefined;
  const digits = barcode.replace(/\D/g, "");
  // A 14-digit GTIN starting with 0 is the EAN-13 behind it: one form, so both share a lookup.
  const code = digits.length === 12 ? `0${digits}` : digits.length === 14 && digits[0] === "0" ? digits.slice(1) : digits;
  return [8, 13, 14].includes(code.length) ? code : undefined;
}

/**
 * Whether a normalized barcode's last digit is its GS1 check digit; a digit misread from a photo fails this.
 * 8-digit codes pass unchecked: a UPC-E has a different check digit than an EAN-8 of the same length.
 */
export function hasValidCheckDigit(code: string): boolean {
  if (code.length === 8) return true;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  // From the right: weights 3, 1, 3, 1, ...
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Webshop id of the product with this barcode (EAN/GTIN), or undefined if AH sells none. Throws on a malformed barcode. */
export async function productIdByBarcode(c: AhClient, barcode: string): Promise<number | undefined> {
  const code = normalizeBarcode(barcode);
  if (!code) throw new Error(`${barcode} is not a barcode number: barcodes have 8, 12, 13 or 14 digits`);
  if (!hasValidCheckDigit(code)) throw new Error(`${barcode} is not a valid barcode (its check digit doesn't match): re-read the number`);
  try {
    const p = await c.request<{ webshopId?: number }>(`/mobile-services/product/search/v1/gtin/${code}`);
    return p?.webshopId || undefined;
  } catch (err) {
    // AH answers any number it doesn't know with 404.
    if (hasStatus(err, 404)) return undefined;
    throw err;
  }
}

/** A product category, e.g. "Groente, aardappelen". */
export interface Category {
  id: number;
  name: string;
  /** Products in it, for subcategories (AH's count, which can include products not sold online). */
  products?: number;
}

/**
 * AH's top-level categories (the aisles of ah.nl). The API has no list of them since the product-shelves
 * endpoints were removed, and the search facets only name a sample of narrower categories.
 */
export const TOP_CATEGORIES: readonly Category[] = [
  { id: 6401, name: "Groente, aardappelen" },
  { id: 20885, name: "Fruit, verse sappen" },
  { id: 1301, name: "Maaltijden, salades" },
  { id: 9344, name: "Vlees" },
  { id: 1651, name: "Vis" },
  { id: 20128, name: "Vegetarisch, vegan en plantaardig" },
  { id: 5481, name: "Vleeswaren" },
  { id: 1192, name: "Kaas" },
  { id: 1730, name: "Zuivel, eieren" },
  { id: 1355, name: "Bakkerij" },
  { id: 4246, name: "Glutenvrij" },
  { id: 20824, name: "Borrel, chips, snacks" },
  { id: 1796, name: "Pasta, rijst, wereldkeuken" },
  { id: 6409, name: "Soepen, sauzen, kruiden, olie" },
  { id: 20129, name: "Koek, snoep, chocolade" },
  { id: 6405, name: "Ontbijtgranen, beleg" },
  { id: 2457, name: "Tussendoortjes" },
  { id: 5881, name: "Diepvries" },
  { id: 1043, name: "Koffie, thee" },
  { id: 20130, name: "Frisdrank, sappen, water" },
  { id: 6406, name: "Bier, wijn, aperitieven" },
  { id: 11717, name: "Gezondheid en sport" },
  { id: 1045, name: "Drogisterij" },
  { id: 18521, name: "Baby en kind" },
  { id: 1165, name: "Huishouden" },
  { id: 18519, name: "Huisdier" },
  { id: 1057, name: "Koken, tafelen, vrije tijd" },
];

const TOP_CATEGORY_IDS = new Set(TOP_CATEGORIES.map((t) => t.id));

/**
 * Subcategories of parentId: the narrower categories its products fall into. AH's categories overlap, so one
 * can show up under several parents. undefined if parentId has no products (not a category id).
 */
export async function getSubcategories(c: AhClient, parentId: number): Promise<Category[] | undefined> {
  const res = await searchPage(c, new URLSearchParams({ query: "", page: "0", size: "1", taxonomyId: String(parentId) }));
  const total = res.page?.totalElements ?? 0;
  if (total === 0) return undefined;
  const options = res.filters?.find((f) => f.id === "taxonomy")?.options ?? [];
  // The facet also names the category itself and every category holding all its products (its ancestors).
  return options
    .map((o) => ({ id: Number(o.id), name: o.label, products: o.count }))
    .filter((o) => Number.isInteger(o.id) && o.id > 0 && o.id !== parentId && !TOP_CATEGORY_IDS.has(o.id) && o.products < total);
}
