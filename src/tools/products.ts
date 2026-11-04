import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type AhClient,
  getNutrition,
  getProduct,
  getCategories,
  getProductAlternatives,
  hasValidCheckDigit,
  normalizeBarcode,
  productIdByBarcode,
  type Product,
  type SearchOptions,
  type SearchSort,
  searchProducts,
} from "../ahapi/index.ts";
import { addAuthedTool, nonFatal, orDefault, parallel, structured, type ToolContext, withRetry } from "./common.ts";
import { detailProduct, productDetail, productSummary, summarizeProduct } from "./views.ts";

const MAX_QUERIES = 10;
const MAX_PRODUCT_IDS = 20;

/** Search filters → AH property ids. */
const FILTERS = {
  organic: "np_biologisch",
  prijsfavoriet: "np_verbluffen",
  new: "np_nieuw",
  frozen: "diepvries",
  vegan: "sp_include_dieet_veganistisch",
  vegetarian: "sp_include_dieet_vegetarisch",
  low_sugar: "sp_include_dieet_laag_suiker",
  low_fat: "sp_include_dieet_laag_vet",
  low_salt: "sp_include_dieet_laag_zout",
  gluten_free: "sp_include_intolerance_geen_gluten",
  lactose_free: "sp_include_intolerance_geen_lactose",
  milk_free: "sp_include_intolerance_geen_melk",
  egg_free: "sp_include_intolerance_geen_eieren",
  nut_free: "sp_include_intolerance_geen_noten",
  peanut_free: "sp_include_intolerance_geen_pindas",
  soy_free: "sp_include_intolerance_geen_soja",
  fish_free: "sp_include_intolerance_geen_vis",
  shellfish_free: "sp_include_intolerance_geen_schelpdieren",
  sesame_free: "sp_include_intolerance_geen_sesam",
  celery_free: "sp_include_intolerance_geen_selderij",
  mustard_free: "sp_include_intolerance_geen_mosterd",
  lupin_free: "sp_include_intolerance_geen_lupine",
  sulphite_free: "sp_include_intolerance_geen_sulfiet",
} as const;
type Filter = keyof typeof FILTERS;

const SORTS = {
  relevance: "RELEVANCE",
  price_low_high: "PRICELOWHIGH",
  price_high_low: "PRICEHIGHLOW",
  most_bought: "PURCHASE_FREQUENCY",
  nutriscore: "NUTRISCORE",
} as const satisfies Record<string, SearchSort>;
type Sort = keyof typeof SORTS;

