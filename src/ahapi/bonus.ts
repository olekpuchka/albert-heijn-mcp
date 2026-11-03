import { type AhClient, checkMutation } from "./client.ts";
import { fromGraphqlProduct, GRAPHQL_PRODUCT_FIELDS, type GraphqlProduct, type Product } from "./products.ts";

/** Weekly bonus period. Index 0 is this week; next week appears a few days before it starts. */
export interface BonusPeriod {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  /** When the following week's bonus becomes visible (YYYY-MM-DD). */
  nextVisibleFrom?: string;
  /** National categories, for getBonusSection. */
  categories: string[];
}

/** Published bonus periods, current week first. */
export async function getBonusPeriods(c: AhClient): Promise<BonusPeriod[]> {
  const res = await c.request<{
    periods?: {
      bonusStartDate: string;
      bonusEndDate: string;
      nextPeriodVisibleFrom?: string;
      tabs?: { urlMetadataList?: { bonusType: string; description: string }[] }[];
    }[];
  }>("/mobile-services/bonuspage/v3/metadata");
  return (res.periods ?? []).map((p) => {
    const categories = new Set<string>();
    for (const tab of p.tabs ?? []) {
      for (const m of tab.urlMetadataList ?? []) {
        if (m.bonusType === "NATIONAL" && m.description) categories.add(m.description);
      }
    }
    return {
      start: p.bonusStartDate,
      end: p.bonusEndDate,
      nextVisibleFrom: p.nextPeriodVisibleFrom,
      categories: [...categories],
    };
  });
}

/** The ah.nl page of a group deal, listing its products. */
export function bonusGroupUrl(segmentId: string): string {
  return `https://www.ah.nl/bonus/groep/${segmentId}`;
}

/** Group deal, e.g. "2+1 gratis". */
export interface BonusGroup {
  /** For getBonusGroupProducts. */
  id: string;
  segmentDescription: string;
  discountDescription?: string;
  category?: string;
  exampleFromPrice?: number;
  exampleForPrice?: number;
  products?: Product[];
}

/** Bonus page entry: a product or a group deal. */
export interface BonusOffer {
  product?: Product;
  group?: BonusGroup;
}

async function fetchSection(c: AhClient, path: string, params: Record<string, string>): Promise<BonusOffer[]> {
  const query = new URLSearchParams({ application: "AHWEBSHOP", ...params });
  const res = await c.request<{ bonusGroupOrProducts?: { product?: Product; bonusGroup?: BonusGroup }[] }>(
    `/mobile-services/bonuspage/v2/${path}?${query}`,
  );
  return (res.bonusGroupOrProducts ?? []).map((it) => ({ product: it.product, group: it.bonusGroup }));
}

/** National offers of a category; date picks the bonus period. */
export function getBonusSection(c: AhClient, category: string, date: string): Promise<BonusOffer[]> {
  return fetchSection(c, "section", { date, promotionType: "NATIONAL", category });
}

/** Offers on products the member bought before (AH's "Eerder gekocht"); date picks the bonus period. */
export function getPreviouslyBoughtBonus(c: AhClient, date: string): Promise<BonusOffer[]> {
  return fetchSection(c, "section/previously-bought", { date });
}

/** Products of a group deal. */
export async function getBonusGroupProducts(c: AhClient, groupId: string, period: BonusPeriod): Promise<Product[]> {
  const query = `query BonusGroupProducts($id: String, $start: String, $end: String) {
  bonusPromotions(input: {id: $id, periodStart: $start, periodEnd: $end}) {
    products { ${GRAPHQL_PRODUCT_FIELDS} }
  }
}`;
  const data = await c.graphql<{ bonusPromotions: { products: GraphqlProduct[] }[] }>(query, {
    id: groupId,
    start: period.start,
    end: period.end,
  });
  // Every product in a bonus group is on bonus, even when the price doesn't show it (e.g. "2+1 gratis").
  return data.bonusPromotions.flatMap((promo) => promo.products.map((p) => ({ ...fromGraphqlProduct(p), isBonus: true })));
}

