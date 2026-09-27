/**
 * The Failure Lab's benches, by number. Each bench is a development-mode StreamOtter
 * gateway of its own (V1 supports one gateway per project, so each has its own
 * project), fed with a copy of the creek on its own topics, which the field station
 * publishes over its own connection to the broker. A bench reaches the broker only
 * through its relay (relay.ts), on a listener the broker advertises as the relay's
 * name, so cutting the relay cuts that bench off and nothing else.
 *
 * These names are shared by the field station, the broker's listeners
 * (deploy/kafka/start.sh), its certificate (deploy/make-certs.sh), the relays, and
 * the benches.
 */
import { TOPICS } from "@lontra-creek/sim";

/** Benches are numbered from 1; the pool is small and fixed (docs/PLAN.md, The Failure Lab). */
export const MAX_BENCHES = 9;

export interface Bench {
  readonly number: number;
  /** The bench gateway's StreamOtter project. */
  readonly projectId: string;
  /** Prepended to each creek topic for this bench's copy, e.g. lab-1.field.gauges. */
  readonly topicPrefix: string;
  /** The bench's copy of the creek topics. */
  readonly topics: readonly string[];
  readonly consumerGroup: string;
  /** The relay's host name: the address the broker advertises to this bench. */
  readonly relayHost: string;
  /** The relay's port, and the broker listener's behind it. */
  readonly relayPort: number;
  /** Where visitors' WebSockets reach this bench's gateway. */
  readonly gatewayPath: string;
}

export const CREEK_TOPICS: readonly string[] = [...new Set(Object.values(TOPICS))];

export function bench(number: number): Bench {
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_BENCHES) {
    throw new RangeError(`A bench number is from 1 to ${MAX_BENCHES}.`);
  }
  const topicPrefix = `lab-${number}.`;
  return {
    number,
    projectId: `lontra-creek-lab-${number}`,
    topicPrefix,
    topics: CREEK_TOPICS.map(topic => `${topicPrefix}${topic}`),
    consumerGroup: `lontra-creek-lab-${number}-field`,
    relayHost: `lab-${number}-kafka`,
    relayPort: 9100 + number,
    gatewayPath: `/lab/${number}/socket.io`
  };
}

/** Benches 1 to count. */
export function benches(count: number): Bench[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_BENCHES) {
    throw new RangeError(`The number of benches is from 0 to ${MAX_BENCHES}.`);
  }
  return Array.from({ length: count }, (_unused, index) => bench(index + 1));
}
