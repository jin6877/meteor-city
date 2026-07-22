/**
 * Deterministic seeded PRNG. Every random value in city generation is pulled
 * from a single mulberry32 stream in a FIXED order, so the same seed always
 * yields the same city (PROJECT.md §1 결정론 필수). three has no place here —
 * this stays a pure module so determinism is unit-testable.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small deterministic hash so a string could seed a stream if ever needed. */
export function hashStringToSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Thin ergonomic wrapper over a mulberry32 stream. */
export class Rng {
  private next01: () => number;
  constructor(seed: number) {
    this.next01 = mulberry32(seed);
  }
  /** [0,1) */
  next(): number {
    return this.next01();
  }
  /** [min,max) float */
  range(min: number, max: number): number {
    return min + (max - min) * this.next01();
  }
  /** [min,max] integer */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
  /** true with probability p */
  chance(p: number): boolean {
    return this.next01() < p;
  }
  /** uniform element */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next01() * arr.length)];
  }
  /** weighted element; weights need not sum to 1 */
  weighted<T>(entries: readonly [T, number][]): T {
    let total = 0;
    for (const [, w] of entries) total += w;
    let r = this.next01() * total;
    for (const [v, w] of entries) {
      r -= w;
      if (r <= 0) return v;
    }
    return entries[entries.length - 1][0];
  }
  /** -1 or +1 */
  sign(): number {
    return this.next01() < 0.5 ? -1 : 1;
  }
}
