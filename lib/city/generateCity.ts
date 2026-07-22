/**
 * Deterministic procedural city generator (PROJECT.md §1). Pure: seed in,
 * CityModel out, no three/rapier. Every random draw comes from one mulberry32
 * stream in a fixed order (gridN -> river -> per-cell types -> per-cell
 * buildings/trees) so the same seed reproduces the same city exactly.
 */
import { Rng } from '../rng';
import { CELL, ROAD, FAMILY, LEAF_COLORS, type MaterialFamily } from '../constants';
import type {
  CityModel,
  BuildingModel,
  TreeModel,
  BlockType,
  Archetype,
  RoadStrip,
  WaterRect,
  SplashPad,
  Tier,
} from './cityTypes';
import { SIDEWALK } from '../constants';

// ---- tiny hex<->hsl helpers (pure, no three) for seed jitter ----
function hexToRgb(hex: number) {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 };
}
function rgbToHex(r: number, g: number, b: number) {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}
function rgbToHsl(r: number, g: number, b: number) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}
function hslToRgb(h: number, s: number, l: number) {
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: hk(h + 1 / 3), g: hk(h), b: hk(h - 1 / 3) };
}

/** Per-family seed jitter: hue ±6deg / sat ±0.04 / value ±0.08 (DESIGN §2). */
function jitterColor(rng: Rng, hex: number): number {
  const { r, g, b } = hexToRgb(hex);
  let { h, s, l } = rgbToHsl(r, g, b);
  h = (h + rng.range(-6, 6) / 360 + 1) % 1;
  s = Math.max(0, Math.min(1, s + rng.range(-0.04, 0.04)));
  l = Math.max(0, Math.min(1, l + rng.range(-0.08, 0.08)));
  const out = hslToRgb(h, s, l);
  return rgbToHex(out.r, out.g, out.b);
}

const ARCH_FAMILY: Record<Archetype, MaterialFamily> = {
  boxTower: 'glass',
  setbackTower: 'glass',
  slab: 'concrete',
  gableHouse: 'brick',
  warehouse: 'panel',
};

