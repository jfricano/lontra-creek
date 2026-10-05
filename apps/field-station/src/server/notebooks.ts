/**
 * Field notebooks (walkthrough chapter 6): each visitor's own sightings, delivered
 * on the owner-only `notebook` channel.
 *
 * Entries are choices from fixed lists, never free text, at most one a second and
 * the latest twenty per notebook. A notebook lasts as long as its owner's session.
 * The field station updates the notebook it serves, then queues it for
 * field.notebooks keyed by observer: write, then publish, as for the world.
 *
 * Revisions are the write time in milliseconds, kept strictly increasing, so a
 * restart never reuses one. On start, notebooks are rebuilt from the topic.
 *
 * No tombstones: StreamOtter V1 pauses a source on a null record value. When a
 * session ends, its notebook is published once more as expired and empty, and the
 * topic's delete retention (compact,delete) removes old records. Expired notebooks
 * stay in memory as long as the topic keeps them, so a snapshot never goes back to
 * an older revision.
 */
import type { StudyStamp } from "@lontra-creek/sim";
import type { AppChannels } from "../generated/streamotter.generated.ts";
import { NOTEBOOK_MAX_ENTRIES, SIGHTING_ACTIVITIES, SIGHTING_OTTERS, SIGHTING_REACHES } from "../project.ts";
import { fromRecord, NOTEBOOK_TOPIC } from "../records.ts";
import type { PublishQueue } from "./queue.ts";

export type Notebook = AppChannels["notebook"]["data"];
export type Entry = Notebook["entries"][number];

/** How long field.notebooks keeps records: a few session lifetimes. */
export const NOTEBOOK_RETENTION_MS = 2 * 60 * 60 * 1_000;
export const SIGHTING_INTERVAL_MS = 1_000;
const MAX_OPEN_NOTEBOOKS = 5_000;
/** Open notebooks one client address (an IPv4 address or an IPv6 /64) may hold, so one host can't fill the global cap. */
export const MAX_OPEN_NOTEBOOKS_PER_CLIENT = 20;

export interface Sighting {
  otterId: string;
  reachId: string;
  activity: string;
}

/** A refusal the site API passes on: the HTTP status and a message for the visitor. */
export class NotebookError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Book {
  data: Notebook;
  revision: bigint;
  /** When the owner's session ends, in epoch milliseconds. */
  expiresAt: number;
  lastWriteAt: number;
  /** The client address that opened it, when known (not for notebooks rebuilt from the topic). */
  client?: string;
}

/** The record published for a notebook: a field record, plus when it expires. */
interface NotebookRecord {
  tenantId: string;
  channel: "notebook";
  params: { observerId: string };
  revision: string;
  data: Notebook;
  expiresAt: string;
}

/** Checks a sighting against the notebook's fixed lists. */
export function parseSighting(body: Record<string, unknown>): Sighting | null {
  const { otterId, reachId, activity } = body;
  if (typeof otterId !== "string" || !SIGHTING_OTTERS.includes(otterId)) return null;
  if (typeof reachId !== "string" || !SIGHTING_REACHES.includes(reachId)) return null;
  if (typeof activity !== "string" || !SIGHTING_ACTIVITIES.includes(activity)) return null;
  return { otterId, reachId, activity };
}

export class Notebooks {
  readonly #queue: PublishQueue;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #tenantId: string;
  readonly #books = new Map<string, Book>();
  #ready = false;

  constructor(options: { queue: PublishQueue; tenantId: string; now?: () => number; log?: (message: string) => void }) {
    this.#queue = options.queue;
    this.#tenantId = options.tenantId;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (message => console.log(message));
  }

  /** Publishes queued records now rather than on the next tick. */
  flush(): Promise<void> {
    return this.#queue.flush();
  }

  /** True once notebooks have been rebuilt from the topic. */
  get ready(): boolean {
    return this.#ready;
  }

