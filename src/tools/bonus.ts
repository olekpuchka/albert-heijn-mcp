import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  activatePersonalOffer,
  type AhClient,
  bonusGroupUrl,
  type BonusOffer,
  type BonusPeriod,
  getBonusBox,
  getBonusGroupProducts,
  getBonusPeriods,
  getBonusSection,
  getPreviouslyBoughtBonus,
  isUnauthorized,
  type PersonalOffer,
  productUrl,
} from "../ahapi/index.ts";
import { log } from "../log.ts";
import { addAuthedTool, nonFatal, orDefault, parallel, structured, type ToolContext, withRetry, wrapError } from "./common.ts";
import { productSummary, summarizeProduct } from "./views.ts";

const period = z.enum(["current", "next"]).optional();

const offerView = z.object({
  id: z.number().optional(),
  bonus_segment_id: z.string().optional(),
  title: z.string(),
  url: z.string().optional(),
  original_price: z.number().optional(),
  bonus_price: z.number().optional(),
  discount_percentage: z.number().optional(),
  bonus_mechanism: z.string().optional(),
});

export function registerBonusTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_bonus_offers",
      title: "Albert Heijn: Bonus Offers",
      kind: "readOnly",
      description:
        "Get Albert Heijn bonus/promotional offers. " +
        "Use this (not ah_search_products) when the user asks what is on bonus/sale/discount. " +
        "Returns this week's bonus by default; set period='next' for next week's bonus, " +
        "which AH publishes a few days before the new bonus week starts. " +
        "Supports optional keyword filter to find e.g. cheese on bonus: set query='kaas'. " +
        "Set previously_bought=true for offers on products the user bought before (AH's 'Eerder gekocht'). " +
        "Group deals (e.g. '2+1 gratis', 'Alle yoghurt 25% korting') have no id but a bonus_segment_id — " +
        "pass that to ah_get_bonus_group_products to see the individual products in the group. " +
        "Returns id, bonus_segment_id, title, original_price, bonus_price, discount_percentage, bonus_mechanism.",
      input: {
        limit: z.number().int().optional().describe("Maximum number of results to return (default 20)"),
        query: z
          .string()
          .optional()
          .describe("Optional keyword filter (Dutch or English) applied client-side, e.g. 'kaas', 'vlees', 'bier'"),
        period: period.describe("Which bonus week to return: 'current' (default) or 'next'"),
        previously_bought: z
          .boolean()
          .optional()
          .describe("Only offers on products the user bought before"),
      },
      output: { offers: z.array(offerView) },
    },
    async (c, args) => {
      const p = await bonusPeriod(ctx, c, args.period);
      if (typeof p === "string") return structured({ offers: [] }, p);
      const limit = orDefault(args.limit, 20);
      const query = (args.query ?? "").toLowerCase();

      const offers: z.infer<typeof offerView>[] = [];
      const add = (o: { id?: number; segment?: string; title: string; was?: number; now?: number; mechanism?: string | null }) => {
        if (offers.length >= limit || (query && !o.title.toLowerCase().includes(query))) return;
        offers.push({
          id: o.id || undefined,
          bonus_segment_id: o.segment || undefined,
          title: o.title,
          url: o.id ? productUrl(o.id, o.title) : o.segment ? bonusGroupUrl(o.segment) : undefined,
          original_price: o.was || undefined,
          // Absent for deals like "2 voor 1.19"; bonus_mechanism describes those.
          bonus_price: o.now || undefined,
          discount_percentage: discountPercentage(o.was, o.now),
          bonus_mechanism: o.mechanism || undefined,
        });
      };
      const all = args.previously_bought ? await getPreviouslyBoughtBonus(c, p.start) : await bonusOffers(ctx, c, p);
      for (const bo of all) {
        const products = bo.product ? [bo.product] : (bo.group?.products ?? []);
        for (const pr of products) {
          add({ id: pr.webshopId, title: pr.title, was: pr.priceBeforeBonus, now: pr.currentPrice, mechanism: pr.bonusMechanism });
        }
        if (bo.group && !bo.group.products?.length) {
          const g = bo.group;
          add({ segment: g.id, title: g.segmentDescription, was: g.exampleFromPrice, now: g.exampleForPrice, mechanism: g.discountDescription });
        }
      }
      return structured({ offers });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_bonus_group_products",
      title: "Albert Heijn: Bonus Group Products",
      kind: "readOnly",
      description:
        "Get all individual products belonging to a specific Albert Heijn bonus promotion group. " +
        "Use this to drill into a deal like '2+1 gratis kaas' or 'Alle yoghurt 25% korting'. " +
        "Get segment_id from the bonus_segment_id field in ah_get_bonus_offers results. " +
        "For an offer from next week's bonus, set period='next'. " +
        "Returns the same fields as ah_search_products.",
      input: {
        segment_id: z.string().describe("Bonus segment ID from the bonus_segment_id field in ah_get_bonus_offers"),
        period: period.describe("Bonus week of the offer: 'current' (default) or 'next'"),
      },
      output: { products: z.array(productSummary) },
    },
    async (c, args) => {
      if (!args.segment_id) throw new Error("segment_id is required");
      const p = await bonusPeriod(ctx, c, args.period);
      if (typeof p === "string") return structured({ products: [] }, p);
      return structured({ products: (await getBonusGroupProducts(c, args.segment_id, p)).map(summarizeProduct) });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_personal_offers",
      title: "Albert Heijn: Personal Offers",
      kind: "readOnly",
      description:
        "Get the user's personal Albert Heijn offers (the Bonus Box, 'persoonlijke bonus'): " +
        "deals picked for this member that only apply after they are activated. " +
        "Returns max_activations (how many offers the member may activate this week), activated_count, " +
        "and per offer: id, title, status ('activated' or 'available'), original_price, bonus_price, " +
        "discount_percentage, unit, and product_id when the offer covers one product. " +
        "For an offer on several products, pass its id as segment_id to ah_get_bonus_group_products to list them. " +
        "Activate offers with ah_activate_personal_offer. Set period='next' for next week's offers once AH publishes them.",
      input: { period: period.describe("Which bonus week: 'current' (default) or 'next'") },
      output: {
        max_activations: z.number().optional(),
        activated_count: z.number(),
        offers: z.array(personalOfferView),
      },
    },
    async (c, args) => {
      const p = await bonusPeriod(ctx, c, args.period);
      if (typeof p === "string") return structured({ activated_count: 0, offers: [] }, p);
      const box = await getBonusBox(c, p);
      return structured(
        {
          max_activations: box.maxActivations,
          activated_count: box.offers.filter((o) => o.activated).length,
          offers: box.offers.map(viewPersonalOffer),
        },
        box.offers.length ? undefined : `The user has no personal offers for ${p.start} to ${p.end}.`,
      );
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_activate_personal_offer",
      title: "Albert Heijn: Activate Personal Offer",
      // Not additive: an activation uses up the weekly limit and can't be undone, so clients should confirm it.
      kind: "destructive",
      description:
        "Activate one or more of the user's personal Albert Heijn offers (Bonus Box) so the discount applies " +
        "in the store and online. Get offer ids from ah_get_personal_offers. " +
        "AH allows only a limited number of activations per week (max_activations) and an activation " +
        "cannot be undone, so only activate the offers the user chose. Offers that are already active are skipped.",
      input: {
        offer_ids: z
          .array(z.string())
          .max(MAX_ACTIVATIONS)
          .describe('Offer ids from ah_get_personal_offers, e.g. ["575604"]'),
        period: period.describe("Bonus week of the offers: 'current' (default) or 'next'"),
      },
      output: {
        activated: z.array(z.object({ id: z.string(), title: z.string() })),
        already_active: z.array(z.object({ id: z.string(), title: z.string() })),
        failed: z.array(z.object({ id: z.string(), title: z.string().optional(), error: z.string() })),
        activated_count: z.number(),
        max_activations: z.number().optional(),
      },
    },
    async (c, args) => {
      const ids = [...new Set(args.offer_ids.map((id) => id.trim()).filter(Boolean))];
      if (ids.length === 0) throw new Error("provide at least one offer id from ah_get_personal_offers");
      const p = await bonusPeriod(ctx, c, args.period);
      if (typeof p === "string") throw new Error(p);
      const box = await getBonusBox(c, p);
      const byId = new Map(box.offers.map((o) => [o.id, o]));
      const unknown = ids.filter((id) => !byId.has(id));
      if (unknown.length) {
        throw new Error(
          `not a personal offer for ${p.start} to ${p.end}: ${unknown.join(", ")}; get offer ids from ah_get_personal_offers`,
        );
      }
      const wanted = ids.map((id) => byId.get(id)!);
      const todo = wanted.filter((o) => !o.activated);
      let activatedCount = box.offers.filter((o) => o.activated).length;
      if (box.maxActivations !== undefined && activatedCount + todo.length > box.maxActivations) {
        throw new Error(
          `the user has activated ${activatedCount} of ${box.maxActivations} personal offers this week, ` +
            `so ${Math.max(box.maxActivations - activatedCount, 0)} more can be activated, not ${todo.length}`,
        );
      }

      const activated: { id: string; title: string }[] = [];
      const failed: { id: string; title?: string; error: string }[] = [];
      // One at a time: AH counts activations against the weekly limit. Errors are caught here, not thrown,
      // so the offers already activated (which can't be undone) are always reported.
      let stopped: string | undefined;
      for (const o of todo) {
        if (stopped) {
          failed.push({ id: o.id, title: o.title, error: `not attempted: ${stopped}` });
          continue;
        }
        try {
          // withRetry retries only a 429, which AH answers without activating.
          await withRetry("ah_activate_personal_offer", () => activatePersonalOffer(c, o));
          activated.push({ id: o.id, title: o.title });
          activatedCount++;
        } catch (err) {
          const message = (err as Error).message;
          failed.push({ id: o.id, title: o.title, error: message });
          if (isUnauthorized(err)) stopped = "the Albert Heijn login expired; log in again (ah_login) and retry these";
        }
      }
      return structured({
        activated,
        already_active: wanted.filter((o) => o.activated).map((o) => ({ id: o.id, title: o.title })),
        failed,
        activated_count: activatedCount,
        max_activations: box.maxActivations,
      });
    },
  );
}

