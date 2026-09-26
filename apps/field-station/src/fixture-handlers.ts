/**
 * Gateway handlers for running without Kafka:
 *   npx streamotter dev --config streamotter.fixture.json --handlers src/fixture-handlers.ts
 *
 * The fixture is the start of the Lontra Creek simulation (two study days, or
 * FIELD_FIXTURE_DAYS), recorded as the records the field station would publish.
 * Advance it from the workbench, or run `npm run dev`, which advances one tick
 * every two seconds.
 * With no field station process to ask, snapshots come from a read model fed by
 * the same records, so snapshots and updates describe one revision progression.
 */
import { createWorld, currentEmissions, step, TENANT_ID, TICKS_PER_DAY, type ChannelName } from "@lontra-creek/sim";
import type { ChannelHandlers, DevelopmentOptions, HandlerRegistry, Json, Principal } from "streamotter/gateway";
import type { AppChannels } from "./generated/streamotter.generated.ts";
import { fieldStationSecret, isResearcher, verifyToken } from "./identity.ts";
import { fromRecord, instanceKey, toRecord, type FieldRecord } from "./records.ts";

const days = Number(process.env["FIELD_FIXTURE_DAYS"] ?? "2");
if (!Number.isInteger(days) || days < 1 || days > 30) throw new RangeError("FIELD_FIXTURE_DAYS must be an integer from 1 to 30");
export const FIXTURE_TICKS = days * TICKS_PER_DAY;
/** How many records each tick added to the fixture, in order; advancing by these replays one tick at a time. */
export const fixtureTickSizes: number[] = [];

const world = createWorld({ seed: "lontra-creek" });
const readModel = new Map<string, FieldRecord>(currentEmissions(world).map(emission => [emission.key, toRecord(emission).value]));
const fixture: { key: string; value: Json }[] = [];
while (world.tick < FIXTURE_TICKS) {
  const emissions = step(world);
  for (const emission of emissions) {
    const record = toRecord(emission);
    fixture.push({ key: record.key, value: record.value as unknown as Json });
  }
  fixtureTickSizes.push(emissions.length);
}

function apply(record: FieldRecord): void {
  const key = instanceKey(record.channel, record.params);
  const current = readModel.get(key);
  if (current === undefined || BigInt(record.revision) > BigInt(current.revision)) readModel.set(key, record);
}

/** Den sites are for researchers; everything else is open to any signed-in visitor. */
export function mayRead(channel: ChannelName, principal: Principal): boolean {
  return channel !== "holt" || isResearcher(principal);
}

function channel<K extends ChannelName>(name: K): ChannelHandlers<AppChannels[K]> {
  type Contract = AppChannels[K];
  return {
    authorize: ({ principal }) => mayRead(name, principal),
    map: ({ record }) => {
      const field = fromRecord(record.value);
      if (field === null || field.channel !== name) return [];
      apply(field);
      return [{ tenantId: field.tenantId, params: field.params as Contract["params"], revision: field.revision, data: field.data as Contract["data"] }];
    },
    snapshot: ({ params }) => {
      const current = readModel.get(instanceKey(name, params));
      if (current === undefined) throw new Error(`No ${name} instance ${JSON.stringify(params)}`);
      return { revision: current.revision, data: current.data as Contract["data"] };
    }
  };
}

const secret = fieldStationSecret();

export const handlers: HandlerRegistry<AppChannels> = {
  authenticate: ({ token }) => verifyToken(token, secret),
  channels: {
    creekOverview: channel("creekOverview"),
    station: channel("station"),
    otter: channel("otter"),
    reach: channel("reach"),
    holt: channel("holt")
  }
};

function devPrincipal(subject: string, role: "volunteer" | "researcher", name: string): Principal {
  return { subject, tenantId: TENANT_ID, sessionId: `dev-${subject}`, expiresAt: "2099-01-01T00:00:00.000Z", claims: { role, name } };
}

/** Development-only principals and fixtures; `streamotter start` never uses them. */
export const development: DevelopmentOptions = {
  principals: {
    volunteer: devPrincipal("volunteer-dev", "volunteer", "Volunteer"),
    researcher: devPrincipal("biologist-dev", "researcher", "Field biologist")
  },
  fixtures: { field: fixture }
};
