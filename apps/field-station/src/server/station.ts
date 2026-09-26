/**
 * The field station's world on the wall clock, and the only writer to Kafka.
 *
 * Time. Tick n happens at epoch + n × tickMs, so a restarted station computes the
 * same world and carries on where it should be. The simulation is deterministic,
 * so recomputing a tick reproduces the data already published for it.
 *
 * Write, then publish. Each tick advances the world that the internal API serves
 * snapshots from, then publishes the views that changed. A snapshot is therefore
 * never older than anything already on Kafka. Views waiting to be published are
 * kept by instance, so while Kafka is away only the latest state of each one
 * waits: correct for full-state channels. One batch is in flight at a time, and a
 * view leaves the queue only when the broker has acknowledged it.
 *
 * Checkpoints. The world is plain JSON, written hourly (write, then rename), after
 * catching up at startup, and at shutdown. A checkpoint is used only if it belongs
 * to the same seed, generation, epoch, and tick length; otherwise the world is
 * recomputed from its seed.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  advanceTo, createWorld, currentEmissions, restore, seedFrom, studyTime,
  type Emission, type WorldState
} from "@lontra-creek/sim";
import { toRecord } from "../records.ts";

export const SEED = "lontra-creek";
const CHECKPOINT_FORMAT = 1;
const CHECKPOINT_FILE = "world.json";
const CHECKPOINT_EVERY_MS = 60 * 60 * 1_000;
/** Ticks computed per slice while catching up, so the process stays responsive. */
const CATCH_UP_SLICE = 2_000;

export interface OutgoingRecord {
  topic: string;
  key: string;
  value: string;
}

/** Where views go. publish resolves once the broker has acknowledged every record. */
export interface Publisher {
  publish(records: readonly OutgoingRecord[]): Promise<void>;
  close(): Promise<void>;
}

export interface StationOptions {
  publisher: Publisher;
  dataDir: string;
  /** Null: the checkpoint's epoch if it has a usable one, otherwise now. */
  epoch: string | null;
  tickMs: number;
  generation: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface Checkpoint {
  format: typeof CHECKPOINT_FORMAT;
  epoch: string;
  tickMs: number;
  world: WorldState;
}

export class FieldStation {
  readonly #options: StationOptions;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  #epochMs = 0;
  #world: WorldState | null = null;
  /** Every channel instance's current view: what snapshots are served from. */
  readonly #views = new Map<string, Emission>();
  /** Views not yet acknowledged by the broker, latest per instance. */
  readonly #pending = new Map<string, Emission>();
  #flushing: Promise<void> | null = null;
  #kafkaHealthy = false;
  #lastKafkaError: string | null = null;
  #lastCheckpointAt = 0;
  #ready = false;

  constructor(options: StationOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (message => console.log(message));
  }

  get ready(): boolean {
    return this.#ready;
  }

