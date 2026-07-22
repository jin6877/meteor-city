/**
 * GPU quality tiers (PROJECT.md §6 성능 예산 / DESIGN §7). We detect a coarse
 * tier from the WebGL renderer string + device signals, then hand back a
 * preset that scales the heavy knobs: debris cap, tree count, shadow map,
 * PostFX toggles, fracture fragment count, dpr. Low tier is the mobile/iGPU
 * fallback — the app still runs, just degraded.
 */

export type Tier = 'high' | 'low';

export interface QualityPreset {
  tier: Tier;
  debrisCap: number; // global dynamic-fragment cap
  maxFractureBuildings: number; // per-impact fully-fractured building cap
  fractureCounts: number[]; // available fragment counts (coarse..fine); cache builds one template each
  fragmentsCoarse: number; // count used for small/far buildings
  fragmentsFine: number; // count used for large/near buildings
  treeFactor: number; // multiplier on generated tree count
  agentCars: number; // roaming vehicles
  agentPeds: number; // roaming pedestrians
  shadows: boolean;
  shadowMapSize: number;
  dpr: [number, number];
  bloom: boolean;
  ao: boolean;
  tiltShift: boolean;
  chromaticAberration: boolean;
  vignette: boolean;
  debrisShadows: boolean;
}

const HIGH: QualityPreset = {
  tier: 'high',
  debrisCap: 340,
  maxFractureBuildings: 12,
  fractureCounts: [12, 20],
  fragmentsCoarse: 12,
  fragmentsFine: 20,
  treeFactor: 1,
  agentCars: 46,
  agentPeds: 64,
  shadows: true,
  shadowMapSize: 2048,
  dpr: [1, 2],
  bloom: true,
  ao: true,
  tiltShift: true,
  chromaticAberration: true,
  vignette: true,
  debrisShadows: true,
};

const LOW: QualityPreset = {
  tier: 'low',
  debrisCap: 130,
  maxFractureBuildings: 7,
  fractureCounts: [9],
  fragmentsCoarse: 9,
  fragmentsFine: 9,
  treeFactor: 0.5,
  agentCars: 18,
  agentPeds: 24,
  shadows: true,
  shadowMapSize: 1024,
  dpr: [1, 1.5],
  bloom: true,
  ao: false, // N8AO is the biggest cost — drop it first on low tier
  tiltShift: true,
  chromaticAberration: false,
  vignette: true,
  debrisShadows: false,
};

/** Read the unmasked GPU renderer string, if the browser exposes it. */
function getRendererString(): string {
  if (typeof document === 'undefined') return '';
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    }
    return String(gl.getParameter(gl.RENDERER) || '');
  } catch {
    return '';
  }
}

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const coarse =
    typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const ua = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  return coarse || ua;
}

let cached: QualityPreset | null = null;

export function detectQuality(forced?: Tier): QualityPreset {
  if (forced) return forced === 'high' ? HIGH : LOW;
  if (cached) return cached;

  const renderer = getRendererString().toLowerCase();
  let tier: Tier = 'high';

  if (isMobile()) tier = 'low';

  // Known weak / integrated GPU signatures -> low tier.
  const weak = [
    'swiftshader',
    'llvmpipe',
    'software',
    'intel',
    'apple gpu',
    'mali',
    'adreno',
    'powervr',
    'uhd graphics',
    'hd graphics',
  ];
  if (weak.some((w) => renderer.includes(w))) tier = 'low';

  // Discrete GPU signatures re-promote (a discrete card named "intel"? rare).
  const strong = ['rtx', 'geforce', 'radeon rx', 'radeon pro', 'quadro', 'arc a'];
  if (strong.some((s) => renderer.includes(s))) tier = 'high';

  cached = tier === 'high' ? HIGH : LOW;
  return cached;
}

export function presetForTier(tier: Tier): QualityPreset {
  return tier === 'high' ? HIGH : LOW;
}