/** More than AH has ever allowed per week; AH's own limit is checked per call. */
const MAX_ACTIVATIONS = 20;

const personalOfferView = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["activated", "available"]),
  category: z.string().optional(),
  product_id: z.number().optional(),
  product_count: z.number().optional(),
  unit: z.string().optional(),
  original_price: z.number().optional(),
  bonus_price: z.number().optional(),
  discount_percentage: z.number().optional(),
  store_only: z.boolean().optional(),
});

/** Whole percent off, or undefined without both prices or a discount. */
function discountPercentage(was: number | undefined, now: number | undefined): number | undefined {
  return (was && now && Math.round((1 - now / was) * 100)) || undefined;
}

function viewPersonalOffer(o: PersonalOffer): z.infer<typeof personalOfferView> {
  return {
    id: o.id,
    title: o.title,
    url: o.product ? productUrl(o.product.id, o.product.title) : bonusGroupUrl(o.id),
    status: o.activated ? "activated" : "available",
    category: o.category,
    product_id: o.product?.id,
    product_count: o.productCount,
    unit: o.salesUnitSize,
    original_price: o.priceWas || undefined,
    bonus_price: o.priceNow || undefined,
    discount_percentage: discountPercentage(o.priceWas, o.priceNow),
    store_only: o.storeOnly || undefined,
  };
}