  get openCount(): number {
    let open = 0;
    for (const book of this.#books.values()) if (book.data.status === "open") open += 1;
    return open;
  }

  #openFrom(client: string): number {
    let open = 0;
    for (const book of this.#books.values()) if (book.data.status === "open" && book.client === client) open += 1;
    return open;
  }

  /**
   * Rebuilds notebooks from field.notebooks record values, keeping each one's
   * highest revision, then closes any whose session has ended meanwhile.
   */
  load(values: Iterable<string | null>): void {
    let skipped = 0;
    for (const value of values) {
      const record = parseRecord(value);
      if (record === null) {
        skipped += 1;
        continue;
      }
      const revision = BigInt(record.revision);
      const current = this.#books.get(record.params.observerId);
      if (current !== undefined && current.revision >= revision) continue;
      this.#books.set(record.params.observerId, { data: record.data, revision, expiresAt: Date.parse(record.expiresAt), lastWriteAt: 0 });
    }
    this.#ready = true;
    const expired = this.expire();
    this.#log(`Rebuilt ${this.#books.size} notebooks from ${NOTEBOOK_TOPIC} (${expired} closed on loading${skipped > 0 ? `, ${skipped} unreadable records skipped` : ""}).`);
  }

  /** The notebook to serve as a snapshot: an empty, open one at revision 0 until its first sighting. */
  view(observerId: string): { revision: string; data: Notebook } {
    const book = this.#books.get(observerId);
    if (book === undefined) return { revision: "0", data: { observerId, status: "open", entries: [] } };
    return { revision: book.revision.toString(), data: book.data };
  }

  /** Adds a sighting to the owner's notebook and queues it for publishing. */
  add(observerId: string, expiresAt: number, sighting: Sighting, at: StudyStamp, client?: string): { revision: string; entries: number } {
    if (!this.#ready) throw new NotebookError(503, "Notebooks are still loading; try again in a moment.");
    const now = this.#now();
    let book = this.#books.get(observerId);
    if (book !== undefined && book.data.status === "expired") throw new NotebookError(410, "This notebook has closed with its session.");
    if (book !== undefined && now - book.lastWriteAt < SIGHTING_INTERVAL_MS) throw new NotebookError(429, "One sighting a second, please.");
    if (book === undefined) {
      if (client !== undefined && this.#openFrom(client) >= MAX_OPEN_NOTEBOOKS_PER_CLIENT) throw new NotebookError(429, "Too many notebooks are open from your network; try again when one closes.");
      if (this.openCount >= MAX_OPEN_NOTEBOOKS) throw new NotebookError(503, "The field station has too many open notebooks; try again later.");
      book = { data: { observerId, status: "open", entries: [] }, revision: 0n, expiresAt, lastWriteAt: 0, ...(client === undefined ? {} : { client }) };
      this.#books.set(observerId, book);
    }
    const entry: Entry = { at, ...sighting } as Entry;
    book.data = { ...book.data, entries: [...book.data.entries, entry].slice(-NOTEBOOK_MAX_ENTRIES) };
    this.#write(observerId, book, now);
    return { revision: book.revision.toString(), entries: book.data.entries.length };
  }

  /**
   * Closes notebooks whose session has ended, publishing each once more as
   * expired and empty, and forgets expired ones the topic no longer keeps.
   * Returns how many it closed.
   */
  expire(): number {
    const now = this.#now();
    let closed = 0;
    for (const [observerId, book] of this.#books) {
      if (book.data.status === "open" && book.expiresAt <= now) {
        book.data = { observerId, status: "expired", entries: [] };
        this.#write(observerId, book, now);
        closed += 1;
      } else if (book.data.status === "expired" && now - book.expiresAt > NOTEBOOK_RETENTION_MS) {
        this.#books.delete(observerId);
      }
    }
    return closed;
  }

  #write(observerId: string, book: Book, now: number): void {
    // The write time in milliseconds, strictly increasing even if the clock isn't.
    const time = BigInt(now);
    book.revision = time > book.revision ? time : book.revision + 1n;
    book.lastWriteAt = now;
    const record: NotebookRecord = {
      tenantId: this.#tenantId,
      channel: "notebook",
      params: { observerId },
      revision: book.revision.toString(),
      data: book.data,
      expiresAt: new Date(book.expiresAt).toISOString()
    };
    this.#queue.set({ topic: NOTEBOOK_TOPIC, key: `notebook:${observerId}`, value: JSON.stringify(record) });
  }
}

function parseRecord(value: string | null): NotebookRecord | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const field = fromRecord(parsed as Parameters<typeof fromRecord>[0]);
  const expiresAt = (parsed as { expiresAt?: unknown }).expiresAt;
  if (field === null || field.channel !== "notebook" || typeof field.params["observerId"] !== "string") return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)) || !/^\d+$/.test(field.revision)) return null;
  return { ...field, channel: "notebook", params: { observerId: field.params["observerId"] }, data: field.data as unknown as Notebook, expiresAt };
}
