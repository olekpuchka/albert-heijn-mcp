// Client for the AH mobile app API (REST under /mobile-services, plus GraphQL).

import { describeError, type LogSafe } from "../log.ts";

// The API expects the official iOS app. If AH starts rejecting requests,
// update the version and user agent to the current app release first.
export const CLIENT_NAME = "appie-ios";
const CLIENT_VERSION = "9.48";
const USER_AGENT = "Appie/9.48 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)";
const BASE_URL = "https://api.ah.nl";
const TIMEOUT_MS = 30_000;

/**
 * An error body as one line of text; tool results cap the length. AH sometimes answers with an
 * HTML page, whose tags are dropped; other bodies (JSON) keep theirs, e.g. a "<" in a message.
 */
function plainText(body: string): string {
  let text = body.slice(0, 4000);
  // The cut can split a tag, hence the unclosed one at the end.
  if (/^\s*</.test(text)) text = text.replace(/<[^>]*(>|$)/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

/** A non-2xx API response. */
export class AhApiError extends Error implements LogSafe {
  readonly status: number;

  /** body usually explains the error. */
  constructor(status: number, body: string) {
    super(`AH API error ${status}: ${plainText(body)}`);
    this.name = "AhApiError";
    this.status = status;
  }

  logText(): string {
    return `AH API error ${this.status}`;
  }
}

/** Reports whether err is an AhApiError with this HTTP status. */
export function hasStatus(err: unknown, status: number): boolean {
  return err instanceof AhApiError && err.status === status;
}

/** Reports whether err, or any error in its cause chain, is an HTTP 401 from AH. */
export function isUnauthorized(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (hasStatus(e, 401)) return true;
  }
  return false;
}

/** An error with our own context in front of its cause's message. */
export class ContextError extends Error implements LogSafe {
  /** Our text, without the cause's (which may quote AH). */
  readonly context: string;

  constructor(context: string, cause: unknown) {
    super(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ContextError";
    this.context = context;
  }

  logText(): string {
    return `${this.context}: ${describeError(this.cause)}`;
  }
}

/** Wraps err with context, keeping it as the cause so its HTTP status stays visible. */
export function wrapError(message: string, err: unknown): ContextError {
  return new ContextError(message, err);
}

/** The errors array of a GraphQL response. */
export class GraphQLError extends Error implements LogSafe {
  /** Top-level fields the errors belong to, where AH says. */
  readonly fields: string[];
  /** Some error came without a field, so it may belong to any. */
  readonly unattributed: boolean;

  constructor(messages: string[], fields: string[] = [], unattributed = false) {
    super(`AH GraphQL error: ${messages.join("; ")}`);
    this.name = "GraphQLError";
    this.fields = fields;
    this.unattributed = unattributed;
  }

  logText(): string {
    return "AH GraphQL error";
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Sent as Appie-Current-Order-Id; required by order writes. */
  orderId?: number;
}

export class AhClient {
  /** Access token sent as a Bearer token with every request, if any. */
  readonly token: string | undefined;

  constructor(token?: string) {
    this.token = token;
  }

  /** Sends a REST request; returns the parsed JSON body, or undefined if empty. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "x-client-name": CLIENT_NAME,
      "x-client-version": CLIENT_VERSION,
      "x-application": "AHWEBSHOP",
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (options.orderId) headers["Appie-Current-Order-Id"] = String(options.orderId);

    const res = await fetch(BASE_URL + path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Token requests carry the refresh token or login code in the body, which fetch would resend to a redirect target.
      redirect: "error",
    });
    const text = await res.text();
    if (!res.ok) throw new AhApiError(res.status, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // The parse error would quote the body, e.g. an HTML block page.
      throw new Error(`AH sent a response that is not JSON (HTTP ${res.status})`);
    }
  }

  /** Runs a GraphQL operation; returns its data or throws GraphQLError. */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const { data, errors } = await this.graphqlPartial<T>(query, variables);
    if (errors) throw errors;
    return data as T;
  }

  /**
   * Runs a GraphQL operation and returns what it got: AH answers a field that fails with null and an
   * error, and the other fields of the same request still carry data. For requests that batch
   * independent lookups, where one failing entry shouldn't lose the rest.
   */
  async graphqlPartial<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data: Partial<T> | undefined; errors: GraphQLError | undefined }> {
    const res = await this.request<{ data?: Partial<T> | null; errors?: { message: string; path?: (string | number)[] }[] }>("/graphql", {
      method: "POST",
      body: { query, variables: variables ?? {} },
    });
    return {
      data: res.data ?? undefined,
      errors: res.errors?.length
        ? new GraphQLError(
            res.errors.map((e) => e.message),
            res.errors.flatMap((e) => (typeof e.path?.[0] === "string" ? [e.path[0]] : [])),
            res.errors.some((e) => typeof e.path?.[0] !== "string"),
          )
        : undefined,
    };
  }
}

/** Result object of AH GraphQL mutations. */
export interface MutationResult {
  status: string;
  errorMessage?: string | null;
}

/** A mutation AH answered with a status other than SUCCESS. */
export class MutationError extends Error implements LogSafe {
  readonly status: string;

  constructor(result: MutationResult | undefined) {
    const status = result?.status ?? "no result";
    super(`mutation failed (${status}): ${result?.errorMessage ?? ""}`);
    this.name = "MutationError";
    this.status = status;
  }

  logText(): string {
    return `mutation failed (${this.status})`;
  }
}

/** Throws unless status is SUCCESS. */
export function checkMutation(result: MutationResult | undefined): void {
  if (result?.status !== "SUCCESS") throw new MutationError(result);
}
