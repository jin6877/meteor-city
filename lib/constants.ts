/**
 * Palette + scene constants — values taken directly from docs/DESIGN.md.
 * Colors are hex ints (0xRRGGBB) for direct THREE.Color use. Do not invent
 * new hues here; every value below is anchored to a DESIGN.md table row.
 */

// ---- World scale (PROJECT.md §1) ----
export const CELL = 20; // block cell size (world units ~ meters)
export const ROAD = 6; // road strip width
export const GROUND_Y = 0; // ground plane top

// ---- Brand / accent (DESIGN §2) ----
export const BRAND_EMBER = 0xf26a2e; // heat/impact accent — UI + crater ring only

// ---- Sky / background / fog (DESIGN §3) ----
export const SKY_TOP = 0xd6e0e6;
export const SKY_HORIZON = 0xece4d6;
export const FOG_COLOR = 0xe7e0d2;

// ---- Diorama base (DESIGN §2 중립) ----
export const BASE_DIRT = 0x9a8e76;
export const BASE_GRASS = 0x7c8b57;
export const BASE_BEVEL = 0x6e6455;

// ---- Lighting (DESIGN §3 / §8) ----
export const SUN_DIR: [number, number, number] = [-0.5, 0.72, 0.5];
export const SUN_COLOR = 0xfff3e0; // warm ~5400K
export const SUN_INTENSITY = 3.0;
export const HEMI_SKY = 0xcfe0ea;
export const HEMI_GROUND = 0xb8ae9e;
export const HEMI_INTENSITY = 0.55;
export const ENV_INTENSITY = 0.6;
export const TONE_EXPOSURE = 1.05;

// ---- Roads / ground surfaces (DESIGN §2) ----
export const ASPHALT = 0x4e4f53;
export const LANE_WHITE = 0xc9c6bc;
export const LANE_YELLOW = 0xc9a94e;
export const SIDEWALK = 0xb7b2a8;

// ---- Water (DESIGN §2 강물) ----
export const WATER_BODY = 0x2e4a54;
export const WATER_TINT = 0x33525e;

// ---- UI chrome tokens (DESIGN §6) ----
export const CHROME = {
  panel: '#1C1F26',
  ink: '#F2EEE6',
  muted: '#A7A399',
  ember: '#F26A2E',
} as const;

/**
 * Building material families (DESIGN §2 table). Each family carries its base
 * color variants + PBR params. Per-building jitter is applied in generateCity.
 */
export type MaterialFamily =
  | 'glass'
  | 'concrete'
  | 'brick'
  | 'panel'
  | 'roof';

export interface FamilySpec {
  variants: number[]; // candidate base colors (hex)
  roughness: number;
  metalness: number;
  envMapIntensity: number;
}

export const FAMILY: Record<MaterialFamily, FamilySpec> = {
  // 유리타워 (downtown towers)
  glass: {
    variants: [0x7c8b99, 0x9a8b76, 0x7c948a],
    roughness: 0.18,
    metalness: 0.1,
    envMapIntensity: 1.0,
  },
  // 콘크리트 (mid-rise slab / office)
  concrete: {
    variants: [0xc2bcb0, 0xaeb2b0],
    roughness: 0.78,
    metalness: 0.0,
    envMapIntensity: 0.5,
  },
  // 벽돌 (residential gable houses)
  brick: {
    variants: [0xa85f49, 0x8c5241, 0xc7b9a4],
    roughness: 0.82,
    metalness: 0.0,
    envMapIntensity: 0.4,
  },
  // 도색 판넬 (warehouse / low commercial) — mustard is rare accent (~5%)
  panel: {
    variants: [0x8fa08a, 0x7e93a3, 0xe4ded2, 0xc8a34e],
    roughness: 0.6,
    metalness: 0.05,
    envMapIntensity: 0.5,
  },
  // 지붕 (roofs) — dark so silhouettes read
  roof: {
    variants: [0x3c3e42, 0x4a3b33, 0x6e8c7a],
    roughness: 0.7,
    metalness: 0.0,
    envMapIntensity: 0.4,
  },
};

// Tree / greenery (DESIGN §2)
export const LEAF_COLORS = [0x5e7b4e, 0x6e8a54, 0xa8863c];
export const TRUNK_COLOR = 0x6a4e3a;

// ---- Windows (sky-blue glass, reflecting the daytime sky) ----
// tint multiplies the grayscale window emissiveMap; intensity varies by family
// so it reads as glass reflecting sky, not a uniform fluorescent grid.
export const WINDOW_TINT = 0xaecadf; // soft sky-blue
export const WINDOW_TINT_COOL = 0x9fbcd6; // slightly deeper for concrete
export const WINDOW_EMISSIVE = { glass: 0.5, concrete: 0.28 } as const;

