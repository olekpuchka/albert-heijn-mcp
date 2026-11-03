import type { AhClient } from "./client.ts";

/** In-store receipt (kassabon) summary. */
export interface ReceiptSummary {
  id: string;
  dateTime: string; // ISO 8601
  total: number;
}

/** limit receipts starting at offset, newest first. */
export async function getReceipts(c: AhClient, limit: number, offset = 0): Promise<ReceiptSummary[]> {
  const query = `query Receipts($offset: Int!, $limit: Int!) {
  posReceiptsPage(pagination: {offset: $offset, limit: $limit}) {
    posReceipts { id dateTime totalAmount { amount } }
  }
}`;
  const data = await c.graphql<{
    posReceiptsPage: { posReceipts: { id: string; dateTime: string; totalAmount?: { amount: number } }[] | null };
  }>(query, { offset, limit });
  return (data.posReceiptsPage.posReceipts ?? []).map((r) => ({
    id: r.id,
    dateTime: r.dateTime,
    total: r.totalAmount?.amount ?? 0,
  }));
}

export interface Receipt {
  id: string;
  items: { name: string; quantity: number; unitPrice?: number; total: number }[];
  discounts: { name: string; amount: number }[];
  payments: { method: string; amount: number }[];
}

export async function getReceipt(c: AhClient, id: string): Promise<Receipt> {
  const query = `query Receipt($id: String!) {
  posReceiptDetails(id: $id) {
    id
    products { name quantity price { amount } amount { amount } }
    discounts { name amount { amount } }
    payments { method amount { amount } }
  }
}`;
  type Money = { amount: number } | null;
  const { posReceiptDetails: d } = await c.graphql<{
    posReceiptDetails: {
      id: string;
      products?: { name: string; quantity: number; price?: Money; amount?: Money }[] | null;
      discounts?: { name: string; amount?: Money }[] | null;
      payments?: { method: string; amount?: Money }[] | null;
    };
  }>(query, { id });
  return {
    id: d.id,
    items: (d.products ?? []).map((p) => ({
      name: p.name,
      quantity: p.quantity,
      unitPrice: p.price?.amount,
      total: p.amount?.amount ?? 0,
    })),
    discounts: (d.discounts ?? []).map((x) => ({ name: x.name, amount: x.amount?.amount ?? 0 })),
    payments: (d.payments ?? []).map((x) => ({ method: x.method, amount: x.amount?.amount ?? 0 })),
  };
}

const RECEIPT_PAGE = 100;

/** Receipts, newest first, until the first one keep rejects; at most max. */
export async function getReceiptsWhile(
  c: AhClient,
  keep: (r: ReceiptSummary) => boolean,
  max: number,
): Promise<ReceiptSummary[]> {
  const out: ReceiptSummary[] = [];
  for (let offset = 0; out.length < max; offset += RECEIPT_PAGE) {
    const size = Math.min(RECEIPT_PAGE, max - out.length);
    const page = await getReceipts(c, size, offset);
    for (const r of page) {
      if (!keep(r)) return out;
      out.push(r);
    }
    if (page.length < size) break;
  }
  return out;
}

/** Product line of a receipt. posId is AH's till id, see convertPosIds; absent on lines like bags or deposits. */
export interface ReceiptLine {
  posId?: number;
  name: string;
}

/** Most receipts getReceiptLines takes in one call (one GraphQL request). */
export const RECEIPT_LINES_BATCH = 25;

/**
 * Product lines of up to RECEIPT_LINES_BATCH receipts, in the order of ids; undefined for a receipt AH
 * could not return. Returned and voided lines (quantity 0 or less) are left out.
 */
export async function getReceiptLines(c: AhClient, ids: string[]): Promise<(ReceiptLine[] | undefined)[]> {
  if (ids.length > RECEIPT_LINES_BATCH) throw new Error(`at most ${RECEIPT_LINES_BATCH} receipts per call`);
  if (ids.length === 0) return [];
  const vars = ids.map((_, j) => `$id${j}: String!`).join(", ");
  const fields = ids.map((_, j) => `r${j}: posReceiptDetails(id: $id${j}) { products { id name quantity } }`).join("\n  ");
  type Lines = { products?: { id?: number | null; name?: string | null; quantity?: number | null }[] | null } | null;
  const { data, errors } = await c.graphqlPartial<Record<string, Lines>>(
    `query ReceiptLines(${vars}) {\n  ${fields}\n}`,
    Object.fromEntries(ids.map((id, j) => [`id${j}`, id])),
  );
  if (!data) throw errors ?? new Error("AH returned no receipt details");
  return ids.map((_, j) => {
    const receipt = data[`r${j}`];
    if (!receipt) return undefined;
    return (receipt.products ?? [])
      .filter((p) => (p.quantity ?? 1) > 0)
      .map((p) => ({ posId: p.id && p.id > 0 ? p.id : undefined, name: p.name ?? "" }));
  });
}
