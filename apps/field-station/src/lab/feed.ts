import type { Trace } from 'streamotter/contracts';
import type { LabFeedItem, LabFeedPage } from './contract.ts';
import { LabError } from './errors.ts';
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type FeedEvent = DistributiveOmit<LabFeedItem, 'id' | 'at'>;
/** A bounded, lease-scoped feed. Internal identifiers never become public ids. */
export class LabFeed {
  #lease = '';
  #sequence = 0;
  #items: LabFeedItem[] = [];
  #groups = new Map<string, string>();
  reset(lease = ''): void { this.#lease = lease; this.#sequence = 0; this.#items = []; this.#groups.clear(); }
  add(item: FeedEvent, at = new Date().toISOString()): void {
    if (!this.#lease) return;
    this.#items.push({ ...item, at, id: `${this.#lease}:${++this.#sequence}` } as LabFeedItem);
    if (this.#items.length > 500) this.#items.shift();
  }
  trace(trace: Trace, satellites: ReadonlySet<string>): void {
    if (trace.stage === 'authorize' && !trace.subscriptionId || trace.stage === 'map' && trace.outcome === 'filtered') return;
    let group = this.#groups.get(trace.requestId);
    if (!group) { group = `g${this.#sequence + 1}`; this.#groups.set(trace.requestId, group); }
    if (this.#groups.size > 1000) this.#groups.delete(this.#groups.keys().next().value!);
    this.add({ kind: 'trace', stage: trace.stage, outcome: trace.outcome, group,
      ...(trace.sourceId === undefined ? {} : { sourceId: trace.sourceId }),
      ...(trace.channel === undefined ? {} : { channel: trace.channel }),
      ...(trace.errorCode === undefined ? {} : { errorCode: trace.errorCode }),
      ...(trace.subscriptionId === undefined ? {} : { subscriber: satellites.has(trace.subscriptionId) ? 'satellite' : 'you' }) }, trace.at);
  }
  page(after?: string, limit = 100): LabFeedPage {
    let sequence = 0;
    if (after) {
      const prefix = `${this.#lease}:`;
      if (!after.startsWith(prefix) || !/^\d+$/.test(after.slice(prefix.length))) throw new LabError('invalid-request', 400);
      sequence = Number(after.slice(prefix.length));
      if (!Number.isSafeInteger(sequence) || sequence > this.#sequence) throw new LabError('invalid-request', 400);
    }
    const first = this.#sequence - this.#items.length + 1;
    const items = this.#items.filter(item => Number(item.id.slice(item.id.lastIndexOf(':') + 1)) > sequence).slice(0, Math.min(100, Math.max(1, limit)));
    return { items, next: items.at(-1)?.id ?? `${this.#lease}:${sequence}`, gap: sequence < first - 1 };
  }
}
