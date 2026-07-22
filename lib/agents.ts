/**
 * Roaming cars + pedestrians (live-feedback item 5). Cosmetic, imperative:
 * two InstancedMeshes whose per-instance matrices are updated each frame from a
 * plain agent-state array — no React, no physics bodies (PROJECT.md §임퍼러티브
 * 경계). Agents follow the road grid; on impact, nearby ones are flung
 * ballistically and respawn when they land. Counts scale by quality tier.
 */
import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { ROAD } from './constants';
import type { CityModel } from './city/cityTypes';

interface Agent {
  axis: 0 | 1; // 0 = travels along x (road at fixed z), 1 = travels along z
  line: number; // fixed coordinate of the road it drives on
  lane: number; // perpendicular offset (which lane / sidewalk side)
  pos: number; // position along travel axis
  dir: number; // +1 / -1
  speed: number;
  yBase: number;
  // ballistic scatter state
  flying: boolean;
  vx: number;
  vy: number;
  vz: number;
  x: number;
  y: number;
  z: number;
  spin: number;
  rot: number;
}

const CAR_COLORS = [0xe4ded2, 0x7e93a3, 0x9a5a4a, 0x3c3e42, 0x8fa08a, 0xc8a34e, 0xb7b2a8];
const PED_COLORS = [0xc7b9a4, 0x8c7f6e, 0xa7a399, 0x6e6455, 0x9a8b76];

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();

export class AgentSystem {
  readonly group = new Group();
  private carMesh: InstancedMesh;
  private pedMesh: InstancedMesh;
  private cars: Agent[] = [];
  private peds: Agent[] = [];
  private half: number;
  private gridN: number;
  private pitch: number;
  private carMat: MeshStandardMaterial;
  private pedMat: MeshStandardMaterial;
  private carGeo: BoxGeometry;
  private pedGeo: BoxGeometry;

