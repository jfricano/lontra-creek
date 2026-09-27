import type { LabErrorCode } from './contract.ts';
export class LabError extends Error {
  readonly code: LabErrorCode;
  readonly status: number;
  constructor(code: LabErrorCode, status: number) { super(code); this.code = code; this.status = status; }
}
export const ACTIONS = ['sensor.foul', 'sensor.restore', 'source.resume', 'relay.cut', 'relay.restore', 'satellite.start', 'gateway.restart'] as const;
