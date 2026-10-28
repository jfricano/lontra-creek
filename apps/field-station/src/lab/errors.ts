import type { LabErrorCode } from './contract.ts';
/** A Lab refusal: its code (also the message) and the HTTP status it is answered with. */
export class LabError extends Error {
  /** The refusal code a LabError body carries. */
  readonly code: LabErrorCode;
  /** The HTTP status it is answered with. */
  readonly status: number;
  /** The message is the code itself. */
  constructor(code: LabErrorCode, status: number) { super(code); this.code = code; this.status = status; }
}
/**
 * A bench's 404: an unknown route, which is the bench failing like any other answer
 * (503 `bench-unavailable`), or an operation the bench no longer has because its process
 * restarted since it accepted it, which the field station reads as that operation's end.
 */
export class BenchNotFound extends LabError { constructor() { super('bench-unavailable', 503); } }
/** Every LabAction, the only values the actions routes accept for `action`. */
export const ACTIONS = ['sensor.foul', 'sensor.restore', 'source.resume', 'relay.cut', 'relay.restore', 'satellite.start', 'gateway.restart'] as const;
/** The longest lease a bench accepts. The field station refuses a longer LAB_LEASE_SECONDS at startup rather than have every grant fail. */
export const MAX_LEASE_MS = 300_000;
