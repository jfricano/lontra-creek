/**
 * Records waiting for the broker, the latest per key, shared by the world and the
 * notebooks. While Kafka is away only the latest state of each key waits: correct
 * for full-state channels. One batch is in flight at a time, and a record leaves
 * the queue only when the broker has acknowledged it; a newer record for the same
 * key waits for the next batch. After an acknowledged batch, whatever arrived
 * meanwhile goes out at once; after a failure, it waits for the next flush.
 */

export interface OutgoingRecord {
  topic: string;
  key: string;
  value: string;
}

/** Where records go. publish resolves once the broker has acknowledged every record. */
export interface Publisher {
  publish(records: readonly OutgoingRecord[]): Promise<void>;
  close(): Promise<void>;
}

export class PublishQueue {
  readonly #publisher: Publisher;
  readonly #log: (message: string) => void;
  readonly #pending = new Map<string, OutgoingRecord>();
  #flushing: Promise<void> | null = null;
  #healthy = false;
  #lastError: string | null = null;

  constructor(publisher: Publisher, log: (message: string) => void = message => console.log(message)) {
    this.#publisher = publisher;
    this.#log = log;
  }

  /** True once the broker has acknowledged a batch, until a send fails. */
  get healthy(): boolean {
    return this.#healthy;
  }

  get size(): number {
    return this.#pending.size;
  }

  set(record: OutgoingRecord): void {
    this.#pending.set(record.key, record);
  }

  /** Publishes what is pending, unless a batch is already in flight. */
  flush(): Promise<void> {
    if (this.#flushing !== null || this.#pending.size === 0) return this.#flushing ?? Promise.resolve();
    const batch = [...this.#pending.values()];
    this.#flushing = this.#publisher.publish(batch).then(
      () => {
        for (const record of batch) {
          if (this.#pending.get(record.key) === record) this.#pending.delete(record.key);
        }
        if (!this.#healthy) this.#log(`Kafka acknowledged ${batch.length} records.`);
        this.#healthy = true;
        this.#lastError = null;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.#healthy || this.#lastError !== message) this.#log(`Publishing failed; ${this.#pending.size} records wait for Kafka: ${message}`);
        this.#healthy = false;
        this.#lastError = message;
      }
    ).finally(() => {
      this.#flushing = null;
      if (this.#healthy && this.#pending.size > 0) setImmediate(() => void this.flush());
    });
    return this.#flushing;
  }
}
