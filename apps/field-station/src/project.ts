/**
 * The field station's StreamOtter project, defined once. `node scripts/configs.ts`
 * writes it out as the streamotter*.json files the CLI reads, one per environment,
 * since hosts, origins, and connections differ between them while channels and
 * schemas don't.
 * Enumerations come from the simulation's own geography, so the schemas can't
 * drift from what the simulation publishes.
 */
import {
  CAMERAS, HOLTS, OTTERS, REACHES, STATIONS, TOPICS, WATERSHED_ID,
  type ChannelName
} from "@lontra-creek/sim";
import type { KafkaConnection, Limits, ProjectConfig, Schema, Source } from "streamotter/contracts";
import type { AppChannels } from "./generated/streamotter.generated.ts";

/**
 * fixture: no Kafka, for `npm run dev`. local-kafka: a plaintext broker on this
 * machine. production: the demo host's compose stack, Kafka over TLS with SCRAM.
 */
export type Environment = "fixture" | "local-kafka" | "production";

export const PROJECT_ID = "lontra-creek";
export const CHANNEL_VERSION = 1 as const;
export const SITE_ORIGIN = "https://streamotter.app";
const SITE_DEV_ORIGINS = ["http://localhost:4321", "http://127.0.0.1:4321"];

const RECEIVERS = REACHES.map(reach => reach.receiver);
const ACTIVITIES = ["denning", "resting", "foraging", "traveling", "grooming", "playing"];
const SPECIES = ["river otter", "American beaver", "great blue heron", "American mink", "raccoon", "white-tailed deer", "belted kingfisher"];
const TRENDS = ["rising", "falling", "steady"];
const WEATHER = ["clear", "rain", "storm"];
const OTTER_NAMES = OTTERS.map(otter => otter.name);

const text = (maxLength: number): Schema => ({ type: "string", maxLength });
const oneOf = (values: readonly string[]): Schema => ({ type: "string", enum: values });
const integer = (minimum: number, maximum: number): Schema => ({ type: "integer", minimum, maximum });
const number = (minimum: number, maximum: number): Schema => ({ type: "number", minimum, maximum });
function object(properties: Record<string, Schema>): Schema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

/** A study time; day 0 and "--:--" mean "never". */
const studyStamp = object({ day: integer(0, 1_000_000), time: text(5) });
const publicReach = oneOf([...REACHES.map(reach => reach.id), "withheld", "outside"]);
const publicActivity = oneOf([...ACTIVITIES, "away"]);

const SCHEMAS: Record<string, Schema> = {
  WatershedParams: object({ watershed: oneOf([WATERSHED_ID]) }),
  StationParams: object({ stationId: oneOf(STATIONS.map(station => station.id)) }),
  OtterParams: object({ otterId: oneOf(OTTERS.map(otter => otter.id)) }),
  ReachParams: object({ reachId: oneOf(CAMERAS.map(camera => camera.reach)) }),
  HoltParams: object({ holtId: oneOf(HOLTS.map(holt => holt.id)) }),

  CreekOverview: object({
    watershed: oneOf([WATERSHED_ID]),
    observed: studyStamp,
    daylight: oneOf(["dawn", "day", "dusk", "night"]),
    weather: oneOf(WEATHER),
    stations: {
      type: "array",
      maxItems: STATIONS.length,
      items: object({ stationId: oneOf(STATIONS.map(station => station.id)), name: text(40), flowCfs: number(0, 100_000), trend: oneOf(TRENDS) })
    },
    otters: {
      type: "array",
      maxItems: OTTERS.length,
      items: object({ otterId: oneOf(OTTERS.map(otter => otter.id)), name: oneOf(OTTER_NAMES), reachId: publicReach, activity: publicActivity })
    }
  }),
  GaugeReading: object({
    stationId: oneOf(STATIONS.map(station => station.id)),
    name: text(40),
    reachId: oneOf(REACHES.map(reach => reach.id)),
    observed: studyStamp,
    stageFt: number(0, 40),
    flowCfs: number(0, 100_000),
    waterTempC: number(-5, 40),
    dissolvedOxygenMgL: number(0, 25),
    turbidityNtu: number(0, 5_000),
    trend: oneOf(TRENDS),
    weather: oneOf(WEATHER)
  }),
  OtterStatus: object({
    otterId: oneOf(OTTERS.map(otter => otter.id)),
    name: oneOf(OTTER_NAMES),
    sex: oneOf(["female", "male"]),
    ageClass: oneOf(["adult", "yearling"]),
    status: oneOf(["in-watershed", "left-watershed"]),
    reachId: publicReach,
    reachName: text(60),
    activity: publicActivity,
    divesThisHour: integer(0, 10_000),
    lastDetection: object({ at: studyStamp, receiver: oneOf([...RECEIVERS, "withheld", "none"]) }),
    note: text(120)
  }),
  CameraTrap: object({
    reachId: oneOf(CAMERAS.map(camera => camera.reach)),
    name: text(60),
    cameraId: oneOf(CAMERAS.map(camera => camera.id)),
    lastFrame: object({ frame: text(16), at: studyStamp, species: oneOf([...SPECIES, "none"]), count: integer(0, 50) }),
    framesToday: integer(0, 100_000),
    otterFramesToday: integer(0, 100_000)
  }),
  HoltStatus: object({
    holtId: oneOf(HOLTS.map(holt => holt.id)),
    name: text(40),
    reachId: oneOf(REACHES.map(reach => reach.id)),
    gridRef: text(20),
    occupied: { type: "boolean" },
    occupants: {
      type: "array",
      maxItems: 8,
      items: oneOf(OTTERS.flatMap(otter => [otter.name, ...otter.pups]))
    },
    lastEntry: studyStamp,
    lastExit: studyStamp
  })
};

