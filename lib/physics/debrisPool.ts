/**
 * Debris system (reality pass + irregular-shape pass).
 *
 * Buildings are VOXEL-CHUNKED at their real dimensions into roughly-cubic pieces
 * (not unit-cube fragments scaled by height — that produced tall standing
 * slivers). So a tall tower breaks into a stack of chunky blocks and fully
 * collapses; nothing keeps the building silhouette.
 *
 * IRREGULAR SHAPES (feedback 1): pieces are no longer perfect cubes. Instead of
 * one shared box geometry we build a handful of ANGULAR shard geometries (jittered
 * boxes, a flat slab, an icosa/dodeca rock). Each variant gets its own
 * InstancedMesh (still just a few draw calls, per-instance matrices carry the
 * variety). Every chunk picks a random variant, a random rotation, a NON-uniform
 * scale, and a slightly jittered color — so no two look alike and the "repeated
 * cube" tell is gone. The voxel grid itself splits into UNEVEN cells so chunk
 * sizes span small shards to big lumps.
 *
 * Two families of pools share one material:
 *  - ACTIVE: chunks with raw Rapier bodies (imperative, no JSX). The global cap
 *    applies here (perf). Collider stays a cheap cuboid; the visual shard is the
 *    fancy part. Building size is baked into the per-instance matrix.
 *  - RUBBLE: persistent ring buffers of STATIC instances (no physics). When an
 *    active chunk sleeps (or is forced out over cap) it is "baked" here and its
 *    rigid body freed — wreckage stays on the ground at bounded physics cost.
 *    Overflow buildings collapse straight to messy rubble piles.
 */
