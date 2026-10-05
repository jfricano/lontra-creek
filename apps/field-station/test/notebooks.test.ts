import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateValue, type Json, type SourceRecord } from "streamotter/contracts";
import { createKafkaHandlers } from "../src/kafka-handlers.ts";
import { projectConfig } from "../src/project.ts";
import { MAX_OPEN_NOTEBOOKS_PER_CLIENT, NotebookError, Notebooks, NOTEBOOK_RETENTION_MS, parseSighting, type Sighting } from "../src/server/notebooks.ts";
import { PublishQueue, type OutgoingRecord, type Publisher } from "../src/server/queue.ts";

class Recorder implements Publisher {
  readonly records: OutgoingRecord[] = [];
  async publish(records: readonly OutgoingRecord[]): Promise<void> {
    this.records.push(...records);
  }
  async close(): Promise<void> {}
  latest(observerId: string): { revision: string; data: { status: string; entries: unknown[] }; expiresAt: string } {
    const record = this.records.filter(candidate => candidate.key === `notebook:${observerId}`).at(-1);
    assert.ok(record !== undefined, `a record for ${observerId}`);
    return JSON.parse(record.value) as { revision: string; data: { status: string; entries: unknown[] }; expiresAt: string };
  }
}

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const SESSION_ENDS = T0 + 30 * 60 * 1_000;
const pebble: Sighting = { otterId: "LO-07", reachId: "kestrel-bend", activity: "foraging" };
const at = { day: 3, time: "06:15" };

function setup(startAt = T0): { notebooks: Notebooks; queue: PublishQueue; recorder: Recorder; clock: { now: number } } {
  const clock = { now: startAt };
  const recorder = new Recorder();
  const queue = new PublishQueue(recorder, () => undefined);
  const notebooks = new Notebooks({ queue, tenantId: "lontra-creek", now: () => clock.now, log: () => undefined });
  return { notebooks, queue, recorder, clock };
}

function refusal(status: number): (error: unknown) => boolean {
  return error => error instanceof NotebookError && error.status === status;
}

