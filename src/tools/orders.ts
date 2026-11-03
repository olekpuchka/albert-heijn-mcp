import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type AhClient,
  convertPosIds,
  getFulfillments,
  getOrderDetails,
  getReceiptLines,
  getReceiptsWhile,
  type Order,
  POS_IDS_BATCH,
  PRODUCT_IDS_BATCH,
  type ReceiptLine,
  productsByIds,
  productUrl,
  RECEIPT_LINES_BATCH,
} from "../ahapi/index.ts";
import { log } from "../log.ts";
import { addAuthedTool, formatDate, nonFatal, orDefault, parallel, structured, type ToolContext, withRetry } from "./common.ts";
import { orderView, viewOrder } from "./views.ts";

/** Status of a cancelled order; AH reports statuses in Dutch ("Geannuleerd"). */
const CANCELLED = /geannuleerd|cancel/i;

/** Receipts ah_get_frequent_items reads at most: a year of shopping a few times a week. */
const MAX_RECEIPTS = 400;

export function registerOrderTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_orders",
      title: "Albert Heijn: Orders",
      kind: "readOnly",
      output: {
        orders: z.array(
          z.object({
            id: z.number(),
            date: z.string().optional(),
            time_window: z.string().optional(),
            total_price: z.number().optional(),
            status: z.string().optional(),
            shopping_type: z.string().optional(),
            modifiable: z.boolean().optional(),
          }),
        ),
      },
      description:
        "List Albert Heijn online delivery orders. " +
        "By default returns upcoming orders (with a modifiable flag); set past=true for delivered orders. " +
        "Returns id, date, time_window, total_price, status. " +
        "Use the returned id with ah_get_order_details to see the items.",
      input: {
        past: z.boolean().optional().describe("Return delivered orders instead of upcoming ones"),
        limit: z.number().int().optional().describe("Maximum number of orders to return (default 10)"),
      },
    },
    async (c, { past, limit }) => {
      const fulfillments = await getFulfillments(c, Boolean(past));
      const empty = past ? "No past orders found." : "No upcoming orders.";
      return structured(
        {
          orders: fulfillments.slice(0, orDefault(limit, 10)).map((f) => ({
            id: f.orderId,
            date: f.dateDisplay || f.date || undefined,
            time_window: f.timeDisplay || undefined,
            total_price: f.totalPrice ?? undefined,
            status: f.status,
            shopping_type: f.shoppingType || undefined,
            modifiable: past ? undefined : f.modifiable,
          })),
        },
        fulfillments.length ? undefined : empty,
      );
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_order_details",
      title: "Albert Heijn: Order Details",
      kind: "readOnly",
      output: orderView.shape,
      description:
        "Get the full item list for a specific Albert Heijn delivery order by its ID. " +
        "Returns all products with names, quantities, and prices. " +
        "Get order_id from ah_get_orders.",
      input: { order_id: z.number().int().describe("Numeric order ID from ah_get_orders") },
    },
    async (c, { order_id }) => {
      if (order_id <= 0) throw new Error("order_id is required");
      return structured(viewOrder(await getOrderDetails(c, order_id)));
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_frequent_items",
      title: "Albert Heijn: Frequently Bought Items",
      kind: "readOnly",
      output: {
        from_date: z.string(),
        online_orders: z.number(),
        store_receipts: z.number(),
        products: z.array(
          z.object({
            product_name: z.string(),
            product_id: z.number().optional(),
            purchase_count: z.number(),
            online_count: z.number(),
            in_store_count: z.number(),
            last_purchased_date: z.string(),
            url: z.string().optional(),
          }),
        ),
        warnings: z.array(z.string()).optional(),
      },
      description:
        "Get the products the user buys most often, counted over their Albert Heijn delivery orders and " +
        "in-store receipts (kassabonnen) of the last few months. " +
        "purchase_count is the number of orders and store visits that included the product, " +
        "split into online_count and in_store_count. " +
        "Use it to suggest a shopping list or spot staples that are on bonus. " +
        "Returns product_name, product_id, the counts and last_purchased_date, most bought first.",
      input: {
        months: z.number().int().optional().describe("How many months back to count (default 3, max 12)"),
        min_purchase_count: z
          .number()
          .int()
          .optional()
          .describe("Only products bought at least this many times (default 3)"),
        min_order_count: z.number().int().optional().describe("Old name of min_purchase_count"),
        source: z
          .enum(["all", "online", "in_store"])
          .optional()
          .describe("Count delivery orders, store receipts, or both (default all)"),
        limit: z.number().int().optional().describe("Maximum number of products (default 50, max 200)"),
      },
    },
    async (c, args) => {
      const months = Math.min(orDefault(args.months, 3), 12);
      const minCount = orDefault(args.min_purchase_count ?? args.min_order_count, 3);
      const limit = Math.min(orDefault(args.limit, 50), 200);
      const source = args.source ?? "all";
      // Both sources start at the same Dutch calendar day.
      const fromDate = monthsAgo(months);

      const warnings: string[] = [];
      let failedSources = 0;
      const failed = (what: string) => (err: unknown) => {
        log.warn(`could not fetch ${what}`, { tool: "ah_get_frequent_items", err });
        warnings.push(`could not fetch ${what}: ${(err as Error).message}`);
        failedSources++;
        return [];
      };
      const [online, inStore] = await Promise.all([
        source === "in_store" ? [] : nonFatal(() => onlineTrips(c, fromDate, warnings), failed("delivery orders")),
        source === "online" ? [] : nonFatal(() => storeTrips(c, fromDate, warnings), failed("store receipts")),
      ]);
      if (failedSources === (source === "all" ? 2 : 1)) throw new Error(warnings.join("; "));

      const stats = new Map<string, Stat>();
      // Online trips first: a product bought online keeps its full order title. Receipt lines are
      // abbreviated ("AH BLAD RUCO"); nameProducts replaces those.
      for (const trip of [...online, ...inStore]) {
        for (const [key, p] of trip.products) {
          let s = stats.get(key);
          if (!s) {
            s = { name: p.name, productId: p.productId, online: 0, inStore: 0, last: "" };
            stats.set(key, s);
          }
          if (trip.online) s.online++;
          else s.inStore++;
          if (trip.date > s.last) s.last = trip.date;
        }
      }
      const top = [...stats.values()]
        .filter((s) => s.online + s.inStore >= minCount)
        .sort((a, b) => b.online + b.inStore - (a.online + a.inStore) || b.last.localeCompare(a.last))
        .slice(0, limit);
      await nameProducts(c, top);

      return structured(
        {
          from_date: fromDate,
          online_orders: online.length,
          store_receipts: inStore.length,
          products: top.map((s) => ({
            product_name: s.name,
            product_id: s.productId,
            purchase_count: s.online + s.inStore,
            online_count: s.online,
            in_store_count: s.inStore,
            last_purchased_date: s.last,
            url: s.productId ? productUrl(s.productId, s.name) : undefined,
          })),
          warnings: warnings.length ? warnings : undefined,
        },
        top.length || warnings.length
          ? undefined
          : `No product was bought ${minCount} or more times since ${fromDate} ` +
              `(${online.length} delivery orders, ${inStore.length} store receipts).`,
      );
    },
  );
}