// ---- Rising smoke (disaster pass — separate budget from debris/rubble) ----
// A dark, heavy warm-black column that rises off craters AND keeps pouring off
// active fires, expanding into a lingering plume so repeated hits turn the city
// into a smoke-choked disaster (DESIGN §9 disaster-drama override of §7). It is
// alpha-blended (never additive) and stays translucent — density comes from many
// overlapping particles + long life, not from opacity. All knobs live here.
// This backs a continuous ParticleField (ring buffer), not one-shot bursts.
export const SMOKE = {
  color: 0x2b2824, // heavy warm-black smoke (disaster tone; still not pure black)
  colorEnd: 0x6f6a63, // lightens slightly as it thins and catches sky
  colorCool: 0x9aa2a4, // comet / over-water: pale cool steam
  count: { high: 560, low: 240 }, // particle pool (per tier)
  rise: 3.4, // base upward speed (world units/s)
  riseJitter: 2.0, // per-particle rise variance (elongates the plume)
  seedColumn: 4.0, // initial vertical seed spread (starts as a short column)
  spread: 1.6, // initial horizontal seed radius (tight = column)
  drift: 0.55, // lateral expansion rate as it disperses
  buoyancyDamp: 0.09, // buoyancy slowly bleeds off so the column tops out
  life: 8.5, // seconds — long-lived, lingers into an ambient pall
  lifeJitter: 2.5,
  hold: 0.42, // fraction of life held near peak before the slow fade
  peakAlpha: 0.5, // thicker than the old restrained wisp, still translucent
  sizeStart: 8, // billboard size at birth
  sizeEnd: 24, // billboard size at death (billows large as it dissipates)
} as const;

// ---- Fire + embers (disaster pass) — additive flame billboards + rising sparks ----
// A fire "site" is ignited at each impact crater and at a few of the buildings it
// levels; the site burns for a while (with re-ignition flare pulses), continuously
// spitting short-lived flame tongues + embers + feeding the smoke column, then
// fades. Bigger blasts light bigger, longer fires. Its OWN pooled budget (flame /
// ember particle caps + a site cap), separate from debris — oldest is recycled.
export const FIRE = {
  // flame color gradient (hot core -> deep cooling red as a tongue rises)
  hot: 0xffe8b0, // near-white hot base
  mid: 0xff7a1e, // orange body
  deep: 0x7c2408, // deep red as it cools/rises
  sites: { high: 12, low: 6 }, // max simultaneous fire sites
  flameCount: { high: 560, low: 240 }, // flame particle pool
  emberColor: 0xffb060, // warm spark
  emberCount: { high: 260, low: 110 }, // ember particle pool
  life: 8.5, // base seconds a site burns
  lifeJitter: 3.5, // + up to this (bigger blasts also extend below)
  reignite: 1.5, // period (s) of flare pulses so fire "breathes" / re-ignites
  radiusScale: 0.42, // fire footprint radius = R1 * this (clamped)
  radiusMin: 3,
  radiusMax: 16,
  flameRate: 34, // flame particles/s per site at full strength
  flameLife: 0.8, // per-tongue lifetime (short -> flickers)
  flameRise: 9.5, // upward speed of flame tongues (taller, licking flames)
  flameSizeStart: 11, // tongues start fat and bright...
  flameSizeEnd: 3, // ...taper as they cool and rise
  emberRate: 9, // embers/s per site
  emberLife: 2.2,
  emberRise: 11.5,
  emberGravity: 3.0, // embers arc back down slightly
  emberSize: 1.8,
  smokeRate: 4.2, // smoke particles/s per site (persistent column feed)
} as const;

// ---- Progressive collapse (top-to-bottom pancaking, heavy no-bounce debris) ----
// Replaces the old "shatter everything outward at once" splay. A struck building
// is voxel-chunked, then its layers LOSE SUPPORT in sequence — the impact layer
// and everything above drop first, then each lower layer releases a beat later so
// the mass pancakes down onto its own footprint instead of splaying across town.
// Chunks are heavy (near-zero restitution, high friction, damped) so they thud
// down and settle fast — no toy bouncing. All knobs here for easy tuning.
export const COLLAPSE = {
  layerDelay: 0.08, // s between successive lower layers losing support (pancake)
  upStagger: 0.02, // s between upper (already-unsupported) layers
  releaseBase: 0.06, // brief pause before collapse propagates below impact
  scatter: 1.2, // weak lateral scatter (world u/s) — tiny vs the old outward splay
  scatterImpact: 3.2, // extra lateral ONLY at the struck layer (meteor punch-through)
  down: 1.6, // small downward kick on release (gravity does the rest)
  ejecta: 3.4, // small upward ejecta ONLY at the struck layer, for drama
  spin: 3.0, // angular velocity magnitude (calmer than the old ±9)
  restitution: 0.045, // near-zero bounce (concrete lumps)
  friction: 0.95, // high friction -> settles into a footprint pile, no sliding away
  linDamp: 0.28, // heavy: drops without floaty bounce
  angDamp: 0.62,
  density: 2.0,
} as const;

// ---- Physics ----
export const GRAVITY = -26; // stronger than earth for snappier meteor drop feel
export const FIXED_DT = 1 / 60; // fixed physics timestep (accumulator)
export const SLOMO_SCALE = 0.15; // DESIGN §4-4 timeScale
