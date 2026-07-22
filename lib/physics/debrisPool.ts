/**
 * Debris system — the performance-critical core (PROJECT.md 임퍼러티브 경계).
 *
 * Rules honored:
 *  - fragments are NOT mounted as <RigidBody> JSX; bodies live in a raw Rapier
 *    world and are managed imperatively here.
 *  - rendering uses InstancedMesh POOLS (one per cached fracture fragment +
 *    one shared box for toppled buildings / chunks) -> ~25 draw calls for ALL
 *    debris regardless of count.
 *  - a hard GLOBAL cap bounds the dynamic-body count; the oldest sleeping
 *    fragments fade out then despawn so repeated drops never grow unbounded.
 *
 * Building size is baked into the instance matrix (non-uniform scale) and the
 * collider hull points are pre-scaled to match, so one unit-cube fragment set
 * serves every building.
 */
import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  BoxGeometry,
  DynamicDrawUsage,
} from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { FractureTemplate } from './fracture';

type RWorld = InstanceType<typeof RAPIER.World>;
type RBody = InstanceType<typeof RAPIER.RigidBody>;

interface Debris {
  body: RBody;
  mesh: number; // index into this.meshes
  slot: number;
  size: [number, number, number];
  baseColor: Color;
  hotColor: Color;
  born: number;
  hot: number; // seconds of hot glow remaining
  hotDur: number;
  fading: boolean;
  fadeStart: number;
  bigChunk: boolean;
}

const FADE_DUR = 0.55;
const MAX_AGE = 32; // sleeping debris older than this begins to fade
const _m4 = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _dir = new Vector3();

export interface DebrisOptions {
  cap: number;
  templates: FractureTemplate[];
  castShadow: boolean;
}

export class DebrisSystem {
  readonly group = new Group();
  private world: RWorld;
  private cap: number;
  private templates: FractureTemplate[];
  private meshes: InstancedMesh[] = [];
  private freeStacks: number[][] = [];
  private maxSlot: number[] = [];
  private caps: number[] = [];
  private material: MeshStandardMaterial;
  private boxMeshIndex = 0;
  private protoStart = 1; // meshes[1..] are fracture protos, flattened
  private protoOffsets: number[] = []; // template -> starting mesh index
  private active: Debris[] = [];
  private simTime = 0;

  constructor(world: RWorld, opts: DebrisOptions) {
    this.world = world;
    this.cap = opts.cap;
    this.templates = opts.templates;
    this.group.name = 'debris';

    this.material = new MeshStandardMaterial({
      roughness: 0.72,
      metalness: 0.05,
      vertexColors: false,
    });

    const perProto = Math.max(
      8,
      Math.ceil(this.cap / Math.max(1, this.templates[0]?.protos.length ?? 12)) + 8,
    );

    // meshes[0] = shared unit box (toppled buildings + chunks), capacity = cap
    const boxGeo = new BoxGeometry(1, 1, 1);
    const box = new InstancedMesh(boxGeo, this.material, this.cap);
    box.castShadow = opts.castShadow;
    box.receiveShadow = true;
    box.frustumCulled = false;
    box.instanceMatrix.setUsage(DynamicDrawUsage);
    box.count = 0;
    this.registerMesh(box, this.cap);

    // fracture proto instanced meshes
    for (let t = 0; t < this.templates.length; t++) {
      this.protoOffsets[t] = this.meshes.length;
      for (const proto of this.templates[t].protos) {
        const im = new InstancedMesh(proto.geometry, this.material, perProto);
        im.castShadow = opts.castShadow;
        im.receiveShadow = true;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(DynamicDrawUsage);
        im.count = 0;
        this.registerMesh(im, perProto);
      }
    }
  }

