/**
 * Debris system (rewritten for the reality pass).
 *
 * Buildings are VOXEL-CHUNKED at their real dimensions into roughly-cubic pieces
 * (not unit-cube fragments scaled by height — that produced tall standing
 * slivers). So a tall tower breaks into a stack of chunky blocks and fully
 * collapses; nothing keeps the building silhouette.
 *
 * Two InstancedMesh pools share one unit-box geometry:
 *  - ACTIVE: chunks with raw Rapier bodies (imperative, no JSX). The global cap
 *    applies here (perf). Building size is baked into the per-instance matrix.
 *  - RUBBLE: a persistent ring buffer of STATIC instances (no physics). When an
 *    active chunk sleeps (or is forced out over cap) it is "baked" here and its
 *    rigid body is freed — so the wreckage stays on the ground while the physics
 *    cost is bounded. Overflow buildings collapse straight to rubble piles.
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
  Euler,
  DynamicDrawUsage,
} from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

type RWorld = InstanceType<typeof RAPIER.World>;
type RBody = InstanceType<typeof RAPIER.RigidBody>;

interface Chunk {
  body: RBody;
  slot: number;
  size: [number, number, number];
  baseColor: Color;
  hotColor: Color;
  born: number;
  hotDur: number;
}

const _m4 = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _dir = new Vector3();
const _axis = new Vector3();
const _e = new Euler();
const CULL_Y = -28;

export interface DebrisOptions {
  activeCap: number;
  rubbleCap: number;
  castShadow: boolean;
}

export class DebrisSystem {
  readonly group = new Group();
  private world: RWorld;
  private activeCap: number;
  private rubbleCap: number;
  private material: MeshStandardMaterial;
  private activeMesh: InstancedMesh;
  private rubbleMesh: InstancedMesh;

  private active: Chunk[] = [];
  private activeFree: number[] = [];
  private activeMaxSlot = -1;

  private rubbleCursor = 0;
  private rubbleCount = 0;
  private simTime = 0;

  constructor(world: RWorld, opts: DebrisOptions) {
    this.world = world;
    this.activeCap = opts.activeCap;
    this.rubbleCap = opts.rubbleCap;
    this.group.name = 'debris';

    this.material = new MeshStandardMaterial({ roughness: 0.82, metalness: 0.02 });
    const geo = new BoxGeometry(1, 1, 1);

    this.activeMesh = new InstancedMesh(geo, this.material, this.activeCap);
    this.rubbleMesh = new InstancedMesh(geo, this.material, this.rubbleCap);
    for (const m of [this.activeMesh, this.rubbleMesh]) {
      m.castShadow = opts.castShadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.count = 0;
    }
    // prime instanceColor attributes
    this.activeMesh.setColorAt(0, _c.set(0xffffff));
    this.rubbleMesh.setColorAt(0, _c.set(0xffffff));

    for (let i = this.activeCap - 1; i >= 0; i--) this.activeFree.push(i);
    this.group.add(this.activeMesh, this.rubbleMesh);
  }

  get count(): number {
    return this.active.length;
  }
  get rubble(): number {
    return this.rubbleCount;
  }

  // ---------- active pool ----------
  private allocActive(): number {
    const slot = this.activeFree.pop();
    if (slot === undefined) return -1;
    if (slot > this.activeMaxSlot) {
      this.activeMaxSlot = slot;
      this.activeMesh.count = slot + 1;
    }
    return slot;
  }

  private freeActiveSlot(slot: number) {
    this.activeFree.push(slot);
    _m4.makeScale(0, 0, 0);
    this.activeMesh.setMatrixAt(slot, _m4);
  }

  // ---------- rubble ring buffer (persistent residue) ----------
  private bake(
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    sx: number, sy: number, sz: number,
    color: Color,
  ) {
    const slot = this.rubbleCursor;
    _p.set(px, py, pz);
    _q.set(qx, qy, qz, qw);
    _s.set(sx, sy, sz);
    _m4.compose(_p, _q, _s);
    this.rubbleMesh.setMatrixAt(slot, _m4);
    this.rubbleMesh.setColorAt(slot, color);
    this.rubbleCursor = (this.rubbleCursor + 1) % this.rubbleCap;
    this.rubbleCount = Math.min(this.rubbleCap, this.rubbleCount + 1);
    this.rubbleMesh.count = this.rubbleCount;
    this.rubbleMesh.instanceMatrix.needsUpdate = true;
    if (this.rubbleMesh.instanceColor) this.rubbleMesh.instanceColor.needsUpdate = true;
  }

  /** Bake an active chunk into static rubble and free its rigid body. */
  private bakeActive(index: number) {
    const e = this.active[index];
    const t = e.body.translation();
    const r = e.body.rotation();
    this.bake(t.x, t.y, t.z, r.x, r.y, r.z, r.w, e.size[0], e.size[1], e.size[2], e.baseColor);
    try {
      this.world.removeRigidBody(e.body);
    } catch {
      /* noop */
    }
    this.freeActiveSlot(e.slot);
    this.active.splice(index, 1);
  }

  private cullActive(index: number) {
    const e = this.active[index];
    try {
      this.world.removeRigidBody(e.body);
    } catch {
      /* noop */
    }
    this.freeActiveSlot(e.slot);
    this.active.splice(index, 1);
  }

  private ensureRoom() {
    // hard ceiling on ACTIVE physics bodies — freeze the oldest into rubble
    while (this.active.length >= this.activeCap) {
      this.bakeActive(0);
    }
  }

  private spawnChunk(
    pos: [number, number, number],
    size: [number, number, number],
    color: number,
    hotColor: number,
    hotDur: number,
    lin: [number, number, number],
    ang: [number, number, number],
  ): boolean {
    this.ensureRoom();
    const slot = this.allocActive();
    if (slot < 0) return false;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setCanSleep(true)
      .setLinearDamping(0.05)
      .setAngularDamping(0.3);
    const body = this.world.createRigidBody(bodyDesc);
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)
        .setRestitution(0.08)
        .setFriction(0.6) // lower so chunks slide/topple into flat piles, not standing stacks
        .setDensity(1.6),
      body,
    );
    body.setLinvel({ x: lin[0], y: lin[1], z: lin[2] }, true);
    body.setAngvel({ x: ang[0], y: ang[1], z: ang[2] }, true);

    const e: Chunk = {
      body,
      slot,
      size,
      baseColor: new Color(color),
      hotColor: new Color(hotColor),
      born: this.simTime,
      hotDur,
    };
    this.active.push(e);
    this.writeActive(e);
    this.activeMesh.setColorAt(slot, hotDur > 0 ? e.hotColor : e.baseColor);
    if (this.activeMesh.instanceColor) this.activeMesh.instanceColor.needsUpdate = true;
    return true;
  }

  private writeActive(e: Chunk) {
    const t = e.body.translation();
    const r = e.body.rotation();
    _p.set(t.x, t.y, t.z);
    _q.set(r.x, r.y, r.z, r.w);
    _s.set(e.size[0], e.size[1], e.size[2]);
    _m4.compose(_p, _q, _s);
    this.activeMesh.setMatrixAt(e.slot, _m4);
  }

  /**
   * Voxel-chunk a building into roughly-cubic physics pieces (item 1). desired
   * ~= target piece count; a cubic cell size is derived so tall buildings get
   * multiple vertical layers and pieces never become tall slivers.
   */
  fractureBuilding(
    center: [number, number, number],
    size: [number, number, number],
    color: number,
    impact: Vector3,
    impulse: number,
    hotColor: number,
    jitter: number,
    desired: number,
  ): number {
    const [w, h, d] = size;
    const vol = Math.max(1, w * h * d);
    let s = Math.cbrt(vol / Math.max(2, desired));
    s = Math.max(2.0, s); // don't shatter into confetti
    const nx = Math.max(1, Math.min(3, Math.round(w / s)));
    const ny = Math.max(1, Math.min(14, Math.round(h / s)));
    const nz = Math.max(1, Math.min(3, Math.round(d / s)));
    const cw = w / nx, ch = h / ny, cd = d / nz;
    const baseX = center[0] - w / 2;
    const baseZ = center[2] - d / 2;
    let spawned = 0;

    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          const px = baseX + (ix + 0.5) * cw;
          const py = center[1] + (iy + 0.5) * ch;
          const pz = baseZ + (iz + 0.5) * cd;
          const jx = 0.82 + Math.random() * 0.16;
          const cs: [number, number, number] = [cw * jx, ch * jx, cd * jx];

          _dir.set(px - impact.x, py - impact.y, pz - impact.z);
          const dist = Math.max(0.7, _dir.length());
          _dir.normalize();
          const speed = (impulse * 16) / Math.sqrt(dist);
          const asym = (Math.random() - 0.5) * jitter * speed;
          // structural splay: every chunk is shoved OUTWARD from the building's
          // own vertical axis (more up high) so the whole tower collapses even
          // when the meteor struck only the top — no standing base stack.
          _axis.set(px - center[0], 0, pz - center[2]);
          if (_axis.lengthSq() < 0.01) _axis.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          _axis.normalize();
          const splay = 2.5 + (py - center[1]) * 0.14;
          const lin: [number, number, number] = [
            _dir.x * speed + asym + _axis.x * splay,
            Math.abs(_dir.y) * speed * 0.4 + speed * 0.25 + 1,
            _dir.z * speed + (Math.random() - 0.5) * jitter * speed + _axis.z * splay,
          ];
          const ang: [number, number, number] = [
            (Math.random() - 0.5) * 9,
            (Math.random() - 0.5) * 9,
            (Math.random() - 0.5) * 9,
          ];
          // only near/lower chunks glow hot
          const hot = dist < 14 ? 1.2 : 0;
          if (this.spawnChunk([px, py, pz], cs, color, hotColor, hot, lin, ang)) spawned++;
        }
      }
    }
    return spawned;
  }

  /** A single ejected chunk (e.g. a toppled tree flung by the blast). */
  spawnFlyingChunk(
    pos: [number, number, number],
    s: number,
    color: number,
    impact: Vector3,
    hotColor = color,
  ): boolean {
    _dir.set(pos[0] - impact.x, pos[1] - impact.y, pos[2] - impact.z);
    const dist = Math.max(0.5, _dir.length());
    _dir.normalize();
    const speed = 34 / Math.sqrt(dist);
    const lin: [number, number, number] = [_dir.x * speed, Math.abs(speed) * 0.6 + 5, _dir.z * speed];
    const ang: [number, number, number] = [
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
    ];
    return this.spawnChunk(pos, [s, s * 1.4, s], color, hotColor, 0, lin, ang);
  }

  /**
   * Collapse a building straight into a static rubble pile (no physics) — used
   * for the far overflow of a big blast so residue appears everywhere without
   * spawning hundreds of bodies.
   */
  collapseToRubble(
    center: [number, number, number],
    size: [number, number, number],
    color: number,
  ) {
    const [w, h, d] = size;
    const n = 4 + (h > 26 ? 3 : 0);
    const c = new Color(color);
    for (let i = 0; i < n; i++) {
      const sx = w * (0.28 + Math.random() * 0.3);
      const sy = Math.min(h, Math.max(w, d)) * (0.22 + Math.random() * 0.28);
      const sz = d * (0.28 + Math.random() * 0.3);
      const px = center[0] + (Math.random() - 0.5) * w * 0.7;
      const pz = center[2] + (Math.random() - 0.5) * d * 0.7;
      const py = center[1] + sy / 2 + Math.random() * Math.min(h * 0.12, 2);
      _e.set(
        (Math.random() - 0.5) * 0.6,
        Math.random() * Math.PI,
        (Math.random() - 0.5) * 0.6,
      );
      _q.setFromEuler(_e);
      this.bake(px, py, pz, _q.x, _q.y, _q.z, _q.w, sx, sy, sz, c);
    }
  }

  /** Bake a tiny rubble mound where a felled tree stood (residue). */
  treeStump(x: number, z: number, scale: number, color: number) {
    const c = new Color(color);
    this.bake(x, 0.4 * scale, z, 0, 0, 0, 1, 1.6 * scale, 0.7 * scale, 1.6 * scale, c);
  }

  update(simTime: number) {
    this.simTime = simTime;
    let anyMatrix = false;
    let anyColor = false;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      const t = e.body.translation();
      if (t.y < CULL_Y) {
        this.cullActive(i);
        anyMatrix = true;
        continue;
      }
      if (e.body.isSleeping()) {
        this.bakeActive(i); // settle -> persistent rubble, free the body
        anyMatrix = true;
        continue;
      }
      this.writeActive(e);
      anyMatrix = true;
      if (e.hotDur > 0) {
        const k = Math.max(0, 1 - (simTime - e.born) / e.hotDur);
        if (k <= 0) e.hotDur = 0;
        _c.copy(e.baseColor).lerp(e.hotColor, k);
        this.activeMesh.setColorAt(e.slot, _c);
        anyColor = true;
      }
    }
    if (anyMatrix) this.activeMesh.instanceMatrix.needsUpdate = true;
    if (anyColor && this.activeMesh.instanceColor) {
      this.activeMesh.instanceColor.needsUpdate = true;
    }
  }

  reset() {
    for (let i = this.active.length - 1; i >= 0; i--) {
      try {
        this.world.removeRigidBody(this.active[i].body);
      } catch {
        /* noop */
      }
    }
    this.active.length = 0;
    this.activeFree.length = 0;
    for (let i = this.activeCap - 1; i >= 0; i--) this.activeFree.push(i);
    this.activeMaxSlot = -1;
    this.activeMesh.count = 0;
    this.rubbleCursor = 0;
    this.rubbleCount = 0;
    this.rubbleMesh.count = 0;
  }

  dispose() {
    this.reset();
    this.activeMesh.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}
