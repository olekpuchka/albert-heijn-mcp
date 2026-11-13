import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type AhClient,
  favouriteStore,
  getBargains,
  productUrl,
  searchStores,
  type Store,
} from "../ahapi/index.ts";
import { log } from "../log.ts";
import {
  addAuthedTool,
  cachedMember,
  formatDate,
  nonFatal,
  orDefault,
  structured,
  type ToolContext,
  wrapError,
} from "./common.ts";

const str = z.string().optional();

export function registerStoreTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_search_stores",
      title: "Albert Heijn: Search Stores",
      kind: "readOnly",
      output: {
        stores: z.array(
          z.object({
            id: z.number(),
            name: z.string(),
            favorite: z.boolean().optional(),
            type: str,
            street: str,
            city: str,
            postal_code: str,
          }),
        ),
      },
      description:
        "Find Albert Heijn stores near a Dutch postal code. " +
        "If no postal_code is given, uses the address from the member profile and lists the member's favourite store " +
        "(set in the AH app) first. The favourite store is marked favorite: true. " +
        "Returns store id (use this for ah_get_last_chance_items), name, type, and address.",
      input: {
        postal_code: z
          .string()
          .optional()
          .describe("Dutch postal code, e.g. '1234AB'. Optional — falls back to member address."),
      },
    },
    async (c, { postal_code }) => {
      const favourite = await optionalFavouriteStore(c);
      let postalCode = postal_code;
      if (!postalCode) {
        postalCode = await nonFatal(
          () => memberPostalCode(ctx, c),
          (err) => {
            // The favourite store alone still answers "my stores".
            if (!favourite) throw err;
            log.warn("could not fetch the member address; listing only the favourite store", { err });
            return "";
          },
        );
      }
      if (!postalCode && !favourite) throw new Error("no postal_code provided and member profile has no address on file");
      let stores = postalCode ? await searchStores(c, postalCode) : [];
      // Without a postal code the user means "my stores": their favourite first, then the ones near home.
      if (!postal_code && favourite) stores = [favourite, ...stores.filter((s) => s.id !== favourite.id)];
      return structured(
        {
          stores: stores.map((s) => ({
            id: s.id,
            name: s.name,
            favorite: s.id === favourite?.id || undefined,
            type: s.storeType || undefined,
            street: [s.address?.street, s.address?.houseNumber].filter(Boolean).join(" ") || undefined,
            city: s.address?.city || undefined,
            postal_code: s.address?.postalCode || undefined,
          })),
        },
        stores.length ? undefined : `No AH stores found near ${postalCode}.`,
      );
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_last_chance_items",
      title: "Albert Heijn: Last-Chance Items",
      kind: "readOnly",
      output: {
        store: z.object({ id: z.number(), name: str, favorite: z.boolean().optional() }),
        items: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            url: z.string(),
            brand: str,
            category: str,
            markdown_type: str,
            discount_percentage: z.number().optional(),
            expiration_date: str,
            stock: z.number().optional(),
            price_was: str,
            price_now: str,
          }),
        ),
      },
      description:
        "Get last-chance / vandaag-af / clearance items from an Albert Heijn store. " +
        "Uses store_id if given, else the store nearest postal_code, else the member's favourite store (set in the AH app), " +
        "else the store nearest the member's address. Returns the store it used. " +
        "Uses the dedicated bargainItems GraphQL endpoint which returns today-only markdown deals.",
      input: {
        limit: z.number().int().optional().describe("Maximum number of results to return (default 20)"),
        store_id: z.number().int().optional().describe("AH store ID from ah_search_stores (default: the member's favourite store)"),
        postal_code: z
          .string()
          .optional()
          .describe("Dutch postal code (e.g. '1234AB') to find the nearest store when store_id is not known."),
      },
    },
    async (c, args) => {
      const store = await chooseStore(ctx, c, args.store_id, args.postal_code);
      const bargains = (await getBargains(c, store.id)).slice(0, orDefault(args.limit, 20));
      return structured({
        store,
        items: bargains.map((b) => ({
          id: b.productId,
          title: b.title,
          url: productUrl(b.productId, b.title),
          brand: b.brand || undefined,
          category: b.category || undefined,
          markdown_type: b.markdownType || undefined,
          discount_percentage: b.discount || undefined,
          expiration_date: formatDate(b.expirationDate, false) || undefined,
          stock: b.stock || undefined,
          price_was: b.priceWas || undefined,
          price_now: b.priceNow ?? undefined,
        })),
      });
    },
  );
}

/** The member's postal code, or "" if none is on file. */
async function memberPostalCode(ctx: ToolContext, c: AhClient): Promise<string> {
  try {
    return (await cachedMember(ctx, c)).postalCode;
  } catch (err) {
    throw wrapError("no postal_code provided and could not fetch member address", err);
  }
}

/** The member's favourite store, or undefined if none is set or AH can't say: callers fall back to the address. */
function optionalFavouriteStore(c: AhClient): Promise<Store | undefined> {
  return nonFatal(
    () => favouriteStore(c),
    (err) => {
      log.warn("could not fetch the favourite store; using the member address", { err });
      return undefined;
    },
  );
}

/**
 * The store to use: storeId as given, else the nearest to postalCode, else the member's favourite store,
 * else the nearest to the member's address. Throws, saying why, if there is none.
 */
async function chooseStore(
  ctx: ToolContext,
  c: AhClient,
  storeId: number | undefined,
  postalCode: string | undefined,
): Promise<{ id: number; name?: string; favorite?: boolean }> {
  if (storeId) return { id: storeId };
  if (!postalCode) {
    const favourite = await optionalFavouriteStore(c);
    if (favourite) return { id: favourite.id, name: favourite.name, favorite: true };
  }
  const code = postalCode || (await memberPostalCode(ctx, c));
  if (!code) {
    throw new Error(
      "no store to look in: no favourite store is set in the AH app and the member profile has no address. " +
        'Provide store_id or postal_code, e.g. {"store_id": 1234} or {"postal_code": "1011AB"}',
    );
  }
  const nearest = (await searchStores(c, code))[0];
  if (!nearest) throw new Error(`no AH store found near ${code}; try another postal_code or a store_id from ah_search_stores`);
  return { id: nearest.id, name: nearest.name };
}