  private registerMesh(im: InstancedMesh, capacity: number) {
    const idx = this.meshes.length;
    this.meshes.push(im);
    const stack: number[] = [];
    for (let i = capacity - 1; i >= 0; i--) stack.push(i);
    this.freeStacks.push(stack);
    this.maxSlot.push(-1);
    this.caps.push(capacity);
    // start hidden
    _m4.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) im.setMatrixAt(i, _m4);
    im.instanceMatrix.needsUpdate = true;
    this.group.add(im);
    return idx;
  }

  get count(): number {
    return this.active.length;
  }

  private alloc(meshIndex: number): number {
    const stack = this.freeStacks[meshIndex];
    if (stack.length === 0) return -1;
    const slot = stack.pop()!;
    if (slot > this.maxSlot[meshIndex]) {
      this.maxSlot[meshIndex] = slot;
      this.meshes[meshIndex].count = slot + 1;
    }
    return slot;
  }

  private release(meshIndex: number, slot: number) {
    this.freeStacks[meshIndex].push(slot);
    _m4.makeScale(0, 0, 0);
    this.meshes[meshIndex].setMatrixAt(slot, _m4);
    this.meshes[meshIndex].instanceMatrix.needsUpdate = true;
  }

  private removeEntry(index: number) {
    const e = this.active[index];
    try {
      this.world.removeRigidBody(e.body);
    } catch {
      /* body may already be gone */
    }
    this.release(e.mesh, e.slot);
    this.active.splice(index, 1);
  }

  private ensureRoom() {
    // hard ceiling: never exceed cap live bodies
    while (this.active.length >= this.cap) {
      this.removeEntry(0); // oldest
    }
  }

  private spawnBody(
    meshIndex: number,
    colliderDesc: InstanceType<typeof RAPIER.ColliderDesc>,
    pos: [number, number, number],
    size: [number, number, number],
    baseColor: number,
    hotColor: number,
    hotDur: number,
    linvel: [number, number, number],
    angvel: [number, number, number],
    bigChunk: boolean,
  ): boolean {
    this.ensureRoom();
    const slot = this.alloc(meshIndex);
    if (slot < 0) return false;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setCanSleep(true)
      .setLinearDamping(0.06)
      .setAngularDamping(0.25);
    const body = this.world.createRigidBody(bodyDesc);
    colliderDesc.setRestitution(0.12).setFriction(0.85).setDensity(1.4);
    this.world.createCollider(colliderDesc, body);
    body.setLinvel({ x: linvel[0], y: linvel[1], z: linvel[2] }, true);
    body.setAngvel({ x: angvel[0], y: angvel[1], z: angvel[2] }, true);

    const e: Debris = {
      body,
      mesh: meshIndex,
      slot,
      size,
      baseColor: new Color(baseColor),
      hotColor: new Color(hotColor),
      born: this.simTime,
      hot: hotDur,
      hotDur,
      fading: false,
      fadeStart: 0,
      bigChunk,
    };
    this.active.push(e);
    // initial transform + color
    this.writeInstance(e, 1);
    const im = this.meshes[meshIndex];
    _c.copy(hotDur > 0 ? e.hotColor : e.baseColor);
    im.setColorAt(slot, _c);
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    return true;
  }

  private writeInstance(e: Debris, fade: number) {
    const t = e.body.translation();
    const r = e.body.rotation();
    _p.set(t.x, t.y, t.z);
    _q.set(r.x, r.y, r.z, r.w);
    _s.set(e.size[0] * fade, e.size[1] * fade, e.size[2] * fade);
    _m4.compose(_p, _q, _s);
    this.meshes[e.mesh].setMatrixAt(e.slot, _m4);
  }

  /** Core zone: fracture a building into fragment bodies with radial impulse. */
  fractureBuilding(
    center: [number, number, number], // footprint center, base y
    size: [number, number, number], // w,h,d
    color: number,
    impact: Vector3,
    impulse: number,
    hotColor: number,
    jitter: number, // 0..1 asymmetry (jagged)
  ): number {
    const templateIdx = Math.floor(Math.random() * this.templates.length);
    const template = this.templates[templateIdx];
    const meshBase = this.protoOffsets[templateIdx];
    const [w, h, d] = size;
    const bodyPos: [number, number, number] = [center[0], center[1] + h / 2, center[2]];
    let spawned = 0;

    for (let i = 0; i < template.protos.length; i++) {
      const proto = template.protos[i];
      // scale unit hull to building size
      const scaled = new Float32Array(proto.hull.length);
      for (let k = 0; k < proto.hull.length; k += 3) {
        scaled[k] = proto.hull[k] * w;
        scaled[k + 1] = proto.hull[k + 1] * h;
        scaled[k + 2] = proto.hull[k + 2] * d;
      }
      const colDesc = RAPIER.ColliderDesc.convexHull(scaled);
      if (!colDesc) continue;

      // fragment world center for impulse direction
      _dir
        .set(
          bodyPos[0] + proto.centroid[0] * w,
          bodyPos[1] + proto.centroid[1] * h,
          bodyPos[2] + proto.centroid[2] * d,
        )
        .sub(impact);
      const dist = Math.max(0.6, _dir.length());
      _dir.normalize();
      const speed = (impulse * 18) / Math.sqrt(dist);
      const jx = (Math.random() - 0.5) * jitter * speed;
      const jz = (Math.random() - 0.5) * jitter * speed;
      const lin: [number, number, number] = [
        _dir.x * speed + jx,
        _dir.y * speed + Math.abs(speed) * 0.35 + 2,
        _dir.z * speed + jz,
      ];
      const ang: [number, number, number] = [
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
      ];
      if (
        this.spawnBody(
          meshBase + i,
          colDesc,
          bodyPos,
          size,
          color,
          hotColor,
          1.4,
          lin,
          ang,
          true,
        )
      ) {
        spawned++;
      }
    }
    return spawned;
  }

  /** Blast zone: topple an intact building as a single dynamic box. */
  toppleBuilding(
    center: [number, number, number],
    size: [number, number, number],
    color: number,
    impact: Vector3,
  ): boolean {
    const [w, h, d] = size;
    const bodyPos: [number, number, number] = [center[0], center[1] + h / 2, center[2]];
    _dir.set(bodyPos[0] - impact.x, 0, bodyPos[2] - impact.z);
    const dist = Math.max(1, _dir.length());
    _dir.normalize();
    const push = 60 / Math.sqrt(dist);
    const lin: [number, number, number] = [_dir.x * push, 4, _dir.z * push];
    // torque so it tips away from impact
    const ang: [number, number, number] = [_dir.z * 1.6, 0, -_dir.x * 1.6];
    const colDesc = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2);
    return this.spawnBody(
      this.boxMeshIndex,
      colDesc,
      bodyPos,
      size,
      color,
      color,
      0,
      lin,
      ang,
      true,
    );
  }

  /** Small ejected chunk (used sparingly in blast zone). */
  spawnChunk(
    pos: [number, number, number],
    s: number,
    color: number,
    impact: Vector3,
    hotColor: number,
  ): boolean {
    _dir.set(pos[0] - impact.x, pos[1] - impact.y, pos[2] - impact.z);
    const dist = Math.max(0.5, _dir.length());
    _dir.normalize();
    const speed = 40 / Math.sqrt(dist);
    const lin: [number, number, number] = [
      _dir.x * speed,
      Math.abs(speed) * 0.6 + 4,
      _dir.z * speed,
    ];
    const ang: [number, number, number] = [
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
    ];
    const colDesc = RAPIER.ColliderDesc.cuboid(s / 2, s / 2, s / 2);
    return this.spawnBody(
      this.boxMeshIndex,
      colDesc,
      pos,
      [s, s, s],
      color,
      hotColor,
      0.9,
      lin,
      ang,
      false,
    );
  }

  /** Per fixed-step: advance ages/fades, then sync instance transforms. */
  update(simTime: number) {
    this.simTime = simTime;
    const dirtyM = new Set<number>();
    const dirtyC = new Set<number>();

    // age-out oldest sleeping debris when crowded or too old
    const crowded = this.active.length > this.cap * 0.8;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e.fading) continue;
      const age = simTime - e.born;
      const sleeping = e.body.isSleeping();
      if ((crowded && sleeping && i < this.active.length * 0.25) || age > MAX_AGE) {
        e.fading = true;
        e.fadeStart = simTime;
      }
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      let fade = 1;
      if (e.fading) {
        const f = (simTime - e.fadeStart) / FADE_DUR;
        if (f >= 1) {
          this.removeEntry(i);
          dirtyM.add(e.mesh);
          continue;
        }
        fade = 1 - f;
      }
      this.writeInstance(e, fade);
      dirtyM.add(e.mesh);

      // hot -> cool color ramp for freshly fractured chunks (DESIGN §4-3 발광 냉각)
      if (e.hot > 0) {
        const remain = Math.max(0, e.hotDur - (simTime - e.born));
        e.hot = e.hotDur > 0 ? remain / e.hotDur : 0;
        _c.copy(e.baseColor).lerp(e.hotColor, e.hot);
        this.meshes[e.mesh].setColorAt(e.slot, _c);
        dirtyC.add(e.mesh);
      }
    }

    for (const m of dirtyM) this.meshes[m].instanceMatrix.needsUpdate = true;
    for (const m of dirtyC) {
      const ic = this.meshes[m].instanceColor;
      if (ic) ic.needsUpdate = true;
    }
  }

  reset() {
    for (let i = this.active.length - 1; i >= 0; i--) this.removeEntry(i);
    this.active.length = 0;
  }

  dispose() {
    this.reset();
    for (const im of this.meshes) {
      im.geometry.dispose();
    }
    this.material.dispose();
    this.group.clear();
  }
}
