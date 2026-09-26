/**
 * Field station sign-in. Visitors get an anonymous, short-lived badge: volunteer by
 * default, or field biologist. A badge is a signed token the gateway's
 * `authenticate` handler verifies; StreamOtter never sees how it was issued.
 *
 * Handing the tablet to the field biologist is a different person, so it's a
 * different subject. StreamOtter then closes the volunteer's subscriptions rather
 * than carrying their view over to someone else.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { TENANT_ID } from "@lontra-creek/sim";
import type { Principal } from "streamotter/contracts";

export type Role = "volunteer" | "researcher";

export interface Badge {
  subject: string;
  role: Role;
  /** Shown in the UI. */
  name: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

const DEVELOPMENT_SECRET = "lontra-creek-development-secret-never-use-in-production";

/** The signing secret: FIELD_STATION_SECRET (32+ characters), required in production. */
export function fieldStationSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["FIELD_STATION_SECRET"];
  if (configured !== undefined && configured.length >= 32) return configured;
  if (env["NODE_ENV"] === "production") throw new Error("FIELD_STATION_SECRET (at least 32 characters) is required in production.");
  return DEVELOPMENT_SECRET;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueToken(badge: Badge, options: { secret: string; ttlSeconds: number; now?: number }): IssuedToken {
  const expiresAt = new Date((options.now ?? Date.now()) + options.ttlSeconds * 1_000).toISOString();
  const payload = Buffer.from(JSON.stringify({ sub: badge.subject, role: badge.role, name: badge.name, sid: randomUUID(), exp: expiresAt })).toString("base64url");
  return { token: `${payload}.${sign(payload, options.secret)}`, expiresAt };
}

/** Returns the badge holder as a StreamOtter principal, or null for a forged, malformed, or expired token. */
export function verifyToken(token: string, secret: string, now = Date.now()): Principal | null {
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { sub, role, name, sid, exp } = claims;
  if (typeof sub !== "string" || typeof sid !== "string" || typeof exp !== "string" || typeof name !== "string") return null;
  if (role !== "volunteer" && role !== "researcher") return null;
  if (!(Date.parse(exp) > now)) return null;
  return { subject: sub, tenantId: TENANT_ID, sessionId: sid, expiresAt: exp, claims: { role, name } };
}

export function isResearcher(principal: Principal): boolean {
  return principal.claims["role"] === "researcher";
}
