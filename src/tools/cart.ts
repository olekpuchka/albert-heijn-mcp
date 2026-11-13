// "Cart" tools act on the active delivery order. Before a delivery slot is
// chosen, the AH app's basket is the shopping list.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type AhClient,
  deliveryMinimums,
  getActiveOrder,
  getDeliverySlots,
  isNoActiveOrder,
  type Order,
  setOrderItems,
} from "../ahapi/index.ts";
import { log } from "../log.ts";
import {
  addAuthedTool,
  cachedMember,
  confirmInput,
  formatDate,
  formatTime,
  nonFatal,
  structured,
  orDefault,
  quantitySchema,
  text,
  type ToolContext,
  wrapError,
} from "./common.ts";
import { orderView, viewOrder } from "./views.ts";

/** AH accepts changes only to an active order, which its API can't create. */
const NO_ACTIVE_ORDER =
  "there is no active delivery order to change: " +
  "to collect products, use the shopping list (ah_add_to_shopping_list); " +
  "choosing a delivery slot in the AH app or on ah.nl turns the list into an order";

/** undefined if there is no active order. */
async function activeOrder(c: AhClient): Promise<Order | undefined> {
  try {
    return await getActiveOrder(c);
  } catch (err) {
    if (isNoActiveOrder(err)) return undefined;
    throw wrapError("failed to get active order", err);
  }
}

export function registerCartTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_cart",
      title: "Albert Heijn: View Order Cart",
      kind: "readOnly",
      output: { order: orderView.optional() },
      description:
        "View the items in the active Albert Heijn delivery order (the order cart). " +
        "An order only exists after the user has chosen a delivery or pick-up slot; " +
        "the products the user is collecting before that are on the shopping list (use ah_get_shopping_list). " +
        "Returns the order state, items with names and quantities, total price, and total discount.",
    },
    async (c) => {
      const order = await activeOrder(c);
      if (!order) {
        return structured(
          {},
          "There is no active delivery order, so the order cart is empty. " +
            "Products the user is collecting are on the shopping list (ah_get_shopping_list).",
        );
      }
      return structured({ order: viewOrder(order) });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_update_cart_item",
      title: "Albert Heijn: Update Order Item",
      kind: "destructive",
      description:
        "Set the quantity of a product in the active Albert Heijn delivery order. " +
        "Requires an order (started by choosing a delivery slot in the AH app or on ah.nl, which moves the " +
        "shopping list into it); to collect products before that, use ah_add_to_shopping_list. " +
        "Use product_id from ah_search_products or ah_get_cart. " +
        "Set quantity=0 to remove the item (or use ah_remove_from_cart).",
      input: {
        product_id: z.number().int().describe("Numeric product ID"),
        quantity: quantitySchema.min(0).describe("New quantity (0 removes the item)"),
      },
    },
    async (c, { product_id, quantity }) => {
      if (product_id <= 0) throw new Error("product_id is required");
      const order = await activeOrder(c);
      if (!order) throw new Error(NO_ACTIVE_ORDER);
      await setOrderItems(c, order.id, new Map([[product_id, quantity]]));
      return text(
        quantity === 0
          ? `Product ${product_id} removed from cart.`
          : `Product ${product_id} quantity set to ${quantity}.`,
      );
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_remove_from_cart",
      title: "Albert Heijn: Remove from Order",
      kind: "destructive",
      description:
        "Remove a single product from the active Albert Heijn delivery order. " +
        "Use product_id from ah_get_cart. To remove products from the shopping list, use ah_remove_from_shopping_list.",
      input: { product_id: z.number().int().describe("Numeric product ID to remove") },
    },
    async (c, { product_id }) => {
      if (product_id <= 0) throw new Error("product_id is required");
      const order = await activeOrder(c);
      if (!order) return text("Your cart is empty: there is no active order.");
      await setOrderItems(c, order.id, new Map([[product_id, 0]]));
      return text(`Product ${product_id} removed from cart.`);
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_clear_cart",
      title: "Albert Heijn: Clear Order",
      kind: "destructive",
      description:
        "Remove ALL items from the active Albert Heijn delivery order (not the shopping list). " +
        'Irreversible — requires confirm="yes" to prevent accidental use.',
      input: confirmInput,
    },
    async (c, { confirm }) => {
      if (confirm !== "yes") throw new Error('confirm must be "yes" to clear the cart');
      const order = await activeOrder(c);
      if (!order || order.items.length === 0) return text("Your cart is already empty.");
      await setOrderItems(c, order.id, new Map(order.items.map((it) => [it.productId, 0])));
      return text("Shopping cart cleared.");
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_delivery_slots",
      title: "Albert Heijn: Delivery Slots",
      kind: "readOnly",
      output: {
        postal_code: z.string(),
        days: z.array(
          z.object({ date: z.string(), minimum_order_value: z.number().optional(), windows: z.array(z.string()) }),
        ),
      },
      description:
        "List the delivery time windows Albert Heijn offers at the member's address, per day (Dutch time). " +
        "Booking a slot is only possible in the AH app or on ah.nl; this shows when delivery is possible. " +
        "Returns date, windows like '15:00-17:00', and the minimum order value for delivery that day in euros.",
      input: {
        days: z.number().int().optional().describe("Number of days with slots to return (default 7)"),
      },
    },
    async (c, args) => {
      const { address } = await cachedMember(ctx, c);
      if (!address) throw new Error("the member profile has no delivery address; add one in the AH app");
      const [slots, minimums] = await Promise.all([
        getDeliverySlots(c, address),
        // The minimum is extra information: the slots are still worth showing without it.
        nonFatal(
          () => deliveryMinimums(c, address.postalCode),
          (err) => {
            log.warn("could not fetch the minimum order value", { err });
            return new Map<string, number>();
          },
        ),
      ]);
      const days = slots.filter((d) => d.slots.length > 0);
      const minimumOn = new Map([...minimums].map(([date, amount]) => [formatDate(date, false), amount]));
      return structured(
        {
          postal_code: address.postalCode,
          days: days.slice(0, orDefault(args.days, 7)).map((d) => {
            // AH sends the day as UTC midnight of the day before (e.g. 2026-11-13T23:00Z for the 14th): the Dutch date matches the minimums.
            const date = formatDate(d.date, false);
            return {
              date,
              minimum_order_value: minimumOn.get(date),
              windows: d.slots.map((s) => `${formatTime(s.start)}-${formatTime(s.end)}`),
            };
          }),
        },
        days.length ? undefined : `AH offers no delivery slots for ${address.postalCode} right now.`,
      );
    },
  );
}
