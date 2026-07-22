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
import { DebrisSystem } from './physics/debrisPool';
import { spawnMeteorBody, buildMeteorMesh, type MeteorBody } from './physics/meteor';
import { FXManager } from './fx/impact';
import { CameraShake } from './fx/cameraShake';
import { AgentSystem } from './agents';
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
  radius: number;
}

interface EmbeddedMeteor {
  group: Group;
  mat: { emissiveIntensity: number } | null;
  start: number; // initial emissive intensity (for cool-down)
  born: number;
}

const MAX_EMBEDDED = 10;

const BASE_BLOOM = 0.25; // Bloom now runs on tone-mapped color; keep the city calm, spike only on impact
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
  readonly fx: FXManager;
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
  private agents: AgentSystem | null = null;

  private meteors: MeteorEntry[] = [];
  private embedded: EmbeddedMeteor[] = [];
  private simTime = 0;
  private timeScale = 1;
  private _off = new Vector3();
  private _tmp = new Vector3();

  ready = false;
  lastImpactPoint: [number, number, number] | null = null; // for verification (contact height)
  onImpact: ((point: Vector3, resolved: ResolvedMeteor) => void) | null = null;

  constructor(quality: QualityPreset) {
    this.quality = quality;
    this.fx = new FXManager({ lowTier: quality.tier === 'low' });
    this.root.name = 'engine-root';
    this.root.add(this.fx.group);
  }

  async init() {
    await initRapier();
    this.world = makeWorld();
    this.eventQueue = new RAPIER.EventQueue(true);
    this.debris = new DebrisSystem(this.world, {
      activeCap: this.quality.activeCap,
      rubbleCap: this.quality.rubbleCap,
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
    this.fx.clearSmoke();
    if (this.agents) {
      this.root.remove(this.agents.group);
      this.agents.dispose();
      this.agents = null;
    }

    this.cityModel = model;
    this.city = build;
    this.statics = addCityColliders(this.world, build);
    this.root.add(build.group);

    // roaming cars + pedestrians on the (now wider) road grid
    this.agents = new AgentSystem(model, {
      cars: this.quality.agentCars,
      peds: this.quality.agentPeds,
      shadows: this.quality.debrisShadows,
    });
    this.root.add(this.agents.group);
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
      radius: resolved.radius,
    });
  }

  private clearMeteors() {
    for (const mt of this.meteors) this.destroyMeteor(mt);
    this.meteors.length = 0;
    for (const em of this.embedded) {
      this.root.remove(em.group);
      disposeObject(em.group);
    }
    this.embedded.length = 0;
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
    this.fx.clearSmoke();
  }

  // ---- main loop ----
  update(delta: number, camera: Camera) {
    if (!this.world || !this.ready) return;
    this.stepper.step(delta, this.timeScale, (dt) => this.fixedStep(dt));
    this.syncMeteorMeshes(delta);
    this.agents?.update(delta * this.timeScale); // slow-mo affects traffic too
    this.coolEmbedded();
    this.shake.apply(camera, delta, this._off);
    this.bloom.value = Math.max(BASE_BLOOM, this.fx.bloomEnergy);
  }

  private coolEmbedded() {
    for (const em of this.embedded) {
      if (!em.mat) continue;
      const age = this.simTime - em.born;
      const k = Math.max(0.12, 1 - age / 3.5); // cools to embers, keeps a faint glow
      em.mat.emissiveIntensity = em.start * k;
    }
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
    const contactY = Math.max(0.3, t.y);
    const preset = mt.resolved.preset;
    const impact = new Vector3(t.x, contactY, t.z);
    this.lastImpactPoint = [t.x, contactY, t.z];

    // burst (flash/ring/dust/bloom) AT the contact height — a building-top hit
    // explodes up high, a ground hit explodes low (item 5).
    this.fx.burst([t.x, contactY, t.z], preset, mt.resolved.R1, mt.resolved.R2, mt.overWater);
    // buildings + trees within the blast radius break apart / collapse
    this.applyDestruction(impact, mt.resolved);
    this.shake.add(Math.min(0.9, 0.4 * preset.shakeScale * (mt.resolved.R2 / 30)));

    // meteor punches down and embeds in a ground crater directly below (item 2)
    if (mt.overWater) {
      this.destroyMeteor(mt); // splash, nothing to embed
    } else {
      this.fx.crater([t.x, 0.1, t.z], preset, mt.overWater);
      this.embedMeteor(mt, t.x, t.z);
      // main blaze at the crater — bigger blasts burn bigger/longer (comet frosts)
      this.fx.ignite([t.x, 0.5, t.z], mt.resolved.R1, preset.dustCool);
    }
    this.onImpact?.(impact, mt.resolved);
  }

  /** Free the meteor's body; leave the mesh half-buried in the crater, cooling. */
  private embedMeteor(mt: MeteorEntry, x: number, z: number) {
    if (this.world) {
      try {
        this.world.removeRigidBody(mt.body);
      } catch {
        /* noop */
      }
    }
    const g = mt.group;
    g.position.set(x, -mt.radius * 0.42, z); // ~40% below the ground plane
    g.rotation.set(
      (Math.random() - 0.5) * 0.5,
      Math.random() * Math.PI,
      (Math.random() - 0.5) * 0.5,
    );
    const tail = g.userData.tail as { visible: boolean } | undefined;
    if (tail) tail.visible = false;
    const mat = (g.userData.meshMat as { emissiveIntensity: number } | undefined) ?? null;
    this.embedded.push({
      group: g,
      mat,
      start: mat ? mat.emissiveIntensity : 0,
      born: this.simTime,
    });
    while (this.embedded.length > MAX_EMBEDDED) {
      const old = this.embedded.shift()!;
      this.root.remove(old.group);
      disposeObject(old.group);
    }
  }

  private applyDestruction(impact: Vector3, resolved: ResolvedMeteor) {
    if (!this.city || !this.statics || !this.debris || !this.world) return;
    const { R1, R2 } = resolved;
    const preset = resolved.preset;
    const jitter = preset.id === 'jagged' ? 0.8 : 0.25;
    const coarse = this.quality.chunksCoarse;
    const fine = this.quality.chunksFine;

    // Buildings within R2 collapse. Nearest ones (up to the per-impact cap) get
    // voxel-chunked into physics rubble; the far overflow collapses straight to
    // static rubble piles. Nothing survives standing.
    const hit: { id: number; d: number }[] = [];
    for (const info of this.city.infos.values()) {
      if (!info.alive) continue;
      const dx = info.center[0] - impact.x;
      const dz = info.center[2] - impact.z;
      const d = Math.hypot(dx, dz);
      if (d < R2) hit.push({ id: info.id, d });
    }
    hit.sort((a, b) => a.d - b.d);

    const maxF = this.quality.maxFractureBuildings;
    let firesLit = 0;
    const maxFires = 4; // per impact — fires accumulate across hits up to the site cap
    for (let i = 0; i < hit.length; i++) {
      const c = hit[i];
      const info = this.city.infos.get(c.id)!;
      this.city.destroyBuilding(info.id);
      this.statics.removeBuilding(this.world, info.id);
      if (i < maxF) {
        // near / tall buildings shatter into more chunks (size + zone proportional)
        const tall = info.size[1] > 22;
        const desired = c.d < R1 || tall ? fine : coarse;
        this.debris.fractureBuilding(
          info.center,
          info.size,
          info.color,
          impact,
          preset.fragmentImpulse,
          preset.hotDebris,
          jitter,
          desired,
        );
      } else {
        this.debris.collapseToRubble(info.center, info.size, info.color);
      }
      // scatter a few blazes across the leveled footprints (comet frosts instead)
      if (firesLit < maxFires && c.d < R2 * 0.75) {
        this.fx.ignite([info.center[0], 0.5, info.center[2]], R1 * 0.55, preset.dustCool);
        firesLit++;
      }
    }

    // trees within the blast are felled — near ones fly, the rest leave a stump
    const removed = this.city.removeTreesInRadius(impact.x, impact.z, R2 * 0.95);
    let flew = 0;
    for (const tr of removed) {
      const d = Math.hypot(tr.x - impact.x, tr.z - impact.z);
      if (d < R1 * 1.2 && flew < 10) {
        this.debris.spawnFlyingChunk([tr.x, 2 * tr.scale, tr.z], 1.3 * tr.scale, tr.leafColor, impact);
        flew++;
      } else {
        this.debris.treeStump(tr.x, tr.z, tr.scale, tr.leafColor);
      }
    }

    this.agents?.reactToImpact(impact, R2 * 1.15);
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

  agentSample(): [number, number] | null {
    return this.agents?.sampleCar() ?? null;
  }

  getStats() {
    let alive = 0;
    if (this.city) for (const i of this.city.infos.values()) if (i.alive) alive++;
    return {
      ready: this.ready,
      buildingsAlive: alive,
      debris: this.debris?.count ?? 0,
      rubble: this.debris?.rubble ?? 0,
      embedded: this.embedded.length,
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
    if (this.agents) {
      this.root.remove(this.agents.group);
      this.agents.dispose();
      this.agents = null;
    }
    this.debris?.dispose();
    this.fx.dispose();
    // Rapier world has no explicit free in compat; drop references
    this.world = null;
    this.ready = false;
  }
}
