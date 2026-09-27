/**
 * A Failure Lab bench's relay to Kafka: the flash flood's target. A plain TCP relay
 * from the address the broker advertises to one bench (its relay's name, such as
 * lab-1-kafka:9101) to that bench's own listener on the broker. TLS and SCRAM pass
 * through end to end; the relay never sees them.
 *
 * Cutting it stops listening, so new connections are refused, and resets every
 * connection it carries, so the bench's Kafka client loses the broker at once
 * rather than after a timeout. Restoring it listens again; the client reconnects on
 * its own. Nothing else uses the relay, so the demo host's gateway and the field
 * station, which reach the broker directly, never notice.
 *
 * The control API is for the field station's bench API, on the compose network:
 * GET /state, POST /cut, and POST /restore, each with the service token as a
 * bearer token, each answering {"state": "open" | "cut", "connections": n}.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";

export interface Endpoint {
  host: string;
  port: number;
}

export interface RelayOptions {
  /** Where the bench connects. */
  listen: Endpoint;
  /** The broker's listener for this bench. */
  target: Endpoint;
  log?: (message: string) => void;
}

export type RelayState = "open" | "cut";

export interface Relay {
  readonly state: RelayState;
  /** Connections carried now. */
  readonly connections: number;
  /** The listening port while open (useful when listening on port 0). */
  readonly port: number | null;
  cut(): Promise<void>;
  restore(): Promise<void>;
  close(): Promise<void>;
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const log = options.log ?? (() => undefined);
  const pairs = new Set<{ client: Socket; upstream: Socket }>();
  let state: RelayState = "open";
  let server: Server | null = null;
  let port: number | null = null;

  function relay(client: Socket): void {
    const upstream = connect(options.target);
    const pair = { client, upstream };
    pairs.add(pair);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = (): void => {
      if (!pairs.delete(pair)) return;
      client.destroy();
      upstream.destroy();
    };
    client.once("close", end);
    upstream.once("close", end);
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  }

  function listen(): Promise<void> {
    const created = createServer(relay);
    return new Promise((resolve, reject) => {
      created.once("error", reject);
      // A cut and restore reuses the port it had, even when first asked for port 0.
      created.listen(port ?? options.listen.port, options.listen.host, () => {
        created.off("error", reject);
        server = created;
        port = (created.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  function stopListening(): Promise<void> {
    const current = server;
    server = null;
    if (current === null) return Promise.resolve();
    return new Promise(resolve => current.close(() => resolve()));
  }

  function resetAll(): void {
    for (const { client, upstream } of pairs) {
      // A reset, not a polite close: the flood took the line down.
      client.resetAndDestroy();
      upstream.destroy();
    }
    pairs.clear();
  }

  await listen();
  log(`Relaying ${options.listen.host}:${port} to ${options.target.host}:${options.target.port}.`);

  return {
    get state() { return state; },
    get connections() { return pairs.size; },
    get port() { return server === null ? null : port; },
    async cut() {
      if (state === "cut") return;
      state = "cut";
      const closing = stopListening();
      const count = pairs.size;
      resetAll();
      await closing;
      log(`Cut: refusing connections and reset ${count}.`);
    },
    async restore() {
      if (state === "open") return;
      await listen();
      state = "open";
      log("Restored: accepting connections.");
    },
    async close() {
      state = "cut";
      const closing = stopListening();
      resetAll();
      await closing;
    }
  };
}

function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The relay's control API. Every request needs the bearer token. */
export function relayControl(relay: Relay, token: string): HttpServer {
  if (token.length < 32) throw new Error("The relay's control token must have at least 32 characters.");
  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  const answer = (response: ServerResponse): void => send(response, 200, { state: relay.state, connections: relay.connections });

  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const provided = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (!tokensEqual(token, provided)) return send(response, 401, { error: "unauthorized" });
    const route = `${request.method ?? "GET"} ${request.url ?? "/"}`;
    request.resume();
    switch (route) {
      case "GET /state":
        return answer(response);
      case "POST /cut":
        relay.cut().then(() => answer(response), () => send(response, 500, { error: "cut failed" }));
        return;
      case "POST /restore":
        relay.restore().then(() => answer(response), () => send(response, 500, { error: "restore failed" }));
        return;
      default:
        return send(response, 404, { error: "not found" });
    }
  });
}
