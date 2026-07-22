/**
 * Pure data model for a generated city. No three / rapier imports here — this
 * is what generateCity() returns and what buildCityMeshes() consumes, so the
 * generator stays deterministic and unit-testable (PROJECT.md §1).
 */
import type { MaterialFamily } from '../constants';

export type BlockType =
  | 'downtown'
  | 'residential'
  | 'commercial'
  | 'park'
  | 'plaza'
  | 'water';

export type Archetype =
  | 'boxTower'
  | 'setbackTower'
  | 'slab'
  | 'gableHouse'
  | 'warehouse';

export interface Tier {
  /** box footprint width/depth and height, stacked bottom->top */
  w: number;
  d: number;
  h: number;
  yBase: number;
}

export interface BuildingModel {
  id: number;
  cx: number; // footprint center x
  cz: number; // footprint center z
  w: number; // full bounding width
  d: number; // full bounding depth
  h: number; // full bounding height
  family: MaterialFamily;
  archetype: Archetype;
  color: number; // jittered base color (hex)
  roofColor: number;
  roofType: 'flat' | 'gable';
  tiers: Tier[]; // render boxes (1 for simple, 2 for setback)
  windows: { cols: number; floors: number } | null;
}

export interface TreeModel {
  x: number;
  z: number;
  scale: number;
  rot: number;
  leafColor: number;
}

export interface RoadStrip {
  x: number; // center
  z: number;
  w: number; // extent x
  d: number; // extent z
  bridge: boolean;
}

export interface WaterRect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface SplashPad {
  // sidewalk/plaza pad under a block (visual grounding)
  x: number;
  z: number;
  w: number;
  d: number;
  color: number;
}

export interface CityModel {
  seed: number;
  gridN: number;
  pitch: number; // cell + road
  cell: number;
  road: number;
  span: number; // total city extent (x/z)
  center: [number, number]; // world center (x,z)
  radius: number; // bounding radius for camera / fog / shadow frustum
  buildings: BuildingModel[];
  trees: TreeModel[];
  roads: RoadStrip[];
  water: WaterRect[];
  pads: SplashPad[];
  baseColor: number;
  grassColor: number;
}

/** Is a world point over water? Used to branch impact FX (splash vs crater). */
export function isOverWater(model: CityModel, x: number, z: number): boolean {
  for (const w of model.water) {
    if (
      x >= w.x - w.w / 2 &&
      x <= w.x + w.w / 2 &&
      z >= w.z - w.d / 2 &&
      z <= w.z + w.d / 2
    ) {
      return true;
    }
  }
  return false;
}