  get kafkaHealthy(): boolean {
    return this.#kafkaHealthy;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get epoch(): string {
    return new Date(this.#epochMs).toISOString();
  }

  get tick(): number {
    return this.#world?.tick ?? 0;
  }

  get generation(): number {
    return this.#options.generation;
  }

  /** The tick the wall clock says the world should be at. */
  targetTick(at = this.#now()): number {
    return Math.max(0, Math.floor((at - this.#epochMs) / this.#options.tickMs));
  }

  /** When the next tick is due, in epoch milliseconds. */
  nextTickAt(): number {
    return this.#epochMs + (this.tick + 1) * this.#options.tickMs;
  }

  /** A channel instance's current view, or undefined. Only once caught up, so a snapshot is never behind Kafka. */
  view(key: string): Emission | undefined {
    return this.#ready ? this.#views.get(key) : undefined;
  }

  status(): { tick: number; studyDay: number; studyTime: string; generation: number; kafka: "connected" | "unavailable"; pending: number } {
    const time = studyTime(this.tick);
    return { tick: this.tick, studyDay: time.day, studyTime: time.clock, generation: this.generation, kafka: this.#kafkaHealthy ? "connected" : "unavailable", pending: this.#pending.size };
  }

  /**
   * Restores or creates the world, catches up to the wall clock, queues every
   * view for republishing (harmless duplicates for anything already on Kafka),
   * and writes a checkpoint.
   */
  async start(): Promise<void> {
    const checkpoint = await this.#readCheckpoint();
    const generation = this.#options.generation;
    const seed = seedFrom(SEED);
    const epoch = this.#options.epoch ?? checkpoint?.epoch ?? new Date(this.#now()).toISOString();
    this.#epochMs = Date.parse(epoch);

    let world: WorldState;
    const mismatch = checkpoint === null ? "none found"
      : checkpoint.world.seed !== seed ? "a different seed"
      : checkpoint.world.generation !== generation ? `generation ${checkpoint.world.generation}, not ${generation}`
      : checkpoint.epoch !== epoch ? `epoch ${checkpoint.epoch}, not ${epoch}`
      : checkpoint.tickMs !== this.#options.tickMs ? `${checkpoint.tickMs} ms ticks, not ${this.#options.tickMs}`
      : null;
    if (checkpoint !== null && mismatch === null) {
      world = checkpoint.world;
      this.#log(`Restored the checkpoint at tick ${world.tick}.`);
    } else {
      world = createWorld({ seed, generation });
      this.#log(`Starting the world from its seed (checkpoint: ${mismatch}).`);
    }

    // Catch up in slices. Only the latest state of each instance matters.
    const target = this.targetTick();
    while (world.tick < target) {
      advanceTo(world, Math.min(target, world.tick + CATCH_UP_SLICE));
      await new Promise(resolve => setImmediate(resolve));
    }
    this.#world = world;
    for (const emission of currentEmissions(world)) {
      this.#views.set(emission.key, emission);
      this.#pending.set(emission.key, emission);
    }
    this.#ready = true;
    this.#log(`At tick ${world.tick} (study day ${studyTime(world.tick).day}, ${studyTime(world.tick).clock}); republishing ${this.#pending.size} views.`);
    await this.checkpoint();
  }

  /** Advances to the wall clock's tick, then publishes what changed. */
  async advance(): Promise<void> {
    const world = this.#world;
    if (world === null) throw new Error("The station has not started.");
    for (const emission of advanceTo(world, this.targetTick())) {
      this.#views.set(emission.key, emission);
      this.#pending.set(emission.key, emission);
    }
    if (this.#now() - this.#lastCheckpointAt >= CHECKPOINT_EVERY_MS) await this.checkpoint();
    await this.flush();
  }

  /** Publishes the pending views, unless a batch is already in flight. */
  flush(): Promise<void> {
    if (this.#flushing !== null || this.#pending.size === 0) return this.#flushing ?? Promise.resolve();
    const batch = [...this.#pending.values()];
    const records = batch.map(emission => {
      const record = toRecord(emission);
      return { topic: emission.topic, key: record.key, value: JSON.stringify(record.value) };
    });
    this.#flushing = this.#options.publisher.publish(records).then(
      () => {
        // A newer view that arrived meanwhile stays queued.
        for (const emission of batch) {
          if (this.#pending.get(emission.key) === emission) this.#pending.delete(emission.key);
        }
        if (!this.#kafkaHealthy) this.#log(`Kafka acknowledged ${records.length} views.`);
        this.#kafkaHealthy = true;
        this.#lastKafkaError = null;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.#kafkaHealthy || this.#lastKafkaError !== message) this.#log(`Publishing failed; ${this.#pending.size} views wait for Kafka: ${message}`);
        this.#kafkaHealthy = false;
        this.#lastKafkaError = message;
      }
    ).finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  async checkpoint(): Promise<void> {
    const world = this.#world;
    if (world === null) return;
    const checkpoint: Checkpoint = { format: CHECKPOINT_FORMAT, epoch: this.epoch, tickMs: this.#options.tickMs, world };
    await mkdir(this.#options.dataDir, { recursive: true });
    const path = join(this.#options.dataDir, CHECKPOINT_FILE);
    await writeFile(`${path}.tmp`, JSON.stringify(checkpoint));
    await rename(`${path}.tmp`, path);
    this.#lastCheckpointAt = this.#now();
  }

  /** Publishes what it can within the deadline, then checkpoints. */
  async stop(timeoutMs = 5_000): Promise<void> {
    if (this.#world === null) return;
    const deadline = new Promise(resolve => setTimeout(resolve, timeoutMs).unref());
    await Promise.race([this.flush(), deadline]);
    await this.checkpoint();
  }

  async #readCheckpoint(): Promise<Checkpoint | null> {
    let text: string;
    try {
      text = await readFile(join(this.#options.dataDir, CHECKPOINT_FILE), "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as Partial<Checkpoint>;
      if (parsed.format !== CHECKPOINT_FORMAT || typeof parsed.epoch !== "string" || typeof parsed.tickMs !== "number") return null;
      return { format: CHECKPOINT_FORMAT, epoch: parsed.epoch, tickMs: parsed.tickMs, world: restore(JSON.stringify(parsed.world)) };
    } catch (error) {
      this.#log(`Ignoring an unreadable checkpoint: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
