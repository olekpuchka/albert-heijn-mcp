import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type AhClient, getMember, hasStatus, isUnauthorized } from "../ahapi/index.ts";
import { BrowserLogin } from "../auth/browser.ts";
import { NotLoggedInError, type Session, SessionExpiredError } from "../auth/session.ts";
import { DamagedTokensError } from "../auth/tokens.ts";
import { log } from "../log.ts";
import { TtlCache } from "./cache.ts";
import type { BonusOffer, BonusPeriod, Category, Member, Nutrient, Product } from "../ahapi/index.ts";

/**
 * Limits on what one call can write. Text that goes on the user's lists is read back into every
 * later session, and quantities end up in paid orders, so neither is left unbounded.
 */
export const MAX_ITEMS = 50;
export const MAX_QUANTITY = 99;
export const quantitySchema = z.number().int().max(MAX_QUANTITY);
export const itemText = z.string().max(100);
export const productItems = z
  .array(z.object({ product_id: z.number().int().describe("numeric product ID"), quantity: quantitySchema.describe("number of units") }))
  .max(MAX_ITEMS);

export const confirmInput = { confirm: z.string().describe('Must be "yes" to confirm') };

/** State shared by tool handlers. */
export interface ToolContext {
  session: Session;
  /** Don't open a browser on login. */
  remote: boolean;
  /** Served over HTTP: users connect from apps elsewhere, possibly on a phone. */
  hosted: boolean;
  /** Login in a browser window, see ah_login. */
  browserLogin: BrowserLogin;
  searches: TtlCache<Product[]>;
  products: TtlCache<Product>;
  nutrition: TtlCache<Nutrient[] | undefined>;
  /** Barcode number → product id; only barcodes AH sells are kept. */
  barcodes: TtlCache<number>;
  bonuses: TtlCache<BonusOffer[]>;
  bonusPeriods: TtlCache<BonusPeriod[]>;
  categories: TtlCache<Category[] | undefined>;
  /** Keyed by access token, so another login never sees a cached profile. */
  members: TtlCache<Member>;
}

export function newToolContext(session: Session, { remote, hosted }: { remote: boolean; hosted: boolean }): ToolContext {
  return {
    session,
    remote,
    hosted,
    browserLogin: new BrowserLogin(),
    searches: new TtlCache(5 * 60_000),
    products: new TtlCache(10 * 60_000),
    nutrition: new TtlCache(60 * 60_000),
    barcodes: new TtlCache(60 * 60_000),
    bonuses: new TtlCache(10 * 60_000),
    bonusPeriods: new TtlCache(10 * 60_000),
    categories: new TtlCache(60 * 60_000),
    members: new TtlCache(30 * 60_000),
  };
}

/** Side effects; clients use them to decide which calls need confirmation. */
type ToolKind = "readOnly" | "additive" | "destructive";

function annotations(title: string, kind: ToolKind): ToolAnnotations {
  switch (kind) {
    case "readOnly":
      return { title, readOnlyHint: true };
    case "additive":
      return { title, readOnlyHint: false, destructiveHint: false };
    case "destructive":
      return { title, readOnlyHint: false, destructiveHint: true };
  }
}

interface ToolDef<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  kind: ToolKind;
  description: string;
  input?: Shape;
  /** Shape of the structured result of a successful call; clients get it as outputSchema. */
  output?: z.ZodRawShape;
}

type Args<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** A result with structured data, also sent as JSON text for clients without structured output; message replaces the text. */
export function structured(data: Record<string, unknown>, message?: string): CallToolResult {
  // AH sends null for some missing values; as "absent" they fit the optional fields of the output schemas.
  const json = JSON.stringify(data, (_key, value: unknown) => (value === null ? undefined : value), 2);
  return { content: [{ type: "text", text: message ?? json }], structuredContent: JSON.parse(json) as Record<string, unknown> };
}

/** Errors can quote AH; enough of that to explain the error, not a whole error page. */
const MAX_ERROR_LENGTH = 500;

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? (modelMessage(err) ?? err.message) : String(err);
  const text = message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
  return { content: [{ type: "text", text }], isError: true };
}

