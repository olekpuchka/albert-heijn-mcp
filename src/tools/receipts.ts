import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getReceipt, getReceipts } from "../ahapi/index.ts";
import { addAuthedTool, formatDate, orDefault, structured, type ToolContext } from "./common.ts";

export function registerReceiptTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_receipts",
      title: "Albert Heijn: Receipts",
      kind: "readOnly",
      output: { receipts: z.array(z.object({ id: z.string(), date: z.string(), total_amount: z.number() })) },
      description:
        "List recent Albert Heijn in-store receipts (kassabonnen). " +
        "Returns receipt id, date, and total amount. " +
        "Use ah_get_receipt_details with the id to see individual items.",
      input: { limit: z.number().int().optional().describe("Maximum number of results to return (default 10)") },
    },
    async (c, { limit }) => {
      const receipts = await getReceipts(c, Math.min(orDefault(limit, 10), 50));
      return structured({
        receipts: receipts.map((r) => ({ id: r.id, date: formatDate(r.dateTime, true), total_amount: r.total })),
      });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_receipt_details",
      title: "Albert Heijn: Receipt Details",
      kind: "readOnly",
      output: {
        id: z.string(),
        items: z.array(
          z.object({
            name: z.string(),
            quantity: z.number().optional(),
            unit_price: z.number().optional(),
            total: z.number(),
            deposit: z.number().optional(),
          }),
        ),
        discounts: z.array(z.object({ name: z.string(), amount: z.number() })).optional(),
        koopzegels: z.object({ quantity: z.number(), amount: z.number() }).optional(),
        payments: z.array(z.object({ method: z.string(), amount: z.number() })).optional(),
        total_amount: z.number().optional(),
      },
      description:
        "Get full details of a single Albert Heijn in-store receipt (kassabon) by its id. " +
        "Returns all purchased items with name, quantity, unit price, line total and deposit (statiegeld), " +
        "plus any discounts, koopzegels (savings stamps) bought, payment method and total_amount. " +
        "Get the id from ah_get_receipts first.",
      input: { id: z.string().describe("Receipt transaction ID from ah_get_receipts") },
    },
    async (c, { id }) => {
      if (!id) throw new Error("id is required");
      const r = await getReceipt(c, id);
      return structured({
        id: r.id,
        items: r.items.map((it) => ({
          name: it.name,
          quantity: it.quantity || undefined,
          unit_price: it.unitPrice || undefined,
          total: it.total,
          deposit: it.deposit,
        })),
        discounts: r.discounts.length ? r.discounts : undefined,
        koopzegels: r.stamps,
        payments: r.payments.length ? r.payments : undefined,
        total_amount: r.total,
      });
    },
  );
}
