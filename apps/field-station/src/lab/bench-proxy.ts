/**
 * Where each bench's proxy to Kafka listens (proxy.ts). These names are kept apart
 * from benches.ts so that a proxy's own process (proxy-main.ts) loads nothing else:
 * benches.ts needs the creek's topic names, and with them the whole simulation,
 * which a proxy never uses and has no room for in its 64 MiB on the shared host
 * (deploy/compose.shared.lab.yaml).
 */

/** Benches are numbered from 1; the pool is small and fixed (docs/PLAN.md, The Failure Lab). */
export const MAX_BENCHES = 9;

/** One bench's proxy, as the broker, the proxy, and the bench name it. */
export interface BenchProxy {
  /** The proxy's host name: the address the broker advertises to this bench. */
  readonly proxyHost: string;
  /** The proxy's port, and the broker listener's behind it. */
  readonly proxyPort: number;
}

/** Bench `number`'s proxy; a RangeError unless it is from 1 to MAX_BENCHES. */
export function benchProxy(number: number): BenchProxy {
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_BENCHES) {
    throw new RangeError(`A bench number is from 1 to ${MAX_BENCHES}.`);
  }

  return { proxyHost: `lab-${number}-kafka`, proxyPort: 9100 + number };
}