import {
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  Color,
  DodecahedronGeometry,
  DynamicDrawUsage,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { COLLAPSE } from '../constants';

type RWorld = InstanceType<typeof RAPIER.World>;
type RBody = InstanceType<typeof RAPIER.RigidBody>;

interface Chunk {
  body: RBody;
  variant: number;
  slot: number;
  size: [number, number, number];
  baseColor: Color;
  hotColor: Color;
  born: number;
  hotDur: number;
  // ---- progressive collapse ----
  // A "held" chunk is a lower building layer that has not yet lost support: it is
  // a dynamic body pinned in place (gravityScale 0 + locked) so falling upper
  // chunks rest on it. At `releaseAt` (sim time) it unlocks + drops onto the pile.
  held: boolean;
  releaseAt: number;
  rlin: [number, number, number]; // velocity to apply on release
  rang: [number, number, number];
}

const _m4 = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _dir = new Vector3();
const _axis = new Vector3();
const _e = new Euler();
const CULL_Y = -28;

// ---------- irregular shard geometries (built once) ----------
/**
 * Jitter a base solid into an angular shard, then normalize its bounds to a unit
 * cube centered on the origin so a per-instance [w,h,d] scale maps cleanly to the
 * chunk's cell. Corners are grouped by position so the solid stays closed, then
 * flattened to non-indexed for faceted, AO-catching facets.
 */
function angularShard(base: BufferGeometry, amt: number): BufferGeometry {
  const pos = base.getAttribute('position') as BufferAttribute;
  const groups = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(2)}_${pos.getY(i).toFixed(2)}_${pos.getZ(i).toFixed(2)}`;
    let arr = groups.get(k);
    if (!arr) {
      arr = [];
      groups.set(k, arr);
    }
    arr.push(i);
  }
  for (const arr of groups.values()) {
    const dx = (Math.random() - 0.5) * amt;
    const dy = (Math.random() - 0.5) * amt;
    const dz = (Math.random() - 0.5) * amt;
    for (const i of arr) pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
  }
  base.computeBoundingBox();
  const bb = base.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  const maxE = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, (pos.getX(i) - cx) / maxE, (pos.getY(i) - cy) / maxE, (pos.getZ(i) - cz) / maxE);
  }
  pos.needsUpdate = true;
  // faceted normals; polyhedra come non-indexed already, boxes need converting
  const flat = base.index ? base.toNonIndexed() : base;
  flat.computeVertexNormals();
  if (flat !== base) base.dispose();
  return flat;
}

/** A few genuinely different angular silhouettes — chunks mix these at random. */
function makeShardGeometries(): BufferGeometry[] {
  return [
    angularShard(new BoxGeometry(1, 1, 1), 0.26), // chunky angular block
    angularShard(new BoxGeometry(1, 1, 1), 0.52), // more broken block
    angularShard(new BoxGeometry(1.25, 0.6, 1.0), 0.34), // flat slab shard
    angularShard(new IcosahedronGeometry(0.62, 0), 0.34), // angular rock
    angularShard(new DodecahedronGeometry(0.6, 0), 0.3), // chunky faceted rock
  ];
}

/** Subtle per-instance color variety (brightness + tiny channel drift, no rainbow). */
function jitterColorInPlace(c: Color, amt: number) {
  const f = 1 + (Math.random() - 0.5) * amt;
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  c.setRGB(
    clamp01(c.r * f * (1 + (Math.random() - 0.5) * amt * 0.5)),
    clamp01(c.g * f * (1 + (Math.random() - 0.5) * amt * 0.5)),
    clamp01(c.b * f * (1 + (Math.random() - 0.5) * amt * 0.5)),
  );
}

/** Split a length into `n` UNEVEN segments (summing to total) for varied chunk sizes. */
function splitAxis(total: number, n: number): number[] {
  if (n <= 1) return [total];
  const w: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const g = 0.55 + Math.random() * 0.9; // some cells much smaller/larger than average
    w.push(g);
    sum += g;
  }
  return w.map((g) => (total * g) / sum);
}

export interface DebrisOptions {
  activeCap: number;
  rubbleCap: number;
  castShadow: boolean;
}

export class DebrisSystem {
  readonly group = new Group();
  private world: RWorld;
  private activeCap: number;
  private rubbleSlots: number; // per-variant rubble ring capacity
  private material: MeshStandardMaterial;
  private geometries: BufferGeometry[];
  private variantCount: number;

  private activeMeshes: InstancedMesh[] = [];
  private rubbleMeshes: InstancedMesh[] = [];

  private active: Chunk[] = [];
  private activeFree: number[][] = []; // free slots per variant
  private activeMaxSlot: number[] = [];

  private rubbleCursor: number[] = [];
  private rubbleCount: number[] = [];

  private _dirtyM: boolean[];
  private _dirtyC: boolean[];
  private simTime = 0;
  private heldCount = 0; // chunks currently pinned mid-collapse (progressive collapse)

  constructor(world: RWorld, opts: DebrisOptions) {
    this.world = world;
    this.activeCap = opts.activeCap;
    this.group.name = 'debris';

    this.material = new MeshStandardMaterial({
      roughness: 0.85,
      metalness: 0.02,
      flatShading: true, // reinforce the faceted, non-plastic shard look
    });
    this.geometries = makeShardGeometries();
    this.variantCount = this.geometries.length;
    // total rubble capacity across variants stays <= rubbleCap
    this.rubbleSlots = Math.max(1, Math.floor(opts.rubbleCap / this.variantCount));
    this._dirtyM = new Array(this.variantCount).fill(false);
    this._dirtyC = new Array(this.variantCount).fill(false);

    for (let v = 0; v < this.variantCount; v++) {
      const am = new InstancedMesh(this.geometries[v], this.material, this.activeCap);
      const rm = new InstancedMesh(this.geometries[v], this.material, this.rubbleSlots);
      for (const m of [am, rm]) {
        m.castShadow = opts.castShadow;
        m.receiveShadow = true;
        m.frustumCulled = false;
        m.instanceMatrix.setUsage(DynamicDrawUsage);
        m.count = 0;
      }
      am.setColorAt(0, _c.set(0xffffff)); // prime instanceColor
      rm.setColorAt(0, _c.set(0xffffff));
      this.activeMeshes.push(am);
      this.rubbleMeshes.push(rm);

      const free: number[] = [];
      for (let i = this.activeCap - 1; i >= 0; i--) free.push(i);
      this.activeFree.push(free);
      this.activeMaxSlot.push(-1);
      this.rubbleCursor.push(0);
      this.rubbleCount.push(0);

      this.group.add(am, rm);
    }
  }

  get count(): number {
    return this.active.length;
  }
  get rubble(): number {
    let n = 0;
    for (const c of this.rubbleCount) n += c;
    return n;
  }

  // ---------- active pool (per-variant slots) ----------
  private allocActive(v: number): number {
    const slot = this.activeFree[v].pop();
    if (slot === undefined) return -1;
    if (slot > this.activeMaxSlot[v]) {
      this.activeMaxSlot[v] = slot;
      this.activeMeshes[v].count = slot + 1;
    }
    return slot;
  }

  private freeActiveSlot(v: number, slot: number) {
    this.activeFree[v].push(slot);
    _m4.makeScale(0, 0, 0);
    this.activeMeshes[v].setMatrixAt(slot, _m4);
  }

  // ---------- rubble ring buffers (persistent residue) ----------
  private bake(
    v: number,
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    sx: number, sy: number, sz: number,
    color: Color,
  ) {
    const mesh = this.rubbleMeshes[v];
    const slot = this.rubbleCursor[v];
    _p.set(px, py, pz);
    _q.set(qx, qy, qz, qw);
    _s.set(sx, sy, sz);
    _m4.compose(_p, _q, _s);
    mesh.setMatrixAt(slot, _m4);
    mesh.setColorAt(slot, color);
    this.rubbleCursor[v] = (slot + 1) % this.rubbleSlots;
    this.rubbleCount[v] = Math.min(this.rubbleSlots, this.rubbleCount[v] + 1);
    mesh.count = this.rubbleCount[v];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Bake an active chunk into static rubble and free its rigid body. */
  private bakeActive(index: number) {
    const e = this.active[index];
    if (e.held) this.heldCount--;
    const t = e.body.translation();
    const r = e.body.rotation();
    this.bake(
      e.variant,
      t.x, t.y, t.z,
      r.x, r.y, r.z, r.w,
      e.size[0], e.size[1], e.size[2],
      e.baseColor,
    );
    try {
      this.world.removeRigidBody(e.body);
    } catch {
      /* noop */
    }
    this.freeActiveSlot(e.variant, e.slot);
    this.active.splice(index, 1);
  }

  private cullActive(index: number) {
    const e = this.active[index];
    if (e.held) this.heldCount--;
    try {
      this.world.removeRigidBody(e.body);
    } catch {
      /* noop */
    }
    this.freeActiveSlot(e.variant, e.slot);
    this.active.splice(index, 1);
  }

  private ensureRoom() {
    // hard ceiling on ACTIVE physics bodies — freeze the oldest into rubble.
    // Prefer an already-fallen (non-held) chunk so a still-standing lower layer
    // mid-collapse isn't frozen in mid-air; fall back to oldest if all are held.
    while (this.active.length >= this.activeCap) {
      let idx = this.active.findIndex((c) => !c.held);
      if (idx < 0) idx = 0;
      this._dirtyM[this.active[idx].variant] = true;
      this.bakeActive(idx);
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
    hold = false, // pin in place until releaseAt (progressive collapse)
    releaseAt = 0,
  ): boolean {
    this.ensureRoom();
    const variant = (Math.random() * this.variantCount) | 0;
    const slot = this.allocActive(variant);
    if (slot < 0) return false;
    // Every chunk is a DYNAMIC body (so mass is correct from the start). A "held"
    // lower layer is pinned with gravityScale 0 + locked translation/rotation so
    // it stands firm and upper chunks pile on it; it releases (unlock + gravity)
    // at releaseAt. Heavy, near-zero-restitution, damped -> thuds down, no bounce.
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setCanSleep(true)
      .setGravityScale(hold ? 0 : 1)
      .setLinearDamping(COLLAPSE.linDamp)
      .setAngularDamping(COLLAPSE.angDamp);
    const body = this.world.createRigidBody(bodyDesc);
    this.world.createCollider(
      // collider is a cheap cuboid around the (irregular) visual shard
      RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)
        .setRestitution(COLLAPSE.restitution)
        .setFriction(COLLAPSE.friction)
        .setDensity(COLLAPSE.density),
      body,
    );
    if (hold) {
      body.lockTranslations(true, false);
      body.lockRotations(true, false);
    } else {
      body.setLinvel({ x: lin[0], y: lin[1], z: lin[2] }, true);
      body.setAngvel({ x: ang[0], y: ang[1], z: ang[2] }, true);
    }

    const baseColor = new Color(color);
    jitterColorInPlace(baseColor, 0.14);
    const e: Chunk = {
      body,
      variant,
      slot,
      size,
      baseColor,
      hotColor: new Color(hotColor),
      born: this.simTime,
      hotDur,
      held: hold,
      releaseAt,
      rlin: lin,
      rang: ang,
    };
    this.active.push(e);
    if (hold) this.heldCount++;
    this.writeActive(e);
    // flush this instance's matrix now — a held chunk won't be re-written by
    // update() until it releases, so its standing pose must upload immediately.
    this.activeMeshes[variant].instanceMatrix.needsUpdate = true;
    this.activeMeshes[variant].setColorAt(slot, hotDur > 0 ? e.hotColor : e.baseColor);
    const ic = this.activeMeshes[variant].instanceColor;
    if (ic) ic.needsUpdate = true;
    return true;
  }

  /** Unlock a held lower layer so it loses support and pancakes onto the pile. */
  private release(e: Chunk) {
    e.body.setGravityScale(1, true);
    e.body.lockTranslations(false, true);
    e.body.lockRotations(false, true);
    e.body.setLinvel({ x: e.rlin[0], y: e.rlin[1], z: e.rlin[2] }, true);
    e.body.setAngvel({ x: e.rang[0], y: e.rang[1], z: e.rang[2] }, true);
    e.held = false;
    this.heldCount--;
  }

  private writeActive(e: Chunk) {
    const t = e.body.translation();
    const r = e.body.rotation();
    _p.set(t.x, t.y, t.z);
    _q.set(r.x, r.y, r.z, r.w);
    _s.set(e.size[0], e.size[1], e.size[2]);
    _m4.compose(_p, _q, _s);
    this.activeMeshes[e.variant].setMatrixAt(e.slot, _m4);
  }

  /**
   * Voxel-chunk a building into roughly-cubic pieces, then bring it down by
   * PROGRESSIVE COLLAPSE (top-to-bottom pancaking) instead of one outward blast:
   *   - the struck layer + everything above it lose support first (top-first
   *     micro-stagger) and drop;
   *   - each layer BELOW the impact releases a beat later (COLLAPSE.layerDelay)
   *     so the mass telescopes straight down onto its own footprint.
   * Held-but-not-yet-released layers are pinned (gravityScale 0 + locked) so the
   * falling upper mass rests on them until their turn. Lateral splay is tiny
   * (only the struck layer gets a real sideways punch) — gravity does the work,
   * so debris piles at the building's feet rather than splaying across town.
   * A cubic cell size keeps pieces from becoming tall slivers; cells split
   * unevenly + each chunk gets an irregular non-uniform scale.
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
    const xs = splitAxis(w, nx);
    const ys = splitAxis(h, ny);
    const zs = splitAxis(d, nz);
    const baseX = center[0] - w / 2;
    const baseY = center[1]; // info.center[1] is the building's BASE (ground), spans up to baseY+h
    const baseZ = center[2] - d / 2;
    const cxr = center[0];
    const czr = center[2];

    // which layer did the meteor strike? (impact.y ~ contact height)
    const relY = Math.max(0, Math.min(h, impact.y - baseY));
    const impactLayer = Math.max(0, Math.min(ny - 1, Math.floor((relY / h) * ny)));
    const topLayer = ny - 1;
    const lat = COLLAPSE.scatter * impulse;
    let spawned = 0;

    let oy = baseY;
    for (let iy = 0; iy < ny; iy++) {
      const ch = ys[iy];
      const py = oy + ch / 2;
      oy += ch;

      // release schedule: struck layer + everything above lose support first
      // (top-first micro-stagger); layers below release in sequence downward.
      const delay =
        iy >= impactLayer
          ? (topLayer - iy) * COLLAPSE.upStagger
          : COLLAPSE.releaseBase + (impactLayer - iy) * COLLAPSE.layerDelay;
      const hold = delay > 1e-4;
      const releaseAt = this.simTime + delay;
      const struck = iy === impactLayer;

      let ox = baseX;
      for (let ix = 0; ix < nx; ix++) {
        const cw = xs[ix];
        const px = ox + cw / 2;
        ox += cw;
        let oz = baseZ;
        for (let iz = 0; iz < nz; iz++) {
          const cd = zs[iz];
          const pz = oz + cd / 2;
          oz += cd;

          // per-chunk non-uniform shrink so pieces don't perfectly re-tile the box
          const cs: [number, number, number] = [
            cw * (0.72 + Math.random() * 0.26),
            ch * (0.72 + Math.random() * 0.26),
            cd * (0.72 + Math.random() * 0.26),
          ];

          // Mostly DOWN. Outward-from-axis is tiny (no splay across town). Only
          // the struck layer gets a real lateral punch away from impact + up ejecta.
          _axis.set(px - cxr, 0, pz - czr);
          if (_axis.lengthSq() < 0.01) _axis.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          _axis.normalize();
          let vx = _axis.x * lat + (Math.random() - 0.5) * jitter * 2;
          let vz = _axis.z * lat + (Math.random() - 0.5) * jitter * 2;
          let vy = -COLLAPSE.down * (0.4 + Math.random());
          if (struck) {
            _dir.set(px - impact.x, 0, pz - impact.z);
            if (_dir.lengthSq() < 0.01) _dir.set(_axis.x, 0, _axis.z);
            _dir.normalize();
            const punch = COLLAPSE.scatterImpact * impulse;
            vx += _dir.x * punch;
            vz += _dir.z * punch;
            vy += COLLAPSE.ejecta * Math.random();
          }
          const lin: [number, number, number] = [vx, vy, vz];
          const ang: [number, number, number] = [
            (Math.random() - 0.5) * COLLAPSE.spin,
            (Math.random() - 0.5) * COLLAPSE.spin,
            (Math.random() - 0.5) * COLLAPSE.spin,
          ];
          // near chunks glow hot briefly
          const dist = Math.hypot(px - impact.x, py - impact.y, pz - impact.z);
          const hot = dist < 14 ? 1.2 : 0;
          if (this.spawnChunk([px, py, pz], cs, color, hotColor, hot, lin, ang, hold, releaseAt))
            spawned++;
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
    const speed = 20 / Math.sqrt(dist); // calmer than before — heavy debris, less launch
    const lin: [number, number, number] = [_dir.x * speed, Math.abs(speed) * 0.5 + 4, _dir.z * speed];
    const ang: [number, number, number] = [
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
    ];
    // irregular, slightly tall clod
    const size: [number, number, number] = [
      s * (0.8 + Math.random() * 0.4),
      s * (1.1 + Math.random() * 0.6),
      s * (0.8 + Math.random() * 0.4),
    ];
    return this.spawnChunk(pos, size, color, hotColor, 0, lin, ang);
  }

  /**
   * Collapse a building straight into a static rubble PILE (no physics) — used
   * for the far overflow of a big blast so residue appears everywhere without
   * spawning hundreds of bodies. Pieces are irregular shards of widely varying
   * size, randomly rotated, tinted, and stacked denser at the bottom (a mound,
   * not a repeated-cube grid).
   */
  collapseToRubble(
    center: [number, number, number],
    size: [number, number, number],
    color: number,
  ) {
    const [w, h, d] = size;
    const n = 6 + (h > 26 ? 4 : 2) + ((Math.random() * 3) | 0);
    const c = new Color(color);
    const pileH = Math.min(h * 0.4, 6);
    for (let i = 0; i < n; i++) {
      const variant = (Math.random() * this.variantCount) | 0;
      // wide size range: small shards through big lumps
      const sx = w * (0.2 + Math.random() * 0.5);
      const sy = Math.min(h, Math.max(w, d)) * (0.16 + Math.random() * 0.42);
      const sz = d * (0.2 + Math.random() * 0.5);
      const px = center[0] + (Math.random() - 0.5) * w * 0.8;
      const pz = center[2] + (Math.random() - 0.5) * d * 0.8;
      const lo = Math.random();
      const py = sy / 2 + lo * lo * pileH; // bias low -> mound
      _e.set(
        (Math.random() - 0.5) * 1.1,
        Math.random() * Math.PI * 2,
        (Math.random() - 0.5) * 1.1,
      );
      _q2.setFromEuler(_e);
      _c.copy(c);
      jitterColorInPlace(_c, 0.16);
      this.bake(variant, px, py, pz, _q2.x, _q2.y, _q2.z, _q2.w, sx, sy, sz, _c);
    }
  }

  /** Bake a small irregular rubble mound where a felled tree stood (residue). */
  treeStump(x: number, z: number, scale: number, color: number) {
    const c = new Color(color);
    const n = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const variant = (Math.random() * this.variantCount) | 0;
      const px = x + (Math.random() - 0.5) * 1.7 * scale;
      const pz = z + (Math.random() - 0.5) * 1.7 * scale;
      const sx = (0.9 + Math.random() * 0.9) * scale;
      const sy = (0.5 + Math.random() * 0.6) * scale;
      const sz = (0.9 + Math.random() * 0.9) * scale;
      const py = sy / 2 + Math.random() * 0.3 * scale;
      _e.set(
        (Math.random() - 0.5) * 0.9,
        Math.random() * Math.PI * 2,
        (Math.random() - 0.5) * 0.9,
      );
      _q2.setFromEuler(_e);
      _c.copy(c);
      jitterColorInPlace(_c, 0.16);
      this.bake(variant, px, py, pz, _q2.x, _q2.y, _q2.z, _q2.w, sx, sy, sz, _c);
    }
  }

  update(simTime: number) {
    this.simTime = simTime;
    this._dirtyM.fill(false);
    this._dirtyC.fill(false);
    // While any layer is still pinned mid-collapse, don't bake sleeping chunks:
    // an upper chunk resting on a held layer would otherwise sleep and freeze in
    // mid-air before the layers beneath it drop. Baking resumes once the whole
    // collapse has released. ensureRoom() still enforces the hard cap regardless.
    const pauseBake = this.heldCount > 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      const v = e.variant;
      // held (pinned) layer: release when its turn comes, otherwise stand firm.
      if (e.held) {
        if (simTime >= e.releaseAt) {
          this.release(e);
        } else {
          continue; // still standing; matrix already uploaded at spawn
        }
      }
      const t = e.body.translation();
      if (t.y < CULL_Y) {
        this.cullActive(i);
        this._dirtyM[v] = true;
        continue;
      }
      if (!pauseBake && e.body.isSleeping()) {
        this.bakeActive(i); // settle -> persistent rubble, free the body
        this._dirtyM[v] = true;
        continue;
      }
      this.writeActive(e);
      this._dirtyM[v] = true;
      if (e.hotDur > 0) {
        const k = Math.max(0, 1 - (simTime - e.born) / e.hotDur);
        if (k <= 0) e.hotDur = 0;
        _c.copy(e.baseColor).lerp(e.hotColor, k);
        this.activeMeshes[v].setColorAt(e.slot, _c);
        this._dirtyC[v] = true;
      }
    }
    for (let v = 0; v < this.variantCount; v++) {
      if (this._dirtyM[v]) this.activeMeshes[v].instanceMatrix.needsUpdate = true;
      if (this._dirtyC[v]) {
        const ic = this.activeMeshes[v].instanceColor;
        if (ic) ic.needsUpdate = true;
      }
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
    this.heldCount = 0;
    for (let v = 0; v < this.variantCount; v++) {
      this.activeFree[v].length = 0;
      for (let i = this.activeCap - 1; i >= 0; i--) this.activeFree[v].push(i);
      this.activeMaxSlot[v] = -1;
      this.activeMeshes[v].count = 0;
      this.rubbleCursor[v] = 0;
      this.rubbleCount[v] = 0;
      this.rubbleMeshes[v].count = 0;
    }
  }

  dispose() {
    this.reset();
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
    this.group.clear();
  }
}
