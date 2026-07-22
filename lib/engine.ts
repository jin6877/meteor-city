/**
 * Engine — the imperative orchestrator that lives OUTSIDE React state
 * (PROJECT.md §임퍼러티브 경계). React builds the static city + owns the Canvas;
 * a single <EngineRunner> calls engine.update(delta, camera) inside useFrame.
 * Everything high-frequency (physics step, debris sync, fx, meteors, shake)
 * happens here with raw three/rapier and never triggers a React re-render.
 */
import { Group, Vector3, type Camera, type Object3D } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier, makeWorld, addCityColliders, FixedStepper, type StaticColliders } from './physics/world';
import { buildFractureCache } from './physics/fracture';
import { DebrisSystem } from './physics/debrisPool';
import { spawnMeteorBody, buildMeteorMesh, type MeteorBody } from './physics/meteor';
import { FXManager } from './fx/impact';
import { CameraShake } from './fx/cameraShake';
import { resolveMeteor, type ResolvedMeteor } from './meteorPresets';
import { SLOMO_SCALE } from './constants';
import type { QualityPreset } from './quality';
import type { CityBuild } from './city/buildCityMeshes';
import { isOverWater, type CityModel } from './city/cityTypes';
import type { MeteorType, MeteorSize } from './share';

type RWorld = InstanceType<typeof RAPIER.World>;
type REventQueue = InstanceType<typeof RAPIER.EventQueue>;

interface MeteorEntry {
  group: Group;
  body: InstanceType<typeof RAPIER.RigidBody>;
  colliderHandle: number;
  resolved: ResolvedMeteor;
  overWater: boolean;
  impacted: boolean;
  born: number;
  velDir: Vector3;
}

const BASE_BLOOM = 0.5;
const MAX_CONCURRENT_METEORS = 6;

function disposeObject(root: Object3D) {
  root.traverse((o) => {
    const mesh = o as unknown as {
      geometry?: { dispose?: () => void };
      material?: { dispose?: () => void } | { dispose?: () => void }[];
    };
    mesh.geometry?.dispose?.();
    const m = mesh.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
    else m?.dispose?.();
  });
}

export class Engine {
  readonly root = new Group();
  readonly fx = new FXManager();
  readonly shake = new CameraShake();
  readonly bloom = { value: BASE_BLOOM };

  private quality: QualityPreset;
  private world: RWorld | null = null;
  private eventQueue: REventQueue | null = null;
  private stepper = new FixedStepper();
  private debris: DebrisSystem | null = null;

  private city: CityBuild | null = null;
  private cityModel: CityModel | null = null;
  private statics: StaticColliders | null = null;

  private meteors: MeteorEntry[] = [];
  private simTime = 0;
  private timeScale = 1;
  private _off = new Vector3();
  private _tmp = new Vector3();

  ready = false;
  onImpact: ((point: Vector3, resolved: ResolvedMeteor) => void) | null = null;

  constructor(quality: QualityPreset) {
    this.quality = quality;
    this.root.name = 'engine-root';
    this.root.add(this.fx.group);
  }

  async init() {
    await initRapier();
    this.world = makeWorld();
    this.eventQueue = new RAPIER.EventQueue(true);
    const templates = buildFractureCache(2, this.quality.fractureFragments);
    this.debris = new DebrisSystem(this.world, {
      cap: this.quality.debrisCap,
      templates,
      castShadow: this.quality.debrisShadows,
    });
    this.root.add(this.debris.group);
    this.ready = true;
  }

  /** Swap in a freshly built city (regenerate / reset). */
  setCity(model: CityModel, build: CityBuild) {
    if (!this.world) return;
    // tear down previous
    if (this.statics) this.statics.remove(this.world);
    if (this.city) {
      this.root.remove(this.city.group);
      this.city.dispose();
    }
    this.clearMeteors();
    this.debris?.reset();
    this.fx.clearDecals();

    this.cityModel = model;
    this.city = build;
    this.statics = addCityColliders(this.world, build);
    this.root.add(build.group);
  }

  setTimeScale(scale: number) {
    this.timeScale = scale;
  }
  get slomo() {
    return this.timeScale < 1;
  }
  toggleSlomo(on: boolean) {
    this.timeScale = on ? SLOMO_SCALE : 1;
  }

  /** Drop a meteor aimed at a ground target point. */
  dropMeteor(target: Vector3, type: MeteorType, size: MeteorSize) {
    if (!this.world || !this.ready) return;
    if (this.meteors.length >= MAX_CONCURRENT_METEORS) return;
    const resolved = resolveMeteor(type, size);
    const H = 150;
    const spawn = new Vector3(target.x - 18, target.y + H, target.z - 13);
    const velDir = target.clone().sub(spawn).normalize();
    const vel = velDir.clone().multiplyScalar(resolved.preset.impactSpeed);
    const mb: MeteorBody = spawnMeteorBody(this.world, {
      radius: resolved.radius,
      density: resolved.preset.density,
      pos: [spawn.x, spawn.y, spawn.z],
      vel: [vel.x, vel.y, vel.z],
    });
    const group = buildMeteorMesh(resolved.preset, resolved.radius);
    group.position.copy(spawn);
    this.root.add(group);
    const overWater = this.cityModel
      ? isOverWater(this.cityModel, target.x, target.z)
      : false;
    this.meteors.push({
      group,
      body: mb.body,
      colliderHandle: mb.colliderHandle,
      resolved,
      overWater,
      impacted: false,
      born: this.simTime,
      velDir,
    });
  }

