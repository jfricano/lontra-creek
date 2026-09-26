/**
 * Visitor sessions. A visitor's identity lives in a signed, HttpOnly cookie, so every
 * token the page asks for names the same subject. That matters: StreamOtter closes a
 * view when the subject behind a connection changes, which is exactly what should
 * happen when the tablet goes to someone else, and exactly what shouldn't happen when
 * a volunteer's token is merely refreshed.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { issueToken, type Badge, type IssuedToken, type Role } from "./identity.ts";

export const SESSION_COOKIE = "lc_session";
export const SESSION_SECONDS = 30 * 60;
const TOKEN_SECONDS = 10 * 60;

const NAMES: Readonly<Record<Role, string>> = { volunteer: "Volunteer", researcher: "Field biologist" };

interface SessionClaims {
  subject: string;
  role: Role;
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", `${secret}:session`).update(payload).digest("base64url");
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function readSession(cookieHeader: string | undefined, secret: string, now: number): SessionClaims | null {
  const raw = readCookie(cookieHeader, SESSION_COOKIE);
  if (raw === null) return null;
  const [payload, signature] = raw.split(".");
  if (payload === undefined || signature === undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (typeof claims.subject !== "string" || (claims.role !== "volunteer" && claims.role !== "researcher") || !(claims.exp > now)) return null;
    return claims;
  } catch {
    return null;
  }
}

export interface BadgeResult {
  badge: Badge;
  token: IssuedToken;
  /** A Set-Cookie header value to send when the session is new or changed. */
  setCookie: string | null;
}

/**
 * Returns a gateway token for this visitor. The same role keeps the same subject;
 * asking for a different role is a different person, so it gets a new subject.
 */
export function badgeFor(options: { cookieHeader: string | undefined; role: Role; secret: string; secure: boolean; now?: number }): BadgeResult {
  const now = options.now ?? Date.now();
  let session = readSession(options.cookieHeader, options.secret, now);
  let setCookie: string | null = null;
  if (session === null || session.role !== options.role) {
    session = { subject: `${options.role}-${randomUUID().slice(0, 8)}`, role: options.role, exp: now + SESSION_SECONDS * 1_000 };
    const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
    setCookie = [
      `${SESSION_COOKIE}=${payload}.${sign(payload, options.secret)}`,
      "Path=/api",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${SESSION_SECONDS}`,
      ...(options.secure ? ["Secure"] : [])
    ].join("; ");
  }
  const badge: Badge = { subject: session.subject, role: session.role, name: NAMES[session.role] };
  const ttlSeconds = Math.max(60, Math.min(TOKEN_SECONDS, Math.floor((session.exp - now) / 1_000)));
  return { badge, token: issueToken(badge, { secret: options.secret, ttlSeconds, now }), setCookie };
}