export function registerProductTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_search_products",
      title: "Albert Heijn: Search Products",
      kind: "readOnly",
      description:
        "Search Albert Heijn (Dutch supermarket) products by keyword. " +
        "Pass one or more queries (max 10) to search for several products in one call. " +
        "Prefer Dutch search terms for best results: " +
        "e.g. 'melk' (milk), 'kaas' (cheese), 'brood' (bread), 'kip' (chicken), 'appel' (apple). " +
        "Set bonus=true to return only products currently on promotion. " +
        "filters narrows results to products matching all of them, e.g. ['organic', 'gluten_free']: " +
        "organic, prijsfavoriet (AH's budget label), new, frozen, a diet (vegan, vegetarian, low_sugar, low_fat, low_salt), " +
        "or free from an allergen (gluten_free, lactose_free, milk_free, egg_free, nut_free, peanut_free, soy_free, " +
        "fish_free, shellfish_free, sesame_free, celery_free, mustard_free, lupin_free, sulphite_free). " +
        "sort orders results: relevance (default), price_low_high, price_high_low, most_bought (by this user), nutriscore. " +
        "category_id (from ah_get_categories) limits results to one category; with category_id, queries may be left " +
        "out to list the category itself, e.g. the cheapest products in it. " +
        "Returns, per query: id, title, price, bonus_price, unit, is_bonus, bonus_mechanism, image_url.",
      input: {
        queries: z
          .array(z.string())
          .optional()
          .describe('Search queries in Dutch or English, e.g. ["melk"] or ["melk", "kaas", "brood"] (max 10)'),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Maximum results per query (default 10 for one query, 5 for several; max 30)"),
        bonus: z.boolean().optional().describe("Return only products currently on bonus/promotion"),
        filters: z
          .array(z.enum(Object.keys(FILTERS) as [Filter, ...Filter[]]))
          .optional()
          .describe('Only products matching all of these, e.g. ["organic", "vegan"]'),
        sort: z
          .enum(Object.keys(SORTS) as [Sort, ...Sort[]])
          .optional()
          .describe("Result order (default relevance)"),
        category_id: z.number().int().positive().optional().describe("Only products in this category, from ah_get_categories"),
      },
      output: {
        searches: z.array(z.object({ query: z.string(), results: z.array(productSummary), error: z.string().optional() })),
      },
    },
    async (c, { queries, limit, bonus, filters, sort, category_id }) => {
      let qs = (queries ?? []).map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUERIES);
      // A category alone lists the category: one search with no words.
      if (qs.length === 0 && category_id) qs = [""];
      if (qs.length === 0) throw new Error("provide at least one search query, or a category_id");
      const perQuery = Math.min(orDefault(limit, qs.length > 1 ? 5 : 10), 30);

      const results = qs.map((query) => ({
        query,
        results: [] as ReturnType<typeof summarizeProduct>[],
        error: undefined as string | undefined,
      }));
      const opts: SearchOptions = {
        bonus: Boolean(bonus),
        properties: [...new Set(filters ?? [])].map((f) => FILTERS[f]).sort(),
        sort: SORTS[sort ?? "relevance"],
        categoryId: category_id,
      };
      await parallel(qs.length, 3, async (i) => {
        const r = results[i]!;
        await nonFatal(
          async () => {
            r.results = (await search(ctx, c, r.query, perQuery, opts)).map(summarizeProduct);
          },
          (err) => {
            r.error = (err as Error).message;
          },
        );
      });
      return structured({ searches: results });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_products",
      title: "Albert Heijn: Product Details",
      kind: "readOnly",
      description:
        "Get detailed information about one or more Albert Heijn products by ID (max 20). " +
        "Returns title, brand, category, description, price, unit size, bonus info, NutriScore, property icons. " +
        "Set include_nutritional_info=true to also return calories, fat, protein, etc. " +
        "Get product IDs from ah_search_products, or pass barcodes: the EAN number under a product's barcode " +
        "(8, 12, 13 or 14 digits, e.g. read from a photo of the pack). A barcode AH doesn't sell returns an error for it.",
      input: {
        product_ids: z
          .array(z.number().int())
          .max(50)
          .optional()
          .describe("Product IDs from ah_search_products, e.g. [123456] or [123456, 789012]; at most 20 products are fetched per call (max 50 ids)"),
        barcodes: z
          .array(z.string())
          .max(50)
          .optional()
          .describe('Barcode (EAN) numbers, e.g. ["8710400058519"]; counted in the max of 20 products (max 50 barcodes)'),
        include_nutritional_info: z.boolean().optional().describe("Include nutritional values (default false)"),
      },
      output: {
        products: z.array(
          z.union([
            productDetail.extend({ barcode: z.string().optional() }),
            z.object({ id: z.number().optional(), barcode: z.string().optional(), error: z.string() }),
          ]),
        ),
      },
    },
    async (c, { product_ids, barcodes, include_nutritional_info }) => {
      type Result = (z.infer<typeof productDetail> & { barcode?: string }) | { id?: number; barcode?: string; error: string };
      const skipped = `not fetched: at most ${MAX_PRODUCT_IDS} products per call`;

      // 1. Barcodes to product ids, each barcode number once; cached, as a barcode's product never changes.
      // Only the first MAX_PRODUCT_IDS valid barcodes are looked up.
      // First scan of each barcode number, to answer repeats.
      const firstScan = new Map<string, { skip: boolean }>();
      let lookups = 0;
      const scans = (barcodes ?? []).map((barcode) => {
        const code = normalizeBarcode(barcode);
        const repeat = Boolean(code) && firstScan.has(code!);
        // Only barcodes that will reach AH count toward the lookups.
        const skip = Boolean(code) && hasValidCheckDigit(code!) && !repeat && ++lookups > MAX_PRODUCT_IDS;
        const scan = { barcode, code, skip, repeat, id: undefined as number | undefined, error: undefined as string | undefined };
        if (code && !repeat) firstScan.set(code, scan);
        return scan;
      });
      await parallel(scans.length, 5, async (i) => {
        const s = scans[i]!;
        if (s.skip || s.repeat) return;
        await nonFatal(
          async () => {
            // productIdByBarcode rejects a malformed barcode itself.
            const lookup = () => withRetry("ah_get_products", () => productIdByBarcode(c, s.barcode));
            // "Not sold" isn't kept: AH may list the product later.
            const code = s.code;
            s.id = code ? ctx.barcodes.get(code) : undefined;
            if (s.id === undefined) {
              s.id = await lookup();
              if (code && s.id !== undefined) ctx.barcodes.set(code, s.id);
            }
            if (!s.id) s.error = `Albert Heijn sells no product with barcode ${s.barcode}`;
          },
          (err) => {
            s.error = (err as Error).message;
          },
        );
      });

      // 2. One entry per product, barcodes first: a product_id a barcode already found is not fetched again.
      const results: Result[] = [];
      const wanted: { id: number; barcode?: string; at: number }[] = [];
      const seenIds = new Set<number>();
      const skippedIds = new Set<number>();
      const add = (id: number, barcode?: string) => {
        if (seenIds.has(id)) {
          // A repeat gets its own entry, so every barcode and id asked for is answered.
          results.push({ id, barcode, error: skippedIds.has(id) ? skipped : "same product as an earlier entry; see that entry" });
          return;
        }
        seenIds.add(id);
        if (wanted.length >= MAX_PRODUCT_IDS) {
          skippedIds.add(id);
          results.push({ id, barcode, error: skipped });
          return;
        }
        wanted.push({ id, barcode, at: results.length });
        results.push({ id, barcode, error: "" });
      };
      for (const s of scans) {
        if (s.repeat) {
          results.push({ barcode: s.barcode, error: firstScan.get(s.code!)!.skip ? skipped : "same barcode as an earlier entry; see that entry" });
        }
        else if (s.skip) results.push({ barcode: s.barcode, error: skipped });
        else if (s.id) add(s.id, s.barcode);
        else results.push({ barcode: s.barcode, error: s.error! });
      }
      for (const id of product_ids ?? []) if (id > 0) add(id);
      if (results.length === 0) throw new Error("provide at least one product ID or barcode");

      // 3. Product details.
      await parallel(wanted.length, 5, async (i) => {
        const { id, barcode, at } = wanted[i]!;
        const key = String(id);
        results[at] = await nonFatal<Result>(
          async () => {
            const p = await ctx.products.getOrLoad(key, () => withRetry("ah_get_products", () => getProduct(c, id)));
            const nutrition = include_nutritional_info
              ? await ctx.nutrition.getOrLoad(key, () => withRetry("ah_get_products", () => getNutrition(c, id)))
              : undefined;
            return { ...detailProduct(p, nutrition), barcode };
          },
          (err) => ({ id, barcode, error: (err as Error).message }),
        );
      });
      return structured({ products: results });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_product_alternatives",
      title: "Albert Heijn: Product Alternatives",
      kind: "readOnly",
      description:
        "Get products Albert Heijn suggests instead of a given product: similar products and substitutes, " +
        "e.g. when it is sold out or to find a cheaper or organic option. " +
        "Returns the same fields as ah_search_products.",
      input: {
        product_id: z.number().int().describe("Product ID, e.g. from ah_search_products or ah_get_shopping_list"),
        limit: z.number().int().optional().describe("Maximum number of alternatives (default 10, max 30)"),
      },
      output: { products: z.array(productSummary) },
    },
    async (c, args) => {
      if (args.product_id <= 0) throw new Error("product_id is required");
      const size = Math.min(orDefault(args.limit, 10), 30);
      const alternatives = await ctx.searches.getOrLoad(`alternatives:${args.product_id}:${size}`, () =>
        withRetry("ah_get_product_alternatives", () => getProductAlternatives(c, args.product_id, size)),
      );
      const message = alternatives.length ? undefined : `AH suggests no alternatives for product ${args.product_id}.`;
      return structured({ products: alternatives.map(summarizeProduct) }, message);
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_categories",
      title: "Albert Heijn: Product Categories",
      kind: "readOnly",
      description:
        "List Albert Heijn's product categories (the aisles of ah.nl), e.g. 'Groente, aardappelen' or 'Kaas'. " +
        "Without parent_id returns the top-level categories; with a parent_id, its subcategories. " +
        "Pass a category id as category_id to ah_search_products to search or list products in it.",
      input: {
        parent_id: z.number().int().positive().optional().describe("Category id whose subcategories to list"),
      },
      output: { categories: z.array(z.object({ id: z.number(), name: z.string() })) },
    },
    async (c, { parent_id }) => {
      const categories = await ctx.categories.getOrLoad(
        String(parent_id ?? ""),
        () => withRetry("ah_get_categories", () => getCategories(c, parent_id)),
        // Not kept when empty: at the top level that's likely a hiccup at AH, and for a parent_id AH answers a
        // leaf and a wrong id alike.
        (list) => list.length > 0,
      );
      let message: string | undefined;
      if (!categories.length) {
        message = parent_id
          ? `Category ${parent_id} has no subcategories (or is not a category id).`
          : "AH returned no product categories.";
      }
      return structured({ categories }, message);
    },
  );
}

/** Cached, retried product search. */
export function search(ctx: ToolContext, c: AhClient, query: string, limit: number, opts: SearchOptions): Promise<Product[]> {
  // most_bought orders by this account's purchases, so it is cached per login.
  const account = opts.sort === "PURCHASE_FREQUENCY" ? c.token : undefined;
  return ctx.searches.getOrLoad(JSON.stringify([query, limit, opts, account]), () =>
    withRetry("ah_search_products", () => searchProducts(c, query, limit, opts)),
  );
}
