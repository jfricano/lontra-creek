/**
 * Kafka with KafkaJS 2.2.4, the client StreamOtter's gateway uses.
 *
 * Publishing. The producer is idempotent with one request in flight, and every
 * send waits for all in-sync replicas (acks -1), so a record leaves the queue only
 * once it is durably on its topic. Records are keyed by channel instance, which
 * keeps each instance on one partition and its changes in order.
 *
 * Topics are created when missing (the broker doesn't auto-create them), with three
 * partitions and a single replica. The world's topics keep six hours, since their
 * channels are full state and snapshots come from the field station. Notebooks are
 * compacted (the latest record per observer) and also deleted after
 * NOTEBOOK_RETENTION_MS, which is how expired notebooks leave without tombstones.
 *
 * Reading. At startup the field station reads field.notebooks from the beginning,
 * with a throwaway consumer group, to rebuild notebooks.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Kafka, logLevel, Partitioners, type Admin, type ITopicConfig, type Producer, type SASLOptions } from "kafkajs";
import { TOPICS } from "@lontra-creek/sim";
import { NOTEBOOK_TOPIC } from "../records.ts";
import type { KafkaSettings } from "./config.ts";
import { NOTEBOOK_RETENTION_MS } from "./notebooks.ts";
import type { OutgoingRecord, Publisher } from "./queue.ts";

const PARTITIONS = 3;
const WORLD_RETENTION_MS = 6 * 60 * 60 * 1_000;
const READ_TIMEOUT_MS = 60_000;

export const TOPIC_CONFIGS: readonly ITopicConfig[] = [
  ...[...new Set(Object.values(TOPICS))].map(topic => ({
    topic,
    numPartitions: PARTITIONS,
    replicationFactor: 1,
    configEntries: [{ name: "retention.ms", value: String(WORLD_RETENTION_MS) }]
  })),
  {
    topic: NOTEBOOK_TOPIC,
    numPartitions: PARTITIONS,
    replicationFactor: 1,
    configEntries: [
      { name: "cleanup.policy", value: "compact,delete" },
      { name: "retention.ms", value: String(NOTEBOOK_RETENTION_MS) },
      // Short segments, so retention and compaction reach records soon after they age.
      { name: "segment.ms", value: String(10 * 60 * 1_000) }
    ]
  }
];

export interface KafkaIO {
  publisher: Publisher;
  /** Every record value on a topic, from the beginning up to its end when called. */
  readAll(topic: string): Promise<(string | null)[]>;
}

export async function connectKafka(settings: KafkaSettings, log: (message: string) => void): Promise<KafkaIO> {
  const ssl = settings.caFile === null ? false : { ca: [await readFile(settings.caFile, "utf8")] };
  const sasl: SASLOptions | undefined = settings.sasl === null
    ? undefined
    : { mechanism: "scram-sha-512", username: settings.sasl.username, password: settings.sasl.password };
  const kafka = new Kafka({
    clientId: "lontra-creek-field-station",
    brokers: settings.brokers,
    ssl,
    ...(sasl === undefined ? {} : { sasl }),
    connectionTimeout: 5_000,
    logLevel: logLevel.NOTHING,
    retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 5_000 }
  });

  async function ensureTopics(admin: Admin): Promise<void> {
    const existing = new Set(await admin.listTopics());
    const missing = TOPIC_CONFIGS.filter(config => !existing.has(config.topic));
    if (missing.length === 0) return;
    // False when another call created them first.
    if (await admin.createTopics({ waitForLeaders: true, topics: [...missing] })) {
      log(`Created Kafka topics: ${missing.map(config => config.topic).join(", ")}.`);
    }
  }

  async function withAdmin<T>(use: (admin: Admin) => Promise<T>): Promise<T> {
    const admin = kafka.admin();
    await admin.connect();
    try {
      await ensureTopics(admin);
      return await use(admin);
    } finally {
      await admin.disconnect();
    }
  }

  let producer: Producer | null = null;
  let connecting: Promise<Producer> | null = null;

  async function connect(): Promise<Producer> {
    await withAdmin(async () => undefined);
    const created = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner
    });
    await created.connect();
    log(`Connected to Kafka at ${settings.brokers.join(", ")}${settings.caFile === null ? " (plaintext)" : " over TLS"}.`);
    return created;
  }

  const publisher: Publisher = {
    async publish(records: readonly OutgoingRecord[]): Promise<void> {
      if (producer === null) {
        connecting ??= connect().finally(() => { connecting = null; });
        producer = await connecting;
      }
      const byTopic = new Map<string, { key: string; value: string }[]>();
      for (const record of records) {
        const messages = byTopic.get(record.topic) ?? [];
        messages.push({ key: record.key, value: record.value });
        byTopic.set(record.topic, messages);
      }
      try {
        await producer.sendBatch({ acks: -1, topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })) });
      } catch (error) {
        // Start over with a fresh connection next time.
        const failed = producer;
        producer = null;
        await failed.disconnect().catch(() => undefined);
        throw error;
      }
    },
    async close(): Promise<void> {
      await producer?.disconnect();
      producer = null;
    }
  };

  async function readAll(topic: string): Promise<(string | null)[]> {
    return withAdmin(async admin => {
      // Where each partition ends now. Anything later was written by this process.
      const ends = new Map<number, bigint>();
      for (const { partition, high, low } of await admin.fetchTopicOffsets(topic)) {
        if (BigInt(high) > BigInt(low)) ends.set(partition, BigInt(high));
      }
      if (ends.size === 0) return [];
      const groupId = `lontra-field-station-read-${randomUUID()}`;
      const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false });
      const values: (string | null)[] = [];
      await consumer.connect();
      try {
        await consumer.subscribe({ topics: [topic], fromBeginning: true });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Reading ${topic} took longer than ${READ_TIMEOUT_MS / 1_000} s.`)), READ_TIMEOUT_MS);
          consumer.run({
            autoCommit: false,
            eachMessage: async ({ partition, message }) => {
              const end = ends.get(partition);
              if (end === undefined) return;
              values.push(message.value === null ? null : message.value.toString("utf8"));
              if (BigInt(message.offset) + 1n >= end) ends.delete(partition);
              if (ends.size === 0) {
                clearTimeout(timer);
                resolve();
              }
            }
          }).catch((error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        });
      } finally {
        await consumer.disconnect().catch(() => undefined);
        await admin.deleteGroups([groupId]).catch(() => undefined);
      }
      return values;
    });
  }

  return { publisher, readAll };
}