  constructor(
    model: CityModel,
    opts: { cars: number; peds: number; shadows: boolean },
  ) {
    this.group.name = 'agents';
    this.half = model.span / 2;
    this.gridN = model.gridN;
    this.pitch = model.pitch;

    this.carGeo = new BoxGeometry(3.4, 1.15, 1.6);
    this.pedGeo = new BoxGeometry(0.55, 1.5, 0.55);
    this.carMat = new MeshStandardMaterial({ roughness: 0.5, metalness: 0.15 });
    this.pedMat = new MeshStandardMaterial({ roughness: 0.85, metalness: 0 });

    this.carMesh = new InstancedMesh(this.carGeo, this.carMat, Math.max(1, opts.cars));
    this.pedMesh = new InstancedMesh(this.pedGeo, this.pedMat, Math.max(1, opts.peds));
    for (const m of [this.carMesh, this.pedMesh]) {
      m.castShadow = opts.shadows;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(DynamicDrawUsage);
    }
    this.group.add(this.carMesh, this.pedMesh);

    for (let i = 0; i < opts.cars; i++) {
      const a = this.spawnAgent(0.7, 8, 16, 1.7);
      this.cars.push(a);
      this.carMesh.setColorAt(i, _c.set(CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0]));
    }
    for (let i = 0; i < opts.peds; i++) {
      const a = this.spawnAgent(0.85, 1.6, 3.2, ROAD / 2 + 1.1);
      this.peds.push(a);
      this.pedMesh.setColorAt(i, _c.set(PED_COLORS[(Math.random() * PED_COLORS.length) | 0]));
    }
    if (this.carMesh.instanceColor) this.carMesh.instanceColor.needsUpdate = true;
    if (this.pedMesh.instanceColor) this.pedMesh.instanceColor.needsUpdate = true;
    this.writeAll();
  }

  private roadCoord(g: number): number {
    return -this.half + ROAD / 2 + g * this.pitch;
  }

  private spawnAgent(yBase: number, sMin: number, sMax: number, laneMag: number): Agent {
    const axis: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    const g = (Math.random() * (this.gridN + 1)) | 0;
    const dir = Math.random() < 0.5 ? 1 : -1;
    return {
      axis,
      line: this.roadCoord(g),
      lane: dir * laneMag * (Math.random() < 0.5 ? 1 : 0.6),
      pos: (Math.random() * 2 - 1) * this.half,
      dir,
      speed: sMin + Math.random() * (sMax - sMin),
      yBase,
      flying: false,
      vx: 0,
      vy: 0,
      vz: 0,
      x: 0,
      y: yBase,
      z: 0,
      spin: 0,
      rot: 0,
    };
  }

  private worldXZ(a: Agent): [number, number] {
    if (a.axis === 0) return [a.pos, a.line + a.lane];
    return [a.line + a.lane, a.pos];
  }

  private headingRot(a: Agent): number {
    if (a.axis === 0) return a.dir > 0 ? 0 : Math.PI;
    return a.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
  }

  private respawn(a: Agent) {
    const fresh = this.spawnAgent(a.yBase, a.speed, a.speed + 0.01, Math.abs(a.lane) || 1.5);
    Object.assign(a, fresh);
  }

  update(dt: number) {
    if (dt <= 0) return;
    const clamped = Math.min(dt, 0.05);
    for (const list of [this.cars, this.peds]) {
      for (const a of list) {
        if (a.flying) {
          a.vy -= 22 * clamped;
          a.x += a.vx * clamped;
          a.y += a.vy * clamped;
          a.z += a.vz * clamped;
          a.rot += a.spin * clamped;
          if (a.y <= a.yBase) this.respawn(a);
        } else {
          a.pos += a.dir * a.speed * clamped;
          if (a.pos > this.half) a.pos = -this.half;
          else if (a.pos < -this.half) a.pos = this.half;
        }
      }
    }
    this.writeAll();
  }

  private writeList(mesh: InstancedMesh, list: Agent[]) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.flying) {
        _p.set(a.x, a.y, a.z);
        _q.setFromAxisAngle(_UP, a.rot);
        _q.multiply(_TILT);
      } else {
        const [x, z] = this.worldXZ(a);
        _p.set(x, a.yBase, z);
        _q.setFromAxisAngle(_UP, this.headingRot(a));
      }
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  private writeAll() {
    this.writeList(this.carMesh, this.cars);
    this.writeList(this.pedMesh, this.peds);
  }

  /** Fling agents within radius of an impact (item 5 reaction). */
  reactToImpact(point: Vector3, radius: number) {
    const r2 = radius * radius;
    for (const list of [this.cars, this.peds]) {
      for (const a of list) {
        if (a.flying) continue;
        const [x, z] = this.worldXZ(a);
        const dx = x - point.x;
        const dz = z - point.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const d = Math.max(1, Math.sqrt(d2));
        const boost = 1 - d / radius; // closer = stronger
        a.flying = true;
        a.x = x;
        a.y = a.yBase;
        a.z = z;
        a.vx = (dx / d) * (14 + boost * 26) + (Math.random() - 0.5) * 6;
        a.vz = (dz / d) * (14 + boost * 26) + (Math.random() - 0.5) * 6;
        a.vy = 10 + boost * 22 + Math.random() * 6;
        a.spin = (Math.random() - 0.5) * 14;
        a.rot = 0;
      }
    }
  }

  /** Debug/verification: world XZ of the first car (to confirm movement). */
  sampleCar(): [number, number] | null {
    const a = this.cars[0];
    if (!a) return null;
    return a.flying ? [a.x, a.z] : this.worldXZ(a);
  }

  dispose() {
    this.carGeo.dispose();
    this.pedGeo.dispose();
    this.carMat.dispose();
    this.pedMat.dispose();
    this.group.clear();
  }
}

const _UP = new Vector3(0, 1, 0);
// a small fixed tumble tilt so flung agents look tossed, not sliding
const _TILT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0.4).normalize(), 0.9);
