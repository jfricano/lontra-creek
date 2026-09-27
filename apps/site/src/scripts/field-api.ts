/**
 * The field station's small site API: where the gateway is, and badges to sign in with.
 *
 * In production the API is on the demo host (PUBLIC_FIELD_STATION_ORIGIN at build
 * time), a different origin from the site but the same site, so the session cookie
 * (HttpOnly, SameSite=Strict, host-only on the demo host) travels with
 * `credentials: "include"`. In development it is this origin's /api, which Vite
 * proxies to the field station.
 */

// `?.` on env: Vite always supplies it in the browser; Node's test runner, which loads
// this module without Vite's transform, does not.
const API_ORIGIN = (import.meta.env?.PUBLIC_FIELD_STATION_ORIGIN ?? "").replace(/\/+$/, "");

export interface FieldConfig {
  gatewayOrigin: string;
  gatewayPath: string;
  /** "fixture": a local replay without Kafka. "kafka": the live field station. */
  mode: "fixture" | "kafka";
  tickMs: number;
}

export type Role = "volunteer" | "researcher";

export interface BadgeResponse {
  badge: { subject: string; role: Role; name: string };
  token: string;
  expiresAt: string;
}

export async function fetchConfig(signal?: AbortSignal): Promise<FieldConfig> {
  const response = await fetch(`${API_ORIGIN}/api/config`, { cache: "no-store", credentials: "include", ...(signal === undefined ? {} : { signal }) });
  if (!response.ok) throw new Error(`The field station answered ${response.status}.`);
  return await response.json() as FieldConfig;
}

/** Asks for a gateway token. The same role keeps the same visitor; a different role is a different person. */
export async function requestBadge(role: Role, signal?: AbortSignal): Promise<BadgeResponse> {
  const response = await fetch(`${API_ORIGIN}/api/badge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
    cache: "no-store",
    credentials: "include",
    ...(signal === undefined ? {} : { signal })
  });
  if (!response.ok) throw new Error(`Signing in failed (${response.status}).`);
  return await response.json() as BadgeResponse;
}

/** Writes fixed-choice sightings; the UI waits for the subscription, not this response. */
export async function postSighting(sighting: { otterId: string; reachId: string; activity: string }): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/notebook/sightings`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(sighting)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Sighting was not saved (${response.status}).`);
  }
}