/** The requested period, or a message if next week's bonus is not published yet. */
async function bonusPeriod(
  ctx: ToolContext,
  c: AhClient,
  name: "current" | "next" | undefined,
): Promise<BonusPeriod | string> {
  const periods = await ctx.bonusPeriods.getOrLoad("", () => getBonusPeriods(c));
  const current = periods[0];
  if (!current?.start) throw new Error("AH returned no current bonus period");
  if (name !== "next") return current;
  if (periods[1]?.start) return periods[1];
  const when = current.nextVisibleFrom
    ? `It becomes visible on ${current.nextVisibleFrom}.`
    : "It usually appears a few days before the new bonus week starts.";
  return `Next week's bonus has not been published by Albert Heijn yet. ${when} This week's bonus runs until ${current.end}.`;
}

/** All national offers of a period, cached. Failed categories are skipped; partial results aren't cached. */
async function bonusOffers(ctx: ToolContext, c: AhClient, p: BonusPeriod): Promise<BonusOffer[]> {
  const cached = ctx.bonuses.get(p.start);
  if (cached) return cached;

  const sections: (BonusOffer[] | undefined)[] = new Array(p.categories.length);
  const errors: unknown[] = [];
  await parallel(p.categories.length, 4, async (i) => {
    const category = p.categories[i]!;
    sections[i] = await nonFatal(
      () => withRetry("ah_get_bonus_offers", () => getBonusSection(c, category, p.start)),
      (err) => {
        errors.push(err);
        log.warn("skipping bonus category", { category, err });
        return undefined;
      },
    );
  });
  if (p.categories.length > 0 && errors.length === p.categories.length) {
    throw wrapError("failed to get bonus offers", errors[0]);
  }

  const seen = new Set<string>();
  const offers: BonusOffer[] = [];
  for (const o of sections.flat()) {
    if (!o) continue;
    const key = o.product ? `p${o.product.webshopId}` : o.group ? `g${o.group.id}` : "";
    if (key && !seen.has(key)) {
      seen.add(key);
      offers.push(o);
    }
  }
  if (errors.length === 0) ctx.bonuses.set(p.start, offers);
  return offers;
}