/** Registers a tool. Thrown errors become error results; every call is logged. */
export function addTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  def: ToolDef<Shape>,
  handler: (args: Args<Shape>) => Promise<CallToolResult>,
): void {
  const callback = async (args: Args<Shape>): Promise<CallToolResult> => {
    const start = Date.now();
    try {
      const result = await handler(args);
      log.info("tool call", { tool: def.name, duration_ms: Date.now() - start });
      return result;
    } catch (err) {
      log.warn("tool call returned error", { tool: def.name, duration_ms: Date.now() - start, err });
      return errorResult(err);
    }
  };
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description + (hasUrl(def.output) ? LINK_HINT : ""),
      inputSchema: def.input ?? ({} as Shape),
      outputSchema: def.output,
      annotations: annotations(def.title, def.kind),
    },
    // Typed via Args<Shape> above; the SDK's generic callback type doesn't infer here.
    callback as never,
  );
}

/** Appended to tools whose results have ah.nl links; tool descriptions reach the model in every client. */
const LINK_HINT = " When you mention a product or recipe from the result, link its name to its url.";

/** Reports whether results of this output shape include a url field anywhere. */
function hasUrl(output: z.ZodRawShape | undefined): boolean {
  return output !== undefined && JSON.stringify(z.toJSONSchema(z.object(output))).includes('"url"');
}

const NOT_AUTHENTICATED = JSON.stringify({
  error: "not_authenticated",
  message: "Not logged in. Call ah_login first.",
});

// Not "log in again" alone: that reads as reconnecting the MCP client, which doesn't help.
const SESSION_EXPIRED = JSON.stringify({
  error: "session_expired",
  message:
    "The Albert Heijn login has expired or was revoked. Call ah_login to log in to Albert Heijn again; " +
    "reconnecting the MCP client doesn't help.",
});

/**
 * What to tell the model instead of err's message, for errors it should act on in a set way. Not when
 * wrapped: then something else failed, and loginStatus wouldn't agree that a login is needed.
 */
function modelMessage(err: Error): string | undefined {
  // A damaged tokens file is replaced by the next login; its path is the server's business.
  if (err instanceof NotLoggedInError || err instanceof DamagedTokensError) return NOT_AUTHENTICATED;
  if (err instanceof SessionExpiredError) return SESSION_EXPIRED;
  return undefined;
}

/** Registers a tool that needs a login. On a 401, refreshes the token and retries once. */
export function addAuthedTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  def: ToolDef<Shape>,
  handler: (c: AhClient, args: Args<Shape>) => Promise<CallToolResult>,
): void {
  addTool(server, def, (args) => ctx.session.withClient((c) => handler(c, args)));
}

export { wrapError } from "../ahapi/index.ts";

/** Runs fn; a non-401 error goes to onError. 401s propagate so addAuthedTool can refresh the token. */
export async function nonFatal<T>(fn: () => Promise<T>, onError: (err: unknown) => T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    return onError(err);
  }
}

/** The logged-in member's profile, cached. */
export function cachedMember(ctx: ToolContext, c: AhClient): Promise<Member> {
  return ctx.members.getOrLoad(c.token ?? "", () => getMember(c));
}

/** v if positive, else def. */
export function orDefault(v: number | undefined, def: number): number {
  return v && v > 0 ? v : def;
}

/** Runs fn(0..n-1) with at most limit in flight. */
export async function parallel(n: number, limit: number, fn: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < n) await fn(next++);
  };
  await Promise.all(Array.from({ length: Math.min(limit, n) }, worker));
}

const amsterdam = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Amsterdam",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** ISO 8601 → "YYYY-MM-DD[ HH:MM]" in Dutch time; returns s unchanged if unparsable. */
export function formatDate(s: string | undefined, withTime: boolean): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const formatted = amsterdam.format(d); // "YYYY-MM-DD HH:MM"
  return withTime ? formatted : formatted.slice(0, 10);
}

/** ISO 8601 → "HH:MM" in Dutch time. */
export function formatTime(s: string): string {
  return formatDate(s, true).slice(11);
}

/** Up to 3 attempts on rate limiting (429), waiting 1 s then 2 s. */
export async function withRetry<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === 2 || !isRateLimited(err)) throw err;
      const waitMs = 1000 * 2 ** attempt;
      log.warn("rate limited by AH, retrying", { tool, wait_ms: waitMs, attempt: attempt + 1 });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

function isRateLimited(err: unknown): boolean {
  if (hasStatus(err, 429)) return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return msg.includes("rate limit") || msg.includes("too many requests");
}
