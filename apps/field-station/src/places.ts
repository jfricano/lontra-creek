/**
 * One per-client-address cap across every pool the field station leases from (Lab
 * benches and workbench sandbox slots): a client address holds at most `limit`
 * places in total, leases plus places in line (LC11-ADR-04 decision 2).
 *
 * Each pool checks and inserts a place synchronously (no await in between), so two
 * joins from the same address on different pools cannot both pass the check.
 */
export interface PlaceCounter { placesFor(address: string): number; }
/** The shared per-address cap: pools register with it and check `full` before adding a place. */
export class AddressCap {
  /** Places one address may hold across all pools. */
  readonly limit: number;
  readonly #pools = new Set<PlaceCounter>();
  /** A cap of `limit` places per address, two by default. */
  constructor(limit = 2) { this.limit = limit; }
  /** Adds a pool whose places count toward the cap. */
  register(pool: PlaceCounter): void { this.#pools.add(pool); }
  /** Places the address holds across every registered pool. */
  held(address: string): number { let total = 0; for (const pool of this.#pools) total += pool.placesFor(address); return total; }
  /** True when the address may not take another place. */
  full(address: string): boolean { return this.held(address) >= this.limit; }
}