/** Offer in the member's Bonus Box: a personal deal that applies only once activated. */
export interface PersonalOffer {
  /** Bonus segment id, for getBonusGroupProducts. */
  id: string;
  /** Id the activation takes; AH rejects the segment id there. */
  hqId: number;
  title: string;
  category?: string;
  activated: boolean;
  /** The product, if the offer covers exactly one. */
  product?: { id: number; title: string };
  productCount?: number;
  salesUnitSize?: string;
  priceWas?: number;
  priceNow?: number;
  storeOnly: boolean;
  periodStart: string;
  periodEnd: string;
}

export interface BonusBox {
  /** How many offers the member may activate in the period. */
  maxActivations?: number;
  offers: PersonalOffer[];
}

/** The member's personal offers of a bonus period, activated or still to activate. */
export async function getBonusBox(c: AhClient, period: BonusPeriod): Promise<BonusBox> {
  const query = `query BonusBox($start: String, $end: String) {
  bonusPersonalPromotionBundles(validOn: $start) { maximumActivations }
  bonusPromotions(filterSet: APP_BONUS_BOX, input: {periodStart: $start, periodEnd: $end, forcePromotionVisibility: true, states: [ACTIVATABLE, ACTIVATED]}) {
    id hqId title category activationStatus productCount salesUnitSize storeOnly periodStart periodEnd
    price { now { amount } was { amount } }
    product { id title }
  }
}`;
  type Money = { amount: number } | null;
  // The bundle only gives the activation limit: if it fails, the offers still come back without it.
  const { data, errors } = await c.graphqlPartial<{
    bonusPersonalPromotionBundles?: { maximumActivations?: number | null }[] | null;
    bonusPromotions?:
      | {
          id: string;
          hqId: number;
          title: string;
          category?: string | null;
          activationStatus?: string | null;
          productCount?: number | null;
          salesUnitSize?: string | null;
          storeOnly?: boolean | null;
          periodStart?: string | null;
          periodEnd?: string | null;
          price?: { now?: Money; was?: Money } | null;
          product?: { id: number; title: string } | null;
        }[]
      | null;
  }>(query, { start: period.start, end: period.end });
  if (!data?.bonusPromotions) {
    if (errors) throw errors;
    return { offers: [] };
  }
  return {
    maxActivations: data.bonusPersonalPromotionBundles?.[0]?.maximumActivations ?? undefined,
    offers: data.bonusPromotions.map((p) => ({
      id: p.id,
      hqId: p.hqId,
      title: p.title,
      category: p.category ?? undefined,
      activated: p.activationStatus === "ACTIVATED",
      product: p.productCount === 1 ? (p.product ?? undefined) : undefined,
      productCount: p.productCount ?? undefined,
      salesUnitSize: p.salesUnitSize ?? undefined,
      priceWas: p.price?.was?.amount,
      priceNow: p.price?.now?.amount,
      storeOnly: Boolean(p.storeOnly),
      periodStart: p.periodStart || period.start,
      periodEnd: p.periodEnd || period.end,
    })),
  };
}

/** Activates a personal offer. AH has no way to undo this. */
export async function activatePersonalOffer(c: AhClient, offer: PersonalOffer): Promise<void> {
  const mutation = `mutation ActivatePersonalOffer($externalId: Int!, $startDate: String!) {
  bonusActivatePersonalPromotion(externalId: $externalId, startDate: $startDate) { status message }
}`;
  const data = await c.graphql<{ bonusActivatePersonalPromotion?: { status?: string; message?: string | null } | null }>(
    mutation,
    { externalId: offer.hqId, startDate: offer.periodStart },
  );
  const r = data.bonusActivatePersonalPromotion;
  checkMutation(r ? { status: r.status ?? "", errorMessage: r.message } : undefined);
}