interface Stat {
  name: string;
  productId?: number;
  online: number;
  inStore: number;
  /** YYYY-MM-DD */
  last: string;
}

interface TripProduct {
  name: string;
  productId?: number;
}

/** An order or store visit: the products in it, each once, keyed by product. */
interface Trip {
  online: boolean;
  /** YYYY-MM-DD */
  date: string;
  products: Map<string, TripProduct>;
}

/** Delivered orders since fromDate; upcoming orders are not purchases yet. Adds to warnings. */
async function onlineTrips(c: AhClient, fromDate: string, warnings: string[]): Promise<Trip[]> {
  const past = await getFulfillments(c, true);
  const refs = past.filter((f) => !CANCELLED.test(f.status) && f.date && f.date >= fromDate);
  const orders: (Order | undefined)[] = new Array(refs.length);
  await parallel(refs.length, 5, async (i) => {
    const id = refs[i]!.orderId;
    orders[i] = await nonFatal(
      () => withRetry("ah_get_frequent_items", () => getOrderDetails(c, id)),
      (err) => {
        log.warn("could not fetch order", { tool: "ah_get_frequent_items", order_id: id, err });
        return undefined;
      },
    );
  });
  const failedOrders = orders.filter((o) => !o).length;
  if (failedOrders) warnings.push(`could not read ${failedOrders} of ${refs.length} delivery orders`);
  return orders.flatMap((order, i) => {
    if (!order || order.items.length === 0) return [];
    const products = new Map<string, TripProduct>();
    for (const it of order.items) {
      const key = `w${it.productId}`;
      if (!products.has(key)) products.set(key, { name: it.title || String(it.productId), productId: it.productId });
    }
    return [{ online: true, date: refs[i]!.date!, products }];
  });
}