describe("notebooks", () => {
  test("only choices from the lists are sightings; dens and free text are not", () => {
    assert.deepEqual(parseSighting({ ...pebble }), pebble);
    assert.equal(parseSighting({ ...pebble, activity: "denning" }), null);
    assert.equal(parseSighting({ ...pebble, otterId: "Pebble at the bridge" }), null);
    assert.equal(parseSighting({ ...pebble, reachId: "my-backyard" }), null);
    assert.equal(parseSighting({ otterId: "untagged", reachId: "confluence", activity: "playing" })?.otterId, "untagged");
  });

  test("nothing is written until notebooks are loaded from the topic", () => {
    const { notebooks } = setup();
    assert.throws(() => notebooks.add("volunteer-aaaa1111", SESSION_ENDS, pebble, at), refusal(503));
  });

  test("one client address can't hold more than its share of open notebooks", () => {
    const { notebooks, clock } = setup();
    notebooks.load([]);
    for (let i = 0; i < MAX_OPEN_NOTEBOOKS_PER_CLIENT; i++) notebooks.add(`volunteer-${i}`, SESSION_ENDS, pebble, at, "2001:db8:7:9::/64");
    assert.throws(() => notebooks.add("volunteer-next", SESSION_ENDS, pebble, at, "2001:db8:7:9::/64"), refusal(429));
    notebooks.add("volunteer-elsewhere", SESSION_ENDS, pebble, at, "203.0.113.9");
    clock.now += 1_000;
    notebooks.add("volunteer-0", SESSION_ENDS, pebble, { day: 3, time: "06:16" }, "2001:db8:7:9::/64"); // an open notebook keeps taking sightings
    clock.now = SESSION_ENDS;
    notebooks.expire();
    notebooks.add("volunteer-later", SESSION_ENDS + 60_000, pebble, at, "2001:db8:7:9::/64"); // closed notebooks free the share
  });

  test("an unknown notebook is empty and open at revision 0", () => {
    const { notebooks } = setup();
    assert.deepEqual(notebooks.view("volunteer-aaaa1111"), { revision: "0", data: { observerId: "volunteer-aaaa1111", status: "open", entries: [] } });
  });

  test("a sighting is served, then published, with the write time as its revision", async () => {
    const { notebooks, queue, recorder } = setup();
    notebooks.load([]);
    const result = notebooks.add("volunteer-aaaa1111", SESSION_ENDS, pebble, at);
    assert.deepEqual(result, { revision: String(T0), entries: 1 });
    assert.deepEqual(notebooks.view("volunteer-aaaa1111").data.entries, [{ at, ...pebble }]);
    assert.equal(recorder.records.length, 0, "queued, not yet sent");
    await queue.flush();
    const published = recorder.latest("volunteer-aaaa1111");
    assert.equal(published.revision, String(T0));
    assert.equal(published.expiresAt, new Date(SESSION_ENDS).toISOString());
  });

  test("one sighting a second, and the latest twenty", () => {
    const { notebooks, clock } = setup();
    notebooks.load([]);
    notebooks.add("volunteer-aaaa1111", SESSION_ENDS, pebble, at);
    clock.now += 999;
    assert.throws(() => notebooks.add("volunteer-aaaa1111", SESSION_ENDS, pebble, at), refusal(429));
    for (let i = 1; i <= 21; i++) {
      clock.now += 1_000;
      notebooks.add("volunteer-aaaa1111", SESSION_ENDS, { ...pebble, activity: i === 21 ? "playing" : "resting" }, { day: 3, time: String(i).padStart(5, "0") });
    }
    const entries = notebooks.view("volunteer-aaaa1111").data.entries;
    assert.equal(entries.length, 20);
    assert.equal(entries.at(-1)?.activity, "playing");
    assert.equal(entries[0]?.at.time, "00002", "the oldest entries go first");
  });

  test("when the session ends, the notebook is published once more, expired and empty", async () => {
    const { notebooks, queue, recorder, clock } = setup();
    notebooks.load([]);
    const { revision } = notebooks.add("volunteer-aaaa1111", SESSION_ENDS, pebble, at);
    clock.now = SESSION_ENDS - 1;
    assert.equal(notebooks.expire(), 0);
    clock.now = SESSION_ENDS;
    assert.equal(notebooks.expire(), 1);
    await queue.flush();
    const closed = recorder.latest("volunteer-aaaa1111");
    assert.deepEqual(closed.data, { observerId: "volunteer-aaaa1111", status: "expired", entries: [] });
    assert.ok(BigInt(closed.revision) > BigInt(revision));
    assert.ok(recorder.records.every(record => record.value !== null), "no tombstones");
    assert.throws(() => notebooks.add("volunteer-aaaa1111", SESSION_ENDS, pebble, at), refusal(410));
    // Kept for snapshots while the topic still has it, then forgotten.
    clock.now = SESSION_ENDS + NOTEBOOK_RETENTION_MS + 1;
    notebooks.expire();
    assert.equal(notebooks.view("volunteer-aaaa1111").revision, "0");
  });

  test("revisions keep rising even when a write lands in the same millisecond", () => {
    const { notebooks, clock } = setup();
    notebooks.load([]);
    const { revision } = notebooks.add("volunteer-aaaa1111", T0, pebble, at);
    assert.equal(notebooks.expire(), 1, "the session ended at this very millisecond");
    assert.equal(BigInt(notebooks.view("volunteer-aaaa1111").revision), BigInt(revision) + 1n);
    assert.equal(clock.now, T0);
  });

  test("a restart rebuilds each notebook at its highest revision and closes those whose session ended", async () => {
    const before = setup();
    before.notebooks.load([]);
    before.notebooks.add("volunteer-aaaa1111", SESSION_ENDS, pebble, at);
    before.clock.now += 5_000;
    before.notebooks.add("volunteer-aaaa1111", SESSION_ENDS, { ...pebble, activity: "grooming" }, at);
    before.notebooks.add("volunteer-bbbb2222", T0 + 10_000, pebble, at);
    await before.queue.flush();
    const onTopic = before.recorder.records.map(record => record.value);

    const after = setup(T0 + 60_000);
    after.notebooks.load([...onTopic.reverse(), "not json", null]);
    assert.equal(after.notebooks.ready, true);
    const kept = after.notebooks.view("volunteer-aaaa1111");
    assert.equal(kept.revision, String(T0 + 5_000));
    assert.equal(kept.data.entries.length, 2);
    assert.equal(after.notebooks.view("volunteer-bbbb2222").data.status, "expired");
    // A new write after the restart still outranks everything before it.
    const { revision } = after.notebooks.add("volunteer-aaaa1111", SESSION_ENDS, pebble, at);
    assert.ok(BigInt(revision) > BigInt(kept.revision));
  });

  test("a published notebook fits the channel's schema and the gateway's map handler", async () => {
    const { notebooks, queue, recorder } = setup();
    notebooks.load([]);
    notebooks.add("volunteer-aaaa1111", SESSION_ENDS, pebble, at);
    await queue.flush();
    const record = recorder.records.at(-1)!;
    const value = JSON.parse(record.value) as Json;
    const handlers = createKafkaHandlers({ secret: "s".repeat(32), serviceToken: "t".repeat(32), internalOrigin: "http://field-station:7410" });
    const source: SourceRecord = {
      id: "field.notebooks/0/0", sourceId: "notebooks", key: record.key, value, receivedAt: new Date().toISOString(),
      position: { kind: "kafka", topic: record.topic, partition: 0, offset: "0" }
    };
    const [mapped] = await handlers.channels.notebook.map({ requestId: "test", signal: new AbortController().signal, record: source });
    assert.deepEqual(mapped?.params, { observerId: "volunteer-aaaa1111" });
    assert.equal(mapped?.revision, String(T0));
    assert.equal(validateValue(projectConfig("production").schemas["Notebook"]!, mapped!.data as unknown as Json), null);
    assert.equal(validateValue(projectConfig("production").schemas["Notebook"]!, notebooks.view("nobody-12345678").data as unknown as Json), null);
  });
});
