/**
 * Seed / meteor-type <-> URL query. All external input is treated as hostile:
 * seed is integer-parsed and range-clamped, type/size are whitelist-validated
 * (PROJECT.md §7 보안). We only ever read our own query params — no external
 * URLs are dereferenced and nothing here touches innerHTML.
 */

export const METEOR_TYPES = ['rocky', 'iron', 'jagged', 'comet'] as const;
export type MeteorType = (typeof METEOR_TYPES)[number];

export const METEOR_SIZES = ['S', 'M', 'L'] as const;
export type MeteorSize = (typeof METEOR_SIZES)[number];

export const SEED_MAX = 0x7fffffff; // keep within signed 32-bit for stable PRNG

export function isMeteorType(v: unknown): v is MeteorType {
  return typeof v === 'string' && (METEOR_TYPES as readonly string[]).includes(v);
}

export function isMeteorSize(v: unknown): v is MeteorSize {
  return typeof v === 'string' && (METEOR_SIZES as readonly string[]).includes(v);
}

/** Parse an arbitrary seed string to a valid integer seed, or null if invalid. */
export function parseSeed(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!/^-?\d{1,10}$/.test(trimmed)) return null; // digits only, bounded length
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  const clamped = Math.abs(n) % (SEED_MAX + 1);
  return clamped >>> 0;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * (SEED_MAX + 1)) >>> 0;
}

export interface ShareState {
  seed: number;
  type: MeteorType;
  size: MeteorSize;
}

/** Read seed/type/size from a URLSearchParams-like source with validation. */
export function readShareState(
  params: URLSearchParams,
  fallback: ShareState,
): { state: ShareState; seedWasInvalid: boolean } {
  const rawSeed = params.get('seed');
  const parsed = parseSeed(rawSeed);
  const seedWasInvalid = rawSeed != null && parsed == null;
  const typeParam = params.get('type');
  const sizeParam = params.get('size');
  return {
    state: {
      seed: parsed ?? fallback.seed,
      type: isMeteorType(typeParam) ? typeParam : fallback.type,
      size: isMeteorSize(sizeParam) ? sizeParam : fallback.size,
    },
    seedWasInvalid,
  };
}

/** Build a shareable query string (no host — caller prepends origin+path). */
export function buildShareQuery(state: ShareState): string {
  const p = new URLSearchParams();
  p.set('seed', String(state.seed >>> 0));
  p.set('type', state.type);
  p.set('size', state.size);
  return p.toString();
}

export function buildShareUrl(origin: string, pathname: string, state: ShareState): string {
  return `${origin}${pathname}?${buildShareQuery(state)}`;
}
