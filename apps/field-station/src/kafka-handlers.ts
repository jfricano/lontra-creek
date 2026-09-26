/**
 * Gateway handlers for the field station on Kafka: production, and a local broker.
 * `streamotter start` loads JavaScript only, so these are compiled first:
 *
 *   npm run build -w @lontra-creek/field-station
 *   NODE_ENV=production npx streamotter start --config streamotter.production.json --handlers dist/kafka-handlers.js
 *
 * Records come from the field station's runner (src/server), one per changed view or
 * notebook, each naming its channel, so every channel's map picks out its own.
 * Snapshots come from the field station's internal API, which serves what the runner
 * publishes from. The runner updates that state before it publishes, so a snapshot is
 * never older than an update already on Kafka.
 *
 * Environment: FIELD_STATION_SECRET and FIELD_STATION_SERVICE_TOKEN (both required in
 * production), FIELD_STATION_INTERNAL_URL (default http://127.0.0.1:7410).
 */
import type { ChannelHandlers, HandlerRegistry } from "streamotter/gateway";
import { mayRead } from "./access.ts";
import type { AppChannels } from "./generated/streamotter.generated.ts";
import { fieldStationSecret, serviceToken, verifyToken } from "./identity.ts";
import { fromRecord, topicFor, viewPath } from "./records.ts";

export interface KafkaHandlerOptions {
  /** Verifies visitors' badges. */
  secret: string;
  /** Presented to the field station's internal API. */
  serviceToken: string;
  /** The internal API's origin, such as http://field-station:7410. */
  internalOrigin: string;
  fetch?: typeof fetch;
}

export function kafkaHandlerOptions(env: NodeJS.ProcessEnv = process.env): KafkaHandlerOptions {
  return {
    secret: fieldStationSecret(env),
    serviceToken: serviceToken(env),
    internalOrigin: new URL(env["FIELD_STATION_INTERNAL_URL"] ?? "http://127.0.0.1:7410").origin
  };
}

export function createKafkaHandlers(options: KafkaHandlerOptions): HandlerRegistry<AppChannels> {
  const request = options.fetch ?? fetch;

  function channel<K extends keyof AppChannels>(name: K): ChannelHandlers<AppChannels[K]> {
    type Contract = AppChannels[K];
    return {
      authorize: ({ principal, params }) => mayRead(name, principal, params),

      map: ({ record }) => {
        const field = fromRecord(record.value);
        // Never skip what can't be read: throwing pauses the source at this record.
        if (field === null) throw new Error(`Record ${record.id} is not a field station record.`);
        // One channel instance, one topic and key, so its changes stay in order on one partition.
        if (record.position.kind === "kafka" && record.position.topic !== topicFor(field.channel)) {
          throw new Error(`Record ${record.id} is a ${field.channel} view on ${record.position.topic}; expected ${topicFor(field.channel)}.`);
        }
        if (field.channel !== name) return [];
        return [{ tenantId: field.tenantId, params: field.params as Contract["params"], revision: field.revision, data: field.data as Contract["data"] }];
      },

      snapshot: async ({ params, signal }) => {
        const response = await request(`${options.internalOrigin}${viewPath(name, params)}`, {
          headers: { authorization: `Bearer ${options.serviceToken}` },
          signal
        });
        if (!response.ok) throw new Error(`The field station answered ${response.status} for a ${name} snapshot.`);
        const body = await response.json() as { revision?: unknown; data?: unknown };
        if (typeof body.revision !== "string" || body.data === undefined) throw new Error(`The field station sent a malformed ${name} snapshot.`);
        return { revision: body.revision, data: body.data as Contract["data"] };
      }
    };
  }

  return {
    authenticate: ({ token }) => verifyToken(token, options.secret),
    channels: {
      creekOverview: channel("creekOverview"),
      station: channel("station"),
      otter: channel("otter"),
      reach: channel("reach"),
      holt: channel("holt"),
      notebook: channel("notebook")
    }
  };
}

export const handlers = createKafkaHandlers(kafkaHandlerOptions());
