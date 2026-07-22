/**
 * Meteor presets (PROJECT.md §2 + DESIGN §4-1). Four types differentiated by
 * silhouette, material, glow, trail and impact personality. Size S/M/L are pure
 * multipliers so tuning + sharing stay simple. Values are seed-points; tune ±.
 */
import type { MeteorType, MeteorSize } from './share';

export interface MeteorPreset {
  id: MeteorType;
  label: string;
  // ---- geometry ----
  /** base radius at size M */
  radius: number;
  /** icosphere subdivision */
  detail: number;
  /** vertex displacement amount (0 = smooth) */
  noise: number;
  /** flat-shaded angular look (jagged) */
  flat: boolean;
  density: number; // mass = density * (4/3 pi r^3)
  impactSpeed: number; // initial downward speed
  // ---- material ----
  bodyColor: number;
  roughness: number;
  metalness: number;
  emissive: number;
  emissiveIntensity: number;
  // ---- trail / dust ----
  trailColor: number;
  dustColor: number;
  dustAmount: number; // multiplier on particle count
  dustCool: boolean;
  // ---- blast radii at size M (scaled by size + a global cityScale) ----
  R1: number; // core fracture radius
  R2: number; // blast / topple radius
  R3: number; // fringe decal radius
  fragmentImpulse: number; // radial impulse scale applied to fragments
  // ---- impact look ----
  flashColor: number;
  flashIntensity: number;
  bloomSpike: number; // target Bloom intensity at impact
  hotDebris: number; // emissive/hot cool-down color for core chunks
  craterDark: number; // crater center color
  craterScale: number; // crater/scorch decal size multiplier
  shakeScale: number; // camera trauma multiplier
}

export const METEOR_PRESETS: Record<MeteorType, MeteorPreset> = {
  rocky: {
    id: 'rocky',
    label: '암석형',
    radius: 4.2,
    detail: 2,
    noise: 0.28,
    flat: false,
    density: 3.0,
    impactSpeed: 70,
    bodyColor: 0x3e3833,
    roughness: 0.85,
    metalness: 0.0,
    emissive: 0xff7a3c,
    emissiveIntensity: 0.15,
    trailColor: 0x8a857c,
    dustColor: 0x9a8f7e,
    dustAmount: 1.0,
    dustCool: false,
    R1: 16,
    R2: 30,
    R3: 46,
    fragmentImpulse: 1.0,
    flashColor: 0xfff0d0,
    flashIntensity: 6.0,
    bloomSpike: 1.4,
    hotDebris: 0xc24a20,
    craterDark: 0x2e2a26,
    craterScale: 1.0,
    shakeScale: 1.0,
  },
  iron: {
    id: 'iron',
    label: '철운석',
    radius: 3.2,
    detail: 2,
    noise: 0.14,
    flat: false,
    density: 8.0, // very dense -> heavy, punchy
    impactSpeed: 92,
    bodyColor: 0x5a5652,
    roughness: 0.35, // satin, not chrome
    metalness: 0.9,
    emissive: 0xff5a1e,
    emissiveIntensity: 0.5,
    trailColor: 0xffb060,
    dustColor: 0x8a7f70,
    dustAmount: 0.8,
    dustCool: false,
    R1: 12,
    R2: 24,
    R3: 38,
    fragmentImpulse: 1.6, // deeper crater, higher impulse
    flashColor: 0xfff6e8,
    flashIntensity: 8.0,
    bloomSpike: 1.5,
    hotDebris: 0xff6a20,
    craterDark: 0x201d1a, // deeper + darker
    craterScale: 0.85,
    shakeScale: 1.25,
  },
  jagged: {
    id: 'jagged',
    label: '파쇄형',
    radius: 4.0,
    detail: 1,
    noise: 0.5,
    flat: true, // angular flat-normal facets
    density: 3.2,
    impactSpeed: 74,
    bodyColor: 0x4c453f,
    roughness: 0.8,
    metalness: 0.02,
    emissive: 0x7a7269,
    emissiveIntensity: 0.05,
    trailColor: 0x8f8880,
    dustColor: 0x968b7c,
    dustAmount: 1.2,
    dustCool: false,
    R1: 15,
    R2: 30,
    R3: 44,
    fragmentImpulse: 1.15, // scattered / asymmetric (jittered in code)
    flashColor: 0xffedcf,
    flashIntensity: 6.5,
    bloomSpike: 1.35,
    hotDebris: 0xb04a24,
    craterDark: 0x2b2723,
    craterScale: 1.05,
    shakeScale: 1.1,
  },
  comet: {
    id: 'comet',
    label: '혜성',
    radius: 5.6,
    detail: 2,
    noise: 0.22,
    flat: false,
    density: 1.1, // icy, light
    impactSpeed: 66,
    bodyColor: 0xc4d2d6,
    roughness: 0.4,
    metalness: 0.0,
    emissive: 0xddeaf0,
    emissiveIntensity: 0.35,
    trailColor: 0x8fb8d8,
    dustColor: 0xd8e2e6,
    dustAmount: 1.6, // most dust
    dustCool: true,
    R1: 20,
    R2: 40,
    R3: 60, // wide shallow blast
    fragmentImpulse: 0.9,
    flashColor: 0xf0faff,
    flashIntensity: 9.5, // brightest flash
    bloomSpike: 1.6, // max bloom
    hotDebris: 0x7fa8c8,
    craterDark: 0x384a50, // frosted, brighter ring
    craterScale: 1.3, // widest
    shakeScale: 1.0,
  },
};

/** Size multipliers (S/M/L) — DESIGN §2 크기 토글 3단. */
export const SIZE_MULT: Record<MeteorSize, { radius: number; blast: number }> = {
  S: { radius: 0.72, blast: 0.75 },
  M: { radius: 1.0, blast: 1.0 },
  L: { radius: 1.42, blast: 1.4 },
};

/** Resolved per-drop parameters after applying size. */
export interface ResolvedMeteor {
  preset: MeteorPreset;
  radius: number;
  mass: number;
  R1: number;
  R2: number;
  R3: number;
}

export function resolveMeteor(type: MeteorType, size: MeteorSize): ResolvedMeteor {
  const preset = METEOR_PRESETS[type];
  const sm = SIZE_MULT[size];
  const radius = preset.radius * sm.radius;
  const volume = (4 / 3) * Math.PI * radius * radius * radius;
  return {
    preset,
    radius,
    mass: preset.density * volume,
    R1: preset.R1 * sm.blast,
    R2: preset.R2 * sm.blast,
    R3: preset.R3 * sm.blast,
  };
}
