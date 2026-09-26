/** The field station's small site API: where the gateway is, and badges to sign in with. */

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
  const response = await fetch("/api/config", { cache: "no-store", ...(signal === undefined ? {} : { signal }) });
  if (!response.ok) throw new Error(`The field station answered ${response.status}.`);
  return await response.json() as FieldConfig;
}

/** Asks for a gateway token. The same role keeps the same visitor; a different role is a different person. */
export async function requestBadge(role: Role, signal?: AbortSignal): Promise<BadgeResponse> {
  const response = await fetch("/api/badge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
    cache: "no-store",
    credentials: "same-origin",
    ...(signal === undefined ? {} : { signal })
  });
  if (!response.ok) throw new Error(`Signing in failed (${response.status}).`);
  return await response.json() as BadgeResponse;
}