const CHANNELS: Record<ChannelName, { paramsSchema: string; payloadSchema: string }> = {
  creekOverview: { paramsSchema: "WatershedParams", payloadSchema: "CreekOverview" },
  station: { paramsSchema: "StationParams", payloadSchema: "GaugeReading" },
  otter: { paramsSchema: "OtterParams", payloadSchema: "OtterStatus" },
  reach: { paramsSchema: "ReachParams", payloadSchema: "CameraTrap" },
  holt: { paramsSchema: "HoltParams", payloadSchema: "HoltStatus" }
};

const LOCAL_KAFKA: KafkaConnection = { brokers: ["127.0.0.1:19092"], tls: false };

/** The broker in the demo host's compose stack; see deploy/compose.yaml. */
const PRODUCTION_KAFKA: KafkaConnection = {
  brokers: ["kafka:9094"],
  tls: { caFile: "/etc/lontra/kafka/ca.pem" },
  sasl: { mechanism: "scram-sha-512", username: { env: "KAFKA_GATEWAY_USERNAME" }, password: { env: "KAFKA_GATEWAY_PASSWORD" } }
};

/**
 * Starting bounds for the hosted demo (docs/PLAN.md, Limits and operations): one
 * connection per open page, and no page needs more than a dozen views. They are
 * to be measured on the real host before launch, not published as capacity.
 */
const HOSTED_LIMITS: Partial<Limits> = { maxConnections: 300, maxSubscriptionsPerConnection: 12 };

function fieldSource(environment: Environment): Source {
  if (environment === "fixture") return { kind: "fixture", generation: "field-fixture-1", fixtureRef: "field" };
  return {
    kind: "kafka",
    generation: environment === "production" ? "field-prod-1" : "field-local-1",
    connectionRef: "field",
    topics: [...new Set(Object.values(TOPICS))],
    consumerGroup: "streamotter-lontra-creek-field",
    codec: "json",
    // Snapshots come from the field station, so a new consumer group needs only what follows.
    startFrom: "latest"
  };
}

function gateway(environment: Environment): ProjectConfig["gateway"] {
  const path = "/streamotter/socket.io";
  // In production the gateway listens on the compose network; only Caddy publishes a port.
  if (environment === "production") return { host: "0.0.0.0", port: 7400, path, allowedOrigins: [SITE_ORIGIN] };
  return { host: "127.0.0.1", port: 7400, path, allowedOrigins: SITE_DEV_ORIGINS };
}

function connections(environment: Environment): Record<string, KafkaConnection> {
  switch (environment) {
    case "fixture":
      return {};
    case "local-kafka":
      return { field: LOCAL_KAFKA };
    case "production":
      return { field: PRODUCTION_KAFKA };
  }
}

function channel<K extends ChannelName>(name: K) {
  return {
    version: CHANNEL_VERSION,
    source: "field",
    ...CHANNELS[name],
    handlersRef: name,
    delivery: { kind: "state", overflow: "resync" }
  } as const;
}

export function projectConfig(environment: Environment): ProjectConfig<AppChannels> {
  return {
    configVersion: 1,
    projectId: PROJECT_ID,
    gateway: gateway(environment),
    connections: connections(environment),
    sources: { field: fieldSource(environment) },
    schemas: SCHEMAS,
    channels: {
      creekOverview: channel("creekOverview"),
      station: channel("station"),
      otter: channel("otter"),
      reach: channel("reach"),
      holt: channel("holt")
    },
    ...(environment === "fixture" ? {} : { limits: HOSTED_LIMITS })
  };
}

/** Where each environment's configuration file lives, relative to the app. */
export const CONFIG_FILES: Readonly<Record<Environment, string>> = {
  fixture: "streamotter.fixture.json",
  "local-kafka": "streamotter.json",
  production: "streamotter.production.json"
};

export function payloadSchema(channel: ChannelName): Schema {
  return SCHEMAS[CHANNELS[channel].payloadSchema]!;
}

export function paramsSchema(channel: ChannelName): Schema {
  return SCHEMAS[CHANNELS[channel].paramsSchema]!;
}