export function generateCity(seed: number): CityModel {
  const rng = new Rng(seed >>> 0);
  // wider city (bigger grid = more blocks/roads/buildings). Kept seed-derived
  // (NOT tier-derived) so a shared ?seed= reproduces the same city on every
  // device; tiers scale only render cost (trees, debris cap, agents, AO).
  const gridN = rng.int(8, 12);
  const pitch = CELL + ROAD;
  const span = gridN * pitch + ROAD;
  const half = span / 2;
  const cellCenter = (i: number) => -half + ROAD + CELL / 2 + i * pitch;
  const centerIdx = (gridN - 1) / 2;
  const maxDist = Math.hypot(centerIdx, centerIdx) || 1;

  // ---- river (PROJECT.md §1.3) ----
  const water: WaterRect[] = [];
  const isWater: boolean[][] = Array.from({ length: gridN }, () =>
    Array<boolean>(gridN).fill(false),
  );
  if (rng.chance(0.5)) {
    const horizontal = rng.chance(0.5);
    const line = rng.int(1, gridN - 2);
    for (let k = 0; k < gridN; k++) {
      if (horizontal) isWater[k][line] = true;
      else isWater[line][k] = true;
    }
    // L-arm
    if (rng.chance(0.5)) {
      const turn = rng.int(1, gridN - 2);
      const toEnd = rng.chance(0.5);
      const from = line;
      const lo = toEnd ? from : 0;
      const hi = toEnd ? gridN - 1 : from;
      for (let k = lo; k <= hi; k++) {
        if (horizontal) isWater[turn][k] = true;
        else isWater[k][turn] = true;
      }
    }
  }

  // ---- block types (distance-weighted) ----
  const types: BlockType[][] = Array.from({ length: gridN }, () =>
    Array<BlockType>(gridN).fill('residential'),
  );
  for (let i = 0; i < gridN; i++) {
    for (let j = 0; j < gridN; j++) {
      if (isWater[i][j]) {
        types[i][j] = 'water';
        continue;
      }
      const dn = Math.hypot(i - centerIdx, j - centerIdx) / maxDist;
      types[i][j] = rng.weighted<BlockType>([
        ['downtown', Math.max(0.02, 1 - dn * 1.7)],
        ['commercial', 0.55],
        ['residential', 0.35 + dn * 0.9],
        ['park', 0.16 + dn * 0.18],
        ['plaza', 0.12],
      ]);
    }
  }

  const buildings: BuildingModel[] = [];
  const trees: TreeModel[] = [];
  const pads: SplashPad[] = [];
  let bid = 0;

  const heightRange = (t: BlockType, dn: number): [number, number] => {
    switch (t) {
      case 'downtown':
        // taller toward the center
        return [30 + (1 - dn) * 18, 52 + (1 - dn) * 28];
      case 'commercial':
        return [12, 28];
      case 'residential':
        return [4, 12];
      case 'plaza':
        return [3, 8];
      default:
        return [3, 6];
    }
  };

  const lotSplit = (t: BlockType): [number, number] => {
    switch (t) {
      case 'downtown':
        return rng.chance(0.6) ? [1, 1] : [2, 2];
      case 'commercial':
        return rng.chance(0.5) ? [1, 2] : [2, 2];
      case 'residential':
        return rng.pick([
          [2, 2],
          [2, 3],
          [3, 3],
        ] as [number, number][]);
      case 'plaza':
        return [1, 1];
      default:
        return [1, 1];
    }
  };

  const archFor = (t: BlockType): Archetype => {
    switch (t) {
      case 'downtown':
        return rng.weighted<Archetype>([
          ['boxTower', 0.5],
          ['setbackTower', 0.35],
          ['slab', 0.15],
        ]);
      case 'commercial':
        return rng.weighted<Archetype>([
          ['slab', 0.5],
          ['warehouse', 0.25],
          ['boxTower', 0.25],
        ]);
      case 'residential':
        return rng.weighted<Archetype>([
          ['gableHouse', 0.7],
          ['slab', 0.3],
        ]);
      case 'plaza':
        return 'warehouse';
      default:
        return 'warehouse';
    }
  };

  for (let i = 0; i < gridN; i++) {
    for (let j = 0; j < gridN; j++) {
      const t = types[i][j];
      const cx = cellCenter(i);
      const cz = cellCenter(j);
      const dn = Math.hypot(i - centerIdx, j - centerIdx) / maxDist;

      if (t === 'water') continue;

      if (t === 'park') {
        // grass cell + tree scatter (no sidewalk pad)
        const n = rng.int(4, 9);
        for (let k = 0; k < n; k++) {
          trees.push({
            x: cx + rng.range(-CELL / 2 + 2, CELL / 2 - 2),
            z: cz + rng.range(-CELL / 2 + 2, CELL / 2 - 2),
            scale: rng.range(1.4, 3.0),
            rot: rng.range(0, Math.PI * 2),
            leafColor: rng.pick(LEAF_COLORS),
          });
        }
        continue;
      }

      // sidewalk / plaza pad under the block
      pads.push({ x: cx, z: cz, w: CELL, d: CELL, color: SIDEWALK });

      const [nx, nz] = lotSplit(t);
      const lotW = CELL / nx;
      const lotD = CELL / nz;
      const [hlo, hhi] = heightRange(t, dn);

      for (let li = 0; li < nx; li++) {
        for (let lj = 0; lj < nz; lj++) {
          // skip a lot occasionally for variety (not downtown 1x1)
          if (!(nx === 1 && nz === 1) && rng.chance(0.12)) continue;
          const lotCx = cx - CELL / 2 + lotW * (li + 0.5);
          const lotCz = cz - CELL / 2 + lotD * (lj + 0.5);
          const margin = t === 'downtown' ? 2.2 : 1.4;
          const w = Math.max(3, (lotW - margin * 2) * rng.range(0.82, 1.0));
          const d = Math.max(3, (lotD - margin * 2) * rng.range(0.82, 1.0));
          const h = rng.range(hlo, hhi);
          const arch = archFor(t);
          const family = ARCH_FAMILY[arch];

          const color = jitterColor(rng, rng.pick(FAMILY[family].variants));
          const isLandmark = t === 'downtown' && rng.chance(0.08);
          const roofColor = jitterColor(
            rng,
            isLandmark ? 0x6e8c7a : rng.pick(FAMILY.roof.variants.slice(0, 2)),
          );

          const tiers: Tier[] = [];
          let roofType: 'flat' | 'gable' = 'flat';

          if (arch === 'setbackTower') {
            const h1 = h * rng.range(0.55, 0.68);
            tiers.push({ w, d, h: h1, yBase: 0 });
            tiers.push({
              w: w * 0.66,
              d: d * 0.66,
              h: h - h1,
              yBase: h1,
            });
          } else if (arch === 'gableHouse') {
            roofType = 'gable';
            tiers.push({ w, d, h, yBase: 0 });
          } else {
            tiers.push({ w, d, h, yBase: 0 });
          }

          const wantsWindows = family === 'glass' || family === 'concrete';
          const windows = wantsWindows
            ? {
                cols: Math.max(2, Math.round(w / 3.2)),
                floors: Math.max(2, Math.round(h / 3.6)),
              }
            : null;

          buildings.push({
            id: bid++,
            cx: lotCx,
            cz: lotCz,
            w,
            d,
            h,
            family,
            archetype: arch,
            color,
            roofColor,
            roofType,
            tiers,
            windows,
          });

          // occasional street tree at residential lot corner
          if (t === 'residential' && rng.chance(0.25)) {
            trees.push({
              x: lotCx + rng.sign() * lotW * 0.42,
              z: lotCz + rng.sign() * lotD * 0.42,
              scale: rng.range(1.2, 2.2),
              rot: rng.range(0, Math.PI * 2),
              leafColor: rng.pick(LEAF_COLORS),
            });
          }
        }
      }
    }
  }

  // ---- water rects (one per water cell) ----
  for (let i = 0; i < gridN; i++) {
    for (let j = 0; j < gridN; j++) {
      if (isWater[i][j]) {
        water.push({
          x: cellCenter(i),
          z: cellCenter(j),
          w: pitch,
          d: pitch,
        });
      }
    }
  }

  // ---- road grid strips (merged later into 1 draw call) ----
  const roads: RoadStrip[] = [];
  for (let g = 0; g <= gridN; g++) {
    const p = -half + ROAD / 2 + g * pitch;
    roads.push({ x: 0, z: p, w: span, d: ROAD, bridge: false }); // horizontal
    roads.push({ x: p, z: 0, w: ROAD, d: span, bridge: false }); // vertical
  }

  const radius = Math.hypot(span, span) / 2;

  return {
    seed: seed >>> 0,
    gridN,
    pitch,
    cell: CELL,
    road: ROAD,
    span,
    center: [0, 0],
    radius,
    buildings,
    trees,
    roads,
    water,
    pads,
    baseColor: 0x9a8e76,
    grassColor: 0x7c8b57,
  };
}
