/**
 * One per-client-address cap across every pool the field station leases from (Lab
 * benches and workbench sandbox slots): a client address holds at most `limit`
 * places in total, leases plus places in line (LC11-ADR-04 decision 2).
 *
 * Each pool checks and inserts a place synchronously (no await in between), so two
 * joins from the same address on different pools cannot both pass the check.
 */
export interface PlaceCounter { placesFor(address: string): number; }
export class AddressCap {
  readonly limit: number;
  readonly #pools = new Set<PlaceCounter>();
  constructor(limit = 2) { this.limit = limit; }
  register(pool: PlaceCounter): void { this.#pools.add(pool); }
  held(address: string): number { let total = 0; for (const pool of this.#pools) total += pool.placesFor(address); return total; }
  full(address: string): boolean { return this.held(address) >= this.limit; }
}
