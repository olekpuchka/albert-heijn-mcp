import { log } from "../log.ts";
import type { AhClient } from "./client.ts";

/** Delivery address, in the form orderDeliverySlots takes. */
export interface MemberAddress {
  street: string;
  houseNumber: number;
  houseNumberExtra?: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
}

/** Customer profile. */
export interface Member {
  firstName: string;
  lastName: string;
  email: string;
  postalCode: string;
  bonusCardNumber: string;
  address?: MemberAddress;
}

/** "First Last", as AH shows it. */
export function fullName(m: Member): string {
  return `${m.firstName} ${m.lastName}`.trim();
}

export async function getMember(c: AhClient): Promise<Member> {
  const query = `query Member {
  member {
    name { first last }
    emailAddress
    address { street houseNumber houseNumberExtra postalCode city countryCode }
    cards { bonus }
  }
}`;
  const { member: m } = await c.graphql<{
    member: {
      name?: { first?: string; last?: string };
      emailAddress?: string;
      address?: Partial<MemberAddress> | null;
      cards?: { bonus?: string };
    };
  }>(query);
  return {
    firstName: m.name?.first ?? "",
    lastName: m.name?.last ?? "",
    email: m.emailAddress ?? "",
    postalCode: m.address?.postalCode ?? "",
    bonusCardNumber: m.cards?.bonus ?? "",
    address: isComplete(m.address) ? m.address : undefined,
  };
}

function isComplete(a: Partial<MemberAddress> | null | undefined): a is MemberAddress {
  return Boolean(a?.street && a.houseNumber && a.postalCode && a.city && a.countryCode);
}

/** The member's savings. A balance AH could not return is listed in unavailable. */
export interface Savings {
  /** Koopzegels: stamps bought at the till, paid out with interest once a booklet is full. Fields AH didn't send are absent. */
  koopzegels?: { stamps?: number; fullBooklets?: number; invested?: number; interest?: number; payout?: number };
  /** Air Miles points; error is AH's code when it can't give the balance (e.g. the airmiles.nl link expired). */
  airMiles?: { balance?: number; error?: string };
  /** Balances AH failed on, wholly or in part. */
  unavailable: ("koopzegels" | "air_miles")[];
}

export async function getSavings(c: AhClient): Promise<Savings> {
  const query = `query Savings {
  purchaseStampBalance {
    points { totalPoints fullBooklets }
    money { invested { amount } interest { amount } payout { amount } }
  }
  milesBalance { balance errorState }
}`;
  type Money = { amount: number } | null | undefined;
  // One balance failing leaves the other.
  const { data, errors } = await c.graphqlPartial<{
    purchaseStampBalance: {
      points?: { totalPoints?: number | null; fullBooklets?: number | null } | null;
      money?: { invested?: Money; interest?: Money; payout?: Money } | null;
    } | null;
    milesBalance: { balance?: number | null; errorState?: string | null } | null;
  }>(query);
  if (!data) throw errors ?? new Error("AH returned no savings");
  const k = data.purchaseStampBalance;
  const m = data.milesBalance;
  if (errors) log.warn("some savings could not be fetched", { err: errors });
  // A balance with an error of its own, at any depth, is unavailable or incomplete; an error AH gives no
  // field for may be any balance's. A null balance without an error: the member just has none.
  const failed = (field: string) =>
    errors !== undefined && (errors.fields.includes(field) || errors.unattributed);
  const unavailable: Savings["unavailable"] = [];
  if (failed("purchaseStampBalance")) unavailable.push("koopzegels");
  if (failed("milesBalance")) unavailable.push("air_miles");
  const koopzegels = {
    stamps: k?.points?.totalPoints ?? undefined,
    fullBooklets: k?.points?.fullBooklets ?? undefined,
    invested: k?.money?.invested?.amount,
    interest: k?.money?.interest?.amount,
    payout: k?.money?.payout?.amount,
  };
  return {
    // Absent, not empty, when AH sent no koopzegel figures at all.
    koopzegels: Object.values(koopzegels).some((v) => v !== undefined) ? koopzegels : undefined,
    // With an error state AH's balance (often 0) isn't the member's real balance.
    airMiles: m ? { balance: m.errorState ? undefined : (m.balance ?? undefined), error: m.errorState ?? undefined } : undefined,
    unavailable,
  };
}
