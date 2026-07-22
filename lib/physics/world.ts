/**
 * Rapier world lifecycle + fixed-timestep accumulator + static city colliders.
 * Physics is decoupled from render fps: we accumulate real delta * timeScale
 * and step in fixed 1/60 increments (PROJECT.md §임퍼러티브 경계). Slow-mo is
 * just a smaller timeScale.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { GRAVITY, FIXED_DT } from '../constants';
import type { CityBuild } from '../city/buildCityMeshes';

type RWorld = InstanceType<typeof RAPIER.World>;
type RBody = InstanceType<typeof RAPIER.RigidBody>;

let inited = false;

/** Idempotent WASM init. Must resolve before any world/body is created. */
export async function initRapier(): Promise<void> {
  if (inited) return;
  await RAPIER.init();
  inited = true;
}

export function rapierReady(): boolean {
  return inited;
}

export function makeWorld(): RWorld {
  return new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
}

export interface StaticColliders {
  bodies: RBody[];
  buildingBodies: Map<number, RBody>;
  removeBuilding: (world: RWorld, id: number) => void;
  remove: (world: RWorld) => void;
}

/** Ground plane + one fixed cuboid per intact building. */
export function addCityColliders(world: RWorld, city: CityBuild): StaticColliders {
  const bodies: RBody[] = [];
  const buildingBodies = new Map<number, RBody>();

  // ground
  const g = city.ground;
  const groundBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, g.y, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(g.hx, g.hy, g.hz).setFriction(0.9).setRestitution(0.0),
    groundBody,
  );
  bodies.push(groundBody);

  // buildings
  for (const c of city.colliders) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(c.x, c.y, c.z),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz), body);
    bodies.push(body);
    buildingBodies.set(c.id, body);
  }

  return {
    bodies,
    buildingBodies,
    removeBuilding: (w: RWorld, id: number) => {
      const b = buildingBodies.get(id);
      if (b) {
        try {
          w.removeRigidBody(b);
        } catch {
          /* noop */
        }
        buildingBodies.delete(id);
      }
    },
    remove: (w: RWorld) => {
      for (const b of bodies) {
        try {
          w.removeRigidBody(b);
        } catch {
          /* noop */
        }
      }
      bodies.length = 0;
      buildingBodies.clear();
    },
  };
}

const MAX_SUBSTEPS = 5;

/** Fixed-timestep accumulator. fn is invoked once per fixed sub-step. */
export class FixedStepper {
  private acc = 0;
  reset() {
    this.acc = 0;
  }
  step(delta: number, timeScale: number, fn: (dt: number) => void) {
    // clamp huge deltas (tab switch) to avoid spiral of death
    this.acc += Math.min(delta, 0.1) * timeScale;
    let n = 0;
    while (this.acc >= FIXED_DT && n < MAX_SUBSTEPS) {
      fn(FIXED_DT);
      this.acc -= FIXED_DT;
      n++;
    }
    if (n >= MAX_SUBSTEPS) this.acc = 0;
  }
}
