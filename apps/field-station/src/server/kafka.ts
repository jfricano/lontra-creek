/**
 * Publishing to Kafka with KafkaJS 2.2.4, the client StreamOtter's gateway uses.
 *
 * The producer is idempotent with one request in flight, and every send waits for
 * all in-sync replicas (acks -1), so a view is only dropped from the station's
 * queue once it is durably on the topic. Records are keyed by channel instance,
 * which keeps each instance on one partition and its changes in order.
 *
 * Topics are created when missing (the broker doesn't auto-create them): three
 * partitions, a single replica, and six hours of retention, since the channels are
 * full state and snapshots come from the station.
 */
import { readFile } from "node:fs/promises";
import { Kafka, logLevel, Partitioners, type Admin, type Producer, type SASLOptions } from "kafkajs";
import { TOPICS } from "@lontra-creek/sim";
import type { KafkaSettings } from "./config.ts";
import type { OutgoingRecord, Publisher } from "./station.ts";

export const FIELD_TOPICS: readonly string[] = [...new Set(Object.values(TOPICS))];
const PARTITIONS = 3;
const RETENTION_MS = 6 * 60 * 60 * 1_000;

export async function createKafkaPublisher(settings: KafkaSettings, log: (message: string) => void): Promise<Publisher> {
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

  let producer: Producer | null = null;
  let connecting: Promise<Producer> | null = null;

  async function ensureTopics(admin: Admin): Promise<void> {
    const existing = new Set(await admin.listTopics());
    const missing = FIELD_TOPICS.filter(topic => !existing.has(topic));
    if (missing.length === 0) return;
    await admin.createTopics({
      waitForLeaders: true,
      topics: missing.map(topic => ({
        topic,
        numPartitions: PARTITIONS,
        replicationFactor: 1,
        configEntries: [{ name: "retention.ms", value: String(RETENTION_MS) }]
      }))
    });
    log(`Created Kafka topics: ${missing.join(", ")}.`);
  }

  async function connect(): Promise<Producer> {
    const admin = kafka.admin();
    await admin.connect();
    try {
      await ensureTopics(admin);
    } finally {
      await admin.disconnect();
    }
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

  return {
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
}