  private clearMeteors() {
    for (const mt of this.meteors) this.destroyMeteor(mt);
    this.meteors.length = 0;
  }
  private destroyMeteor(mt: MeteorEntry) {
    this.root.remove(mt.group);
    disposeObject(mt.group);
    if (this.world) {
      try {
        this.world.removeRigidBody(mt.body);
      } catch {
        /* noop */
      }
    }
  }

  reset() {
    // caller (React) rebuilds the city meshes and calls setCity; this just
    // clears transient state in case reset is called standalone.
    this.clearMeteors();
    this.debris?.reset();
    this.fx.clearDecals();
  }

  // ---- main loop ----
  update(delta: number, camera: Camera) {
    if (!this.world || !this.ready) return;
    this.stepper.step(delta, this.timeScale, (dt) => this.fixedStep(dt));
    this.syncMeteorMeshes(delta);
    this.shake.apply(camera, delta, this._off);
    this.bloom.value = Math.max(BASE_BLOOM, this.fx.bloomEnergy);
  }

  private fixedStep(dt: number) {
    const world = this.world!;
    const eq = this.eventQueue!;
    world.step(eq);
    this.simTime += dt;

    eq.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
      if (!started) return;
      for (const mt of this.meteors) {
        if (!mt.impacted && (h1 === mt.colliderHandle || h2 === mt.colliderHandle)) {
          mt.impacted = true;
        }
      }
    });

    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const mt = this.meteors[i];
      if (mt.impacted) {
        this.resolveImpact(mt);
        this.meteors.splice(i, 1);
      } else if (mt.body.translation().y < -40) {
        this.destroyMeteor(mt);
        this.meteors.splice(i, 1);
      }
    }

    this.debris?.update(this.simTime);
    this.fx.update(dt);
  }

  private resolveImpact(mt: MeteorEntry) {
    const t = mt.body.translation();
    const impact = new Vector3(t.x, Math.max(0.3, t.y), t.z);
    this.applyDestruction(impact, mt.resolved);
    this.fx.triggerImpact(
      [impact.x, impact.y, impact.z],
      mt.resolved.preset,
      mt.resolved.R1,
      mt.resolved.R2,
      mt.overWater,
    );
    const trauma = Math.min(0.9, 0.4 * mt.resolved.preset.shakeScale * (mt.resolved.R2 / 30));
    this.shake.add(trauma);
    this.destroyMeteor(mt);
    this.onImpact?.(impact, mt.resolved);
  }

  private applyDestruction(impact: Vector3, resolved: ResolvedMeteor) {
    if (!this.city || !this.statics || !this.debris || !this.world) return;
    const { R1, R2 } = resolved;
    const cores: { id: number; d: number }[] = [];
    const blasts: number[] = [];

    for (const info of this.city.infos.values()) {
      if (!info.alive) continue;
      const dx = info.center[0] - impact.x;
      const dz = info.center[2] - impact.z;
      const d = Math.hypot(dx, dz);
      if (d < R1) cores.push({ id: info.id, d });
      else if (d < R2) blasts.push(info.id);
    }
    cores.sort((a, b) => a.d - b.d);

    const maxF = this.quality.maxFractureBuildings;
    const preset = resolved.preset;
    const jitter = preset.id === 'jagged' ? 0.8 : 0.25;

    for (let i = 0; i < cores.length; i++) {
      const info = this.city.infos.get(cores[i].id)!;
      this.city.destroyBuilding(info.id);
      this.statics.removeBuilding(this.world, info.id);
      if (i < maxF) {
        this.debris.fractureBuilding(
          info.center,
          info.size,
          info.color,
          impact,
          preset.fragmentImpulse,
          preset.hotDebris,
          jitter,
        );
      } else {
        this.debris.toppleBuilding(info.center, info.size, info.color, impact);
      }
    }
    for (const id of blasts) {
      const info = this.city.infos.get(id)!;
      this.city.destroyBuilding(id);
      this.statics.removeBuilding(this.world, id);
      this.debris.toppleBuilding(info.center, info.size, info.color, impact);
    }
  }

  private syncMeteorMeshes(delta: number) {
    for (const mt of this.meteors) {
      const t = mt.body.translation();
      mt.group.position.set(t.x, t.y, t.z);
      // orient so the tail (local +y) trails opposite travel direction
      const lv = mt.body.linvel();
      this._tmp.set(lv.x, lv.y, lv.z);
      if (this._tmp.lengthSq() > 1) {
        mt.velDir.copy(this._tmp).normalize();
        mt.group.quaternion.setFromUnitVectors(
          new Vector3(0, 1, 0),
          mt.velDir.clone().multiplyScalar(-1),
        );
      }
      // spin the rock body child for tumble
      const rock = mt.group.children[0];
      if (rock) rock.rotateY(delta * 2.2);
    }
  }

  getStats() {
    let alive = 0;
    if (this.city) for (const i of this.city.infos.values()) if (i.alive) alive++;
    return {
      ready: this.ready,
      buildingsAlive: alive,
      debris: this.debris?.count ?? 0,
      meteors: this.meteors.length,
      slomo: this.slomo,
    };
  }

  dispose() {
    this.clearMeteors();
    if (this.statics && this.world) this.statics.remove(this.world);
    if (this.city) {
      this.root.remove(this.city.group);
      this.city.dispose();
    }
    this.debris?.dispose();
    // Rapier world has no explicit free in compat; drop references
    this.world = null;
    this.ready = false;
  }
}
