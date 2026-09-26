/**
 * Seeded randomness. mulberry32 keeps its whole state in one 32-bit integer, so a
 * world's random stream checkpoints as a plain number and replays exactly.
 */
export interface Rng {
  state: number;
}

export function createRng(seed: number): Rng {
  return { state: seed >>> 0 };
}

/** A float in [0, 1). */
export function next(rng: Rng): number {
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}

export function range(rng: Rng, low: number, high: number): number {
  return low + (high - low) * next(rng);
}

/** An integer in [low, high], inclusive. */
export function int(rng: Rng, low: number, high: number): number {
  return Math.floor(range(rng, low, high + 1));
}

export function chance(rng: Rng, probability: number): boolean {
  return next(rng) < probability;
}

/** A standard normal sample (Box–Muller). */
export function normal(rng: Rng): number {
  const u = Math.max(next(rng), 1e-12);
  const v = next(rng);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Picks a key with probability proportional to its weight. Keys are tried in insertion order. */
export function weighted<K extends string>(rng: Rng, weights: Readonly<Record<K, number>>): K {
  const entries = Object.entries(weights) as [K, number][];
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  let roll = next(rng) * total;
  for (const [key, weight] of entries) {
    roll -= Math.max(0, weight);
    if (roll < 0) return key;
  }
  return entries[entries.length - 1]![0];
}

/** Derives a 32-bit seed from text, for naming worlds ("lontra-creek") instead of numbering them. */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
