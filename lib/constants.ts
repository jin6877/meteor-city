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

// ---- Rising smoke (impact residue — separate budget from debris/rubble) ----
// A dark warm-gray column that rises off the crater and slowly disperses. Kept
// restrained (low alpha, expands + fades) for the diorama tone — NOT photoreal
// thick smoke (DESIGN §7 Don't). All knobs live here for easy tuning.
export const SMOKE = {
  color: 0x4c4842, // dark warm gray (diorama smoke, never pure black)
  colorCool: 0x8b9496, // comet / over-water: paler cool wisp
  rise: 3.2, // base upward speed (world units/s)
  riseJitter: 1.8, // per-particle rise variance (elongates the plume)
  seedColumn: 3.6, // initial vertical seed spread (starts as a short column)
  spread: 1.4, // initial horizontal seed radius (tight = column)
  drift: 1.0, // lateral drift speed as it disperses
  life: 5.5, // seconds — lingers well past the fast dust
  hold: 0.5, // fraction of life held near peak before the slow fade
  peakAlpha: 0.46, // restrained but readable (miniature tone, still translucent)
  sizeStart: 6, // billboard size at birth
  sizeEnd: 16, // billboard size at death (puff expands as it dissipates)
} as const;

// ---- Physics ----
export const GRAVITY = -26; // stronger than earth for snappier meteor drop feel
export const FIXED_DT = 1 / 60; // fixed physics timestep (accumulator)
export const SLOMO_SCALE = 0.15; // DESIGN §4-4 timeScale
