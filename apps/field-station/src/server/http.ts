/**
 * The field station's two HTTP listeners.
 *
 * Public, behind Caddy at /api: where the gateway is, sign-in badges, and the
 * study's status, with CORS for the site's origin and credentials, and a request
 * budget per client. GET /healthz is for the container's health check; Caddy
 * doesn't route it.
 *
 * Internal, on the compose network only: GET /internal/views/:channel/:id, the
 * current view the gateway's snapshot handler asks for, with the service token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Role } from "../identity.ts";
import { badgeFor } from "../sessions.ts";
import type { ServerConfig } from "./config.ts";
import type { FieldStation } from "./station.ts";

type Headers = Record<string, string>;

function send(response: ServerResponse, status: number, body: unknown, headers: Headers = {}): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 4_096) throw new Error("Body too large");
  }
  const value: unknown = text === "" ? {} : JSON.parse(text);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A token bucket per client: `burst` requests at once, refilled at `perSecond`.
 * Clients are told apart by the X-Client-IP header Caddy sets (the app's port is
 * reachable only through Caddy), or by the socket address when there's no proxy.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #burst: number;
  readonly #perSecond: number;
  readonly #now: () => number;

  constructor(options: { burst: number; perSecond: number; now?: () => number }) {
    this.#burst = options.burst;
    this.#perSecond = options.perSecond;
    this.#now = options.now ?? Date.now;
  }

  /** Takes one token; returns 0 if allowed, or the seconds to wait. */
  take(client: string): number {
    const now = this.#now();
    const bucket = this.#buckets.get(client) ?? { tokens: this.#burst, at: now };
    bucket.tokens = Math.min(this.#burst, bucket.tokens + ((now - bucket.at) / 1_000) * this.#perSecond);
    bucket.at = now;
    this.#buckets.set(client, bucket);
    if (this.#buckets.size > 10_000) this.#sweep(now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.#perSecond);
  }

  #sweep(now: number): void {
    const full = (this.#burst / this.#perSecond) * 1_000;
    for (const [client, bucket] of this.#buckets) if (now - bucket.at > full) this.#buckets.delete(client);
  }
}

export function clientAddress(request: IncomingMessage): string {
  const header = request.headers["x-client-ip"];
  return (typeof header === "string" && header !== "" ? header : request.socket.remoteAddress) ?? "unknown";
}

export function publicApi(options: { config: ServerConfig; station: FieldStation; limiter?: RateLimiter; log?: (message: string) => void }): Server {
  const { config, station } = options;
  const limiter = options.limiter ?? new RateLimiter({ burst: 30, perSecond: 1 });
  const log = options.log ?? (message => console.error(message));

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://field-station.invalid");
    try {
      if (url.pathname === "/healthz") {
        const healthy = station.ready && station.kafkaHealthy;
        return send(response, healthy ? 200 : 503, { ready: station.ready, kafka: station.kafkaHealthy ? "connected" : "unavailable", tick: station.tick, target: station.targetTick() });
      }
      if (!url.pathname.startsWith("/api/")) return send(response, 404, { error: "Not found." });

      const origin = request.headers.origin;
      const cors: Headers = { vary: "Origin" };
      if (origin !== undefined && config.siteOrigins.includes(origin)) {
        cors["access-control-allow-origin"] = origin;
        cors["access-control-allow-credentials"] = "true";
      }
      if (request.method === "OPTIONS") {
        if (cors["access-control-allow-origin"] === undefined) return send(response, 403, { error: "Origin not allowed." }, cors);
        response.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
        return response.end();
      }

      const wait = limiter.take(clientAddress(request));
      if (wait > 0) return send(response, 429, { error: "Too many requests." }, { ...cors, "retry-after": String(wait) });

      if (request.method === "GET" && url.pathname === "/api/config") {
        return send(response, 200, { gatewayOrigin: config.gatewayOrigin, gatewayPath: config.gatewayPath, mode: "kafka", tickMs: config.tickMs }, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return send(response, 200, { mode: "kafka", ...station.status() }, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/badge") {
        // Browsers send Origin on every POST; refusing others keeps other sites from minting badges with a visitor's cookie.
        if (origin !== undefined && cors["access-control-allow-origin"] === undefined) return send(response, 403, { error: "Origin not allowed." }, cors);
        const body = await readJson(request);
        const role: Role = body["role"] === "researcher" ? "researcher" : "volunteer";
        const result = badgeFor({ cookieHeader: request.headers.cookie, role, secret: config.secret, secure: config.production });
        return send(response, 200, { badge: result.badge, token: result.token.token, expiresAt: result.token.expiresAt },
          result.setCookie === null ? cors : { ...cors, "set-cookie": result.setCookie });
      }
      send(response, 404, { error: "Not found." }, cors);
    } catch (error) {
      log(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) send(response, 400, { error: "Bad request." });
    }
  });
}

export function internalApi(options: { serviceToken: string; station: FieldStation }): Server {
  const expected = Buffer.from(`Bearer ${options.serviceToken}`);
  const authorized = (request: IncomingMessage): boolean => {
    const provided = Buffer.from(request.headers.authorization ?? "");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };

  return createServer((request, response) => {
    if (!authorized(request)) return send(response, 401, { error: "Unauthorized." });
    const url = new URL(request.url ?? "/", "http://field-station.invalid");
    const match = /^\/internal\/views\/([A-Za-z]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "GET" || match === null) return send(response, 404, { error: "Not found." });
    if (!options.station.ready) return send(response, 503, { error: "Catching up." });
    let id: string;
    try {
      id = decodeURIComponent(match[2]!);
    } catch {
      return send(response, 404, { error: "Not found." });
    }
    const view = options.station.view(`${match[1]}:${id}`);
    if (view === undefined) return send(response, 404, { error: "No such view." });
    send(response, 200, { revision: view.revision, data: view.data });
  });
}