/** Store visits from fromDate (YYYY-MM-DD, Dutch time), with receipt lines mapped to webshop products where AH can. Adds to warnings. */
async function storeTrips(c: AhClient, fromDate: string, warnings: string[]): Promise<Trip[]> {
  // One more than counted, to tell a full window from a cut-off one.
  const receipts = await getReceiptsWhile(c, (r) => formatDate(r.dateTime, false) >= fromDate, MAX_RECEIPTS + 1);
  if (receipts.length > MAX_RECEIPTS) {
    receipts.length = MAX_RECEIPTS;
    warnings.push(
      `counted only the latest ${MAX_RECEIPTS} store receipts, back to ${formatDate(receipts.at(-1)!.dateTime, false)}`,
    );
  }

  // A receipt or batch that fails leaves only those receipts out, not the whole in-store count.
  const lineBatches = await inBatches<string, (ReceiptLine[] | undefined)[]>(
    receipts.map((r) => r.id),
    RECEIPT_LINES_BATCH,
    (ids) => getReceiptLines(c, ids),
    (ids, err) => {
      log.warn("could not fetch receipt details", { tool: "ah_get_frequent_items", err });
      return ids.map(() => undefined);
    },
  );
  const lines = lineBatches.flat();
  const failedReceipts = lines.filter((l) => !l).length;
  if (failedReceipts) warnings.push(`could not read ${failedReceipts} of ${receipts.length} store receipts`);

  // An id whose batch fails stays unmapped and is counted under its receipt name.
  const posIds = [...new Set(lines.flat().flatMap((l) => (l?.posId ? [l.posId] : [])))];
  const mapped = await inBatches(
    posIds,
    POS_IDS_BATCH,
    (ids) => convertPosIds(c, ids),
    (_, err) => {
      log.warn("could not map receipt products", { tool: "ah_get_frequent_items", err });
      return new Map<number, number>();
    },
  );
  const webshopIds = new Map(mapped.flatMap((m) => [...m]));

  return receipts.flatMap((r, i) => {
    const receiptLines = lines[i];
    if (!receiptLines) return [];
    const products = new Map<string, TripProduct>();
    // Lines without a till id are not products (bags, deposits).
    for (const l of receiptLines) {
      if (!l.posId) continue;
      const productId = webshopIds.get(l.posId);
      const key = productId ? `w${productId}` : `p${l.posId}`;
      if (!products.has(key)) products.set(key, { name: l.name, productId });
    }
    return [{ online: false, date: formatDate(r.dateTime, false), products }];
  });
}

/** fn on items in batches of size, 4 batches at a time; a batch that fails gives onError's result instead. */
async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (batch: T[]) => Promise<R>,
  onError: (batch: T[], err: unknown) => R,
): Promise<R[]> {
  const batches = chunks(items, size);
  const out: R[] = new Array(batches.length);
  await parallel(batches.length, 4, async (b) => {
    const batch = batches[b]!;
    out[b] = await nonFatal(
      () => withRetry("ah_get_frequent_items", () => fn(batch)),
      (err) => onError(batch, err),
    );
  });
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The Dutch calendar day months months before today, as YYYY-MM-DD; at a month end, the last day of
 * the shorter month (May 31 → Feb 28). Dutch time, whatever the server's time zone.
 */
function monthsAgo(months: number, now = new Date()): string {
  const [year, month, day] = formatDate(now.toISOString(), false).split("-").map(Number) as [number, number, number];
  const start = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  return `${start.toISOString().slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/** Replaces the receipt abbreviations of products never bought online with product titles; keeps them if the lookup fails. */
async function nameProducts(c: AhClient, stats: Stat[]): Promise<void> {
  const unnamed = stats.filter((s) => s.online === 0 && s.productId);
  const found = await inBatches(
    unnamed.map((s) => s.productId!),
    PRODUCT_IDS_BATCH,
    (ids) => productsByIds(c, ids),
    (_, err) => {
      log.warn("could not fetch product names", { tool: "ah_get_frequent_items", err });
      return [];
    },
  );
  const titles = new Map(found.flat().map((p) => [p.webshopId, p.title]));
  for (const s of unnamed) s.name = titles.get(s.productId!) ?? s.name;
}
