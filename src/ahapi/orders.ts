import type { AhClient } from "./client.ts";
import type { MemberAddress } from "./member.ts";

export interface Order {
  id: number;
  state?: string;
  items: OrderItem[];
  totalPrice?: number;
  totalDiscount?: number;
}

export interface OrderItem {
  productId: number;
  title: string;
  quantity: number;
  /** Current unit price, if known. */
  price?: number;
}

/** Product entry in order REST responses. */
interface OrderedProduct {
  quantity: number;
  product: { webshopId: number; title: string; currentPrice?: number; priceBeforeBonus?: number };
}

function toItem(p: OrderedProduct): OrderItem {
  return {
    productId: p.product.webshopId,
    title: p.product.title,
    quantity: p.quantity,
    price: p.product.currentPrice || p.product.priceBeforeBonus,
  };
}

/** Reports whether err means "no active delivery order". */
export function isNoActiveOrder(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Order does not exist");
}

/** The order being filled before checkout; exists once a slot is chosen. Otherwise throws (see isNoActiveOrder). */
export async function getActiveOrder(c: AhClient): Promise<Order> {
  const res = await c.request<{
    id: number;
    state?: string;
    totalPrice?: { priceDiscount?: number; priceTotalPayable?: number };
    orderedProducts?: OrderedProduct[];
  }>("/mobile-services/order/v1/summaries/active?sortBy=DEFAULT");
  return {
    id: res.id,
    state: res.state,
    items: (res.orderedProducts ?? []).map(toItem),
    totalPrice: res.totalPrice?.priceTotalPayable,
    totalDiscount: res.totalPrice?.priceDiscount,
  };
}

/** Sets quantities (product ID → quantity); 0 removes the product. */
export function setOrderItems(c: AhClient, orderId: number, quantities: Map<number, number>): Promise<void> {
  const items = [...quantities].map(([productId, quantity]) => ({
    productId,
    quantity,
    originCode: "PRD",
    description: "",
    strikethrough: false,
  }));
  return c.request<void>("/mobile-services/order/v1/items?sortBy=DEFAULT", {
    method: "PUT",
    body: { items },
    orderId,
  });
}

export async function getOrderDetails(c: AhClient, orderId: number): Promise<Order> {
  const res = await c.request<{
    orderId: number;
    orderState?: string;
    groupedProductsInTaxonomy?: { orderedProducts?: OrderedProduct[] }[];
  }>(`/mobile-services/order/v1/${orderId}/details-grouped-by-taxonomy`);
  return {
    id: res.orderId,
    state: res.orderState,
    items: (res.groupedProductsInTaxonomy ?? []).flatMap((g) => (g.orderedProducts ?? []).map(toItem)),
  };
}

/** Order history entry. */
export interface Fulfillment {
  orderId: number;
  status: string;
  shoppingType?: string;
  modifiable: boolean;
  totalPrice?: number;
  date?: string; // YYYY-MM-DD
  dateDisplay?: string;
  timeDisplay?: string;
}

/** Upcoming orders, or past ones (delivered or cancelled) if past; newest first. */
export async function getFulfillments(c: AhClient, past: boolean): Promise<Fulfillment[]> {
  const query = `query Fulfillments {
  orderFulfillments(status: ${past ? "CLOSED" : "OPEN"}) {
    result {
      orderId statusDescription shoppingType modifiable
      totalPrice { totalPrice { amount } }
      delivery { slot { date dateDisplay timeDisplay } }
    }
  }
}`;
  const data = await c.graphql<{
    orderFulfillments: {
      result:
        | {
            orderId: number;
            statusDescription: string;
            shoppingType?: string;
            modifiable?: boolean;
            totalPrice?: { totalPrice?: { amount: number } };
            delivery?: { slot?: { date?: string; dateDisplay?: string; timeDisplay?: string } };
          }[]
        | null;
    };
  }>(query);
  return (data.orderFulfillments.result ?? []).map((f) => ({
    orderId: f.orderId,
    status: f.statusDescription,
    shoppingType: f.shoppingType,
    modifiable: f.modifiable ?? false,
    totalPrice: f.totalPrice?.totalPrice?.amount,
    date: f.delivery?.slot?.date,
    dateDisplay: f.delivery?.slot?.dateDisplay,
    timeDisplay: f.delivery?.slot?.timeDisplay,
  }));
}

/** A day's delivery windows; all times are ISO 8601. */
export interface DeliveryDay {
  /** Start of the day in Dutch time. */
  date: string;
  slots: { start: string; end: string }[];
}

/** Minimum order value for home delivery per date as AH sends it (YYYY-MM-DD), in euros, for a Dutch postal code. */
export async function deliveryMinimums(c: AhClient, postalCode: string): Promise<Map<string, number>> {
  const query = `query OrderRulesMinimumValues($postalCode: Int) {
  orderRulesMinimumValues(orderType: DELIVERY, postalCode: $postalCode) { minimumOrderValues { amount date } }
}`;
  // AH takes the four digits of the postal code as a number; without them it would answer for no address in particular.
  const digits = /^\s*(\d{4})/.exec(postalCode)?.[1];
  if (!digits) return new Map();
  const data = await c.graphql<{
    orderRulesMinimumValues: { minimumOrderValues: { amount: number; date: string }[] | null } | null;
  }>(query, { postalCode: Number(digits) });
  return new Map((data.orderRulesMinimumValues?.minimumOrderValues ?? []).map((v) => [v.date, v.amount]));
}

/** Delivery windows AH offers for address, per day, soonest first. Booking one is only possible in the AH app. */
export async function getDeliverySlots(c: AhClient, address: MemberAddress): Promise<DeliveryDay[]> {
  const query = `query DeliverySlots($address: MemberAddressInput!) {
  orderDeliverySlots(address: $address) { date slots { startTime endTime } }
}`;
  const data = await c.graphql<{
    orderDeliverySlots: { date: string; slots: { startTime: string; endTime: string }[] }[] | null;
  }>(query, { address: { ...address, houseNumberExtra: address.houseNumberExtra || undefined } });
  return (data.orderDeliverySlots ?? [])
    .map((day) => ({
      date: day.date,
      slots: day.slots
        .map((s) => ({ start: s.startTime, end: s.endTime }))
        .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
