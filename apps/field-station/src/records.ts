/**
 * The record the field station publishes for every changed view, to Kafka or as a
 * development fixture. It names its channel and parameters explicitly, so one map
 * handler per channel can pick out its own records from the shared source.
 */
import { TENANT_ID, TOPICS, type ChannelName, type Emission } from "@lontra-creek/sim";
import type { Json } from "streamotter/contracts";

/** The simulation's channels, and visitors' notebooks. */
export type RecordChannel = ChannelName | "notebook";

export const NOTEBOOK_TOPIC = "field.notebooks";

export interface FieldRecord {
  tenantId: string;
  channel: RecordChannel;
  params: Record<string, string>;
  revision: string;
  data: Json;
}

const CHANNEL_NAMES: ReadonlySet<string> = new Set<RecordChannel>(["creekOverview", "station", "otter", "reach", "holt", "notebook"]);

/** The topic each channel's records are published to, one topic per channel. */
export function topicFor(channel: RecordChannel): string {
  return channel === "notebook" ? NOTEBOOK_TOPIC : TOPICS[channel];
}

export function toRecord(emission: Emission): { key: string; value: FieldRecord } {
  return {
    key: emission.key,
    value: {
      tenantId: TENANT_ID,
      channel: emission.channel,
      params: { ...emission.params },
      revision: emission.revision,
      data: emission.data as unknown as Json
    }
  };
}

/**
 * Reads a record's value, or returns null when it isn't a field record. The gateway
 * still validates the data against the channel's schema before admitting it.
 */
export function fromRecord(value: Json): FieldRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { tenantId, channel, params, revision, data } = value as Record<string, Json>;
  if (typeof tenantId !== "string" || typeof channel !== "string" || !CHANNEL_NAMES.has(channel) || typeof revision !== "string") return null;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  if (!Object.values(params).every(entry => typeof entry === "string")) return null;
  if (data === undefined) return null;
  return { tenantId, channel: channel as RecordChannel, params: params as Record<string, string>, revision, data };
}

/** The key of one channel instance: its channel and its (single) parameter value. */
export function instanceKey(channel: RecordChannel, params: Readonly<Record<string, string | number | boolean>>): string {
  return `${channel}:${Object.values(params).join(",")}`;
}

/** Where the field station's internal API serves one channel instance's current view. */
export function viewPath(channel: RecordChannel, params: Readonly<Record<string, string | number | boolean>>): string {
  return `/internal/views/${channel}/${encodeURIComponent(Object.values(params).join(","))}`;
}
