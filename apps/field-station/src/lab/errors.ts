import type { LabErrorCode } from './contract.ts';
export class LabError extends Error {
  readonly code: LabErrorCode;
  readonly status: number;
  constructor(code: LabErrorCode, status: number) { super(code); this.code = code; this.status = status; }
}
export const ACTIONS = ['sensor.foul', 'sensor.restore', 'source.resume', 'relay.cut', 'relay.restore', 'satellite.start', 'gateway.restart'] as const;
/** The longest lease a bench accepts. The field station refuses a longer LAB_LEASE_SECONDS at startup rather than have every grant fail. */
export const MAX_LEASE_MS = 300_000;
