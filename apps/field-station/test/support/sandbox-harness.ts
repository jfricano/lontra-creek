/** A field-station sandbox pool wired in-process to a real SandboxService on a fixture backend, with a fake clock. */
import type { SessionClaims } from '../../src/sessions.ts';
import type { SandboxOperation, SlotId } from '../../src/sandbox/contract.ts';
import { SandboxPool, type SandboxClient } from '../../src/sandbox/leases.ts';
import { SandboxService, type SlotBackend } from '../../src/sandbox/service.ts';
import { AddressCap } from '../../src/places.ts';
import { SandboxFault } from '../../src/sandbox/operations.ts';
import { FixtureBackend } from './sandbox-fixture.ts';

export const SERVICE_TOKEN = 's'.repeat(40);

export async function harness(options: { slots?: number; backend?: (now: () => number) => SlotBackend; cap?: AddressCap; client?: (inner: SandboxClient) => SandboxClient } = {}) {
  let now = Date.parse('2026-10-03T00:00:00Z');
  const clock = () => now;
  const fixture = new FixtureBackend(clock);
  const backend = options.backend?.(clock) ?? fixture;
  const slots = Array.from({ length: options.slots ?? 3 }, (_, i) => i + 1 as SlotId);
  let service = new SandboxService({ backend, slots, serviceToken: SERVICE_TOKEN, now: clock });
  let down = false;
  const requests: { path: string; method: string; body: unknown }[] = [];
  const direct: SandboxClient = {
    async request(path, method = 'GET', body) {
      if (down) throw new Error('unreachable');
      requests.push({ path, method, body });
      // Round-trip through JSON, as the HTTP client does.
      return JSON.parse(JSON.stringify(await service.dispatch(method, path, (body ?? {}) as Record<string, unknown>))) as { status: number; body: unknown };
    }
  };
  const client = options.client?.(direct) ?? direct;
  const cap = options.cap ?? new AddressCap();
  const pool = new SandboxPool({ client, slots, gatewayOrigin: 'https://demo.test', now: clock, cap });
  await service.start(); await pool.initialize();
  const settle = async () => { for (let i = 0; i < 2; i++) { await service.settled(); pool.refresh(); await pool.run(() => pool.sweep()); } };
  await settle();
  const h = {
    pool, fixture, cap, requests, clock,
    get service() { return service; },
    /** A new service process: new boot ID, fresh slots. */
    async restartService() { service = new SandboxService({ backend, slots, serviceToken: SERVICE_TOKEN, now: clock }); await service.start(); },
    setDown(value: boolean) { down = value; },
    settle,
    async advance(ms: number) { now += ms; await settle(); },
    session: (subject: string, ttlMs = 1_800_000): SessionClaims => ({ subject, role: 'volunteer', exp: now + ttlMs }),
    join: (s: SessionClaims, address = s.subject) => pool.run(async () => { await pool.sweep(); return pool.join(s, address); }),
    view: (s: SessionClaims) => pool.view(s),
    leave: (s: SessionClaims) => pool.run(() => pool.leave(s)),
    claim: (s: SessionClaims) => pool.run(() => pool.claim(s)),
    reset: (s: SessionClaims) => pool.run(() => pool.reset(s)),
    op: (s: SessionClaims, op: SandboxOperation, input: unknown = null) => pool.operate(s, op, input),
    /** Lets the per-session operation budget refill between calls. */
    async opSlow(s: SessionClaims, op: SandboxOperation, input: unknown = null) { now += 1000; return pool.operate(s, op, input); },
    reason: (s: SessionClaims) => { const v = pool.view(s); return v.status === 'ended' ? v.reason : v.status; }
  };
  return h;
}
export const code = (name: string) => (error: unknown) => error instanceof SandboxFault && error.code === name;
export const wb = (name: string, detail?: string) => (error: unknown) => {
  const e = error as { error?: { code?: string; details?: { code?: string } } };
  return e.error?.code === name && (detail === undefined || e.error.details?.code === detail);
};
