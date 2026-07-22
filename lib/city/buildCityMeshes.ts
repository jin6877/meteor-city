/**
 * CityModel -> three geometry + Rapier collider descriptors.
 *
 * Draw-call budget (PROJECT.md §6): building bodies are merged into ONE mesh
 * per material family (glass/concrete/brick/panel) + one roof mesh; trees are
 * two InstancedMeshes. That is ~7 draw calls for the whole static city.
 *
 * Destruction removes a single building from the merged mesh by collapsing its
 * vertex range to a point (zero-area triangles -> not rasterized). We record
 * each building's vertex ranges in the family + roof buffers for that.
 *
 * No rapier import here: colliders are returned as plain descriptors and the
 * physics layer turns them into fixed cuboids.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  CanvasTexture,
  Euler,
  Vector3,
} from 'three';
import {
  FAMILY,
  TRUNK_COLOR,
  ASPHALT,
  SIDEWALK,
  BASE_BEVEL,
  type MaterialFamily,
} from '../constants';
import type { CityModel } from './cityTypes';

const GROUND_TOP = 0; // buildings/meteors rest here; pads/roads float just above

export interface BuildingCollider {
  id: number;
  hx: number;
  hy: number;
  hz: number;
  x: number;
  y: number;
  z: number;
}

export interface BuildingInfo {
  id: number;
  center: [number, number, number]; // footprint center, base at GROUND_TOP
  size: [number, number, number]; // w,h,d bounding
  color: number;
  roofColor: number;
  family: MaterialFamily;
  alive: boolean;
}

export interface CityBuild {
  group: Group;
  colliders: BuildingCollider[];
  ground: { hx: number; hy: number; hz: number; y: number };
  groundTop: number;
  infos: Map<number, BuildingInfo>;
  destroyBuilding: (id: number) => void;
  dispose: () => void;
}

// ---- window emissive texture (subtle daytime glow) ----
function makeWindowTexture(): CanvasTexture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, S, S);
  // one window pane per texture tile: a lit pane inset inside a dark mullion frame
  const pad = 10;
  ctx.fillStyle = '#7d6a4a';
  ctx.fillRect(pad, pad, S - pad * 2, S - pad * 2);
  ctx.fillStyle = '#93805c';
  ctx.fillRect(pad + 3, pad + 3, S - pad * 2 - 6, S - pad * 2 - 6);
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}

interface Accum {
  pos: number[];
  nor: number[];
  uv: number[];
  col: number[];
  count: number; // vertex count so far
}
function newAccum(): Accum {
  return { pos: [], nor: [], uv: [], col: [], count: 0 };
}

const _m4 = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _e = new Euler();

/** Append a geometry (already positioned via matrix) into an accumulator. */
function appendGeo(
  acc: Accum,
  geo: BufferGeometry,
  matrix: Matrix4,
  color: Color,
  uvRepeat: [number, number] | null,
): [number, number] {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  const start = acc.count;
  const normalMat = new Matrix4().extractRotation(matrix);
  for (let i = 0; i < p.count; i++) {
    _v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(matrix);
    acc.pos.push(_v.x, _v.y, _v.z);
    _v.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix4(normalMat).normalize();
    acc.nor.push(_v.x, _v.y, _v.z);
    if (uv && uvRepeat) acc.uv.push(uv.getX(i) * uvRepeat[0], uv.getY(i) * uvRepeat[1]);
    else if (uv) acc.uv.push(uv.getX(i), uv.getY(i));
    else acc.uv.push(0, 0);
    acc.col.push(color.r, color.g, color.b);
  }
  const added = p.count;
  acc.count += added;
  if (g !== geo) g.dispose();
  return [start, added];
}

function accumToGeometry(acc: Accum): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(acc.pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(acc.nor, 3));
  g.setAttribute('uv', new Float32BufferAttribute(acc.uv, 2));
  g.setAttribute('color', new Float32BufferAttribute(acc.col, 3));
  g.computeBoundingSphere();
  return g;
}

export function buildCityMeshes(model: CityModel, treeFactor = 1): CityBuild {
  const group = new Group();
  group.name = 'city';
  const colliders: BuildingCollider[] = [];
  const infos = new Map<number, BuildingInfo>();

  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // ---- base plate ("model board") ----
  const baseGeo = track(new BoxGeometry(model.span + 24, 6, model.span + 24));
  const baseMat = track(
    new MeshStandardMaterial({ color: BASE_BEVEL, roughness: 0.95, metalness: 0 }),
  );
  const base = new Mesh(baseGeo, baseMat);
  base.position.set(0, GROUND_TOP - 3.02, 0);
  base.receiveShadow = true;
  group.add(base);

  // ---- grass ground surface ----
  const grassGeo = track(new PlaneGeometry(model.span + 20, model.span + 20));
  const grassMat = track(
    new MeshStandardMaterial({ color: model.grassColor, roughness: 0.95, metalness: 0 }),
  );
  const grass = new Mesh(grassGeo, grassMat);
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = GROUND_TOP + 0.03;
  grass.receiveShadow = true;
  group.add(grass);

  // ---- roads (merged) ----
  {
    const acc = newAccum();
    const col = new Color(ASPHALT);
    for (const r of model.roads) {
      _m4.identity();
      _e.set(-Math.PI / 2, 0, 0);
      _q.setFromEuler(_e);
      _m4.compose(new Vector3(r.x, GROUND_TOP + 0.1, r.z), _q, new Vector3(1, 1, 1));
      const pg = new PlaneGeometry(r.w, r.d);
      appendGeo(acc, pg, _m4, col, null);
      pg.dispose();
    }
    const geo = track(accumToGeometry(acc));
    const mat = track(
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
    );
    const roads = new Mesh(geo, mat);
    roads.receiveShadow = true;
    group.add(roads);
  }

  // ---- sidewalk / plaza pads (merged) ----
  {
    const acc = newAccum();
    for (const p of model.pads) {
      _e.set(-Math.PI / 2, 0, 0);
      _q.setFromEuler(_e);
      _m4.compose(new Vector3(p.x, GROUND_TOP + 0.06, p.z), _q, new Vector3(1, 1, 1));
      const pg = new PlaneGeometry(p.w, p.d);
      appendGeo(acc, pg, _m4, new Color(p.color ?? SIDEWALK), null);
      pg.dispose();
    }
    if (model.pads.length) {
      const geo = track(accumToGeometry(acc));
      const mat = track(
        new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }),
      );
      const pads = new Mesh(geo, mat);
      pads.receiveShadow = true;
      group.add(pads);
    }
  }

  // ---- buildings, merged per family + one roof mesh ----
  const families: MaterialFamily[] = ['glass', 'concrete', 'brick', 'panel'];
  const famAccum = new Map<MaterialFamily, Accum>();
  families.forEach((f) => famAccum.set(f, newAccum()));
  const roofAccum = newAccum();

  // per-building vertex ranges so destruction can collapse them
  const bodyRange = new Map<number, { fam: MaterialFamily; start: number; count: number }>();
  const roofRange = new Map<number, { start: number; count: number }>();

  const windowTex = makeWindowTexture();

  for (const b of model.buildings) {
    const acc = famAccum.get(b.family)!;
    const col = new Color(b.color);
    const bStart = acc.count;
    let bCount = 0;

    for (const tier of b.tiers) {
      _q.identity();
      _m4.compose(
        new Vector3(b.cx, GROUND_TOP + tier.yBase + tier.h / 2, b.cz),
        _q,
        new Vector3(1, 1, 1),
      );
      const bg = new BoxGeometry(tier.w, tier.h, tier.d);
      const repeat: [number, number] | null = b.windows
        ? [b.windows.cols, Math.max(1, Math.round((tier.h / b.h) * b.windows.floors))]
        : null;
      const [, cnt] = appendGeo(acc, bg, _m4, col, repeat);
      bCount += cnt;
      bg.dispose();
    }
    bodyRange.set(b.id, { fam: b.family, start: bStart, count: bCount });

    // roof
    const rcol = new Color(b.roofColor);
    const rStart = roofAccum.count;
    let rCount = 0;
    if (b.roofType === 'gable') {
      // pyramid roof (4-sided cone) over the top tier
      const top = b.tiers[b.tiers.length - 1];
      const rh = Math.min(top.w, top.d) * 0.42;
      _e.set(0, Math.PI / 4, 0);
      _q.setFromEuler(_e);
      _m4.compose(
        new Vector3(b.cx, GROUND_TOP + b.h + rh / 2, b.cz),
        _q,
        new Vector3(1, 1, 1),
      );
      const cg = new ConeGeometry((Math.hypot(top.w, top.d) / 2) * 0.94, rh, 4);
      const [, cnt] = appendGeo(roofAccum, cg, _m4, rcol, null);
      rCount += cnt;
      cg.dispose();
    } else {
      const top = b.tiers[b.tiers.length - 1];
      _q.identity();
      _m4.compose(
        new Vector3(b.cx, GROUND_TOP + b.h + 0.3, b.cz),
        _q,
        new Vector3(1, 1, 1),
      );
      const rg = new BoxGeometry(top.w * 0.98, 0.6, top.d * 0.98);
      const [, cnt] = appendGeo(roofAccum, rg, _m4, rcol, null);
      rCount += cnt;
      rg.dispose();
    }
    roofRange.set(b.id, { start: rStart, count: rCount });

    // collider (full bounding box) + info
    colliders.push({
      id: b.id,
      hx: b.w / 2,
      hy: b.h / 2,
      hz: b.d / 2,
      x: b.cx,
      y: GROUND_TOP + b.h / 2,
      z: b.cz,
    });
    infos.set(b.id, {
      id: b.id,
      center: [b.cx, GROUND_TOP, b.cz],
      size: [b.w, b.h, b.d],
      color: b.color,
      roofColor: b.roofColor,
      family: b.family,
      alive: true,
    });
  }

  // materialize family meshes
  const famMesh = new Map<MaterialFamily, Mesh>();
  for (const f of families) {
    const acc = famAccum.get(f)!;
    if (acc.count === 0) continue;
    const geo = track(accumToGeometry(acc));
    const spec = FAMILY[f];
    const mat = track(
      new MeshStandardMaterial({
        vertexColors: true,
        roughness: spec.roughness,
        metalness: spec.metalness,
        envMapIntensity: spec.envMapIntensity,
        emissive: new Color(0xffd9a0),
        emissiveIntensity: f === 'glass' || f === 'concrete' ? 0.35 : 0,
        emissiveMap: f === 'glass' || f === 'concrete' ? windowTex : null,
      }),
    );
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // we mutate vertices; keep it simple
    mesh.name = `family-${f}`;
    group.add(mesh);
    famMesh.set(f, mesh);
  }
  track(windowTex);

  // roof mesh
  let roofMesh: Mesh | null = null;
  if (roofAccum.count > 0) {
    const geo = track(accumToGeometry(roofAccum));
    const mat = track(
      new MeshStandardMaterial({
        vertexColors: true,
        roughness: FAMILY.roof.roughness,
        metalness: 0,
        envMapIntensity: FAMILY.roof.envMapIntensity,
      }),
    );
    roofMesh = new Mesh(geo, mat);
    roofMesh.castShadow = true;
    roofMesh.receiveShadow = true;
    roofMesh.frustumCulled = false;
    group.add(roofMesh);
  }

  // ---- trees (two InstancedMeshes: trunk + foliage) ----
  const treeCount = Math.max(0, Math.floor(model.trees.length * treeFactor));
  if (treeCount > 0) {
    const trunkGeo = track(new CylinderGeometry(0.35, 0.5, 2.4, 6));
    const trunkMat = track(
      new MeshStandardMaterial({ color: TRUNK_COLOR, roughness: 0.9, metalness: 0 }),
    );
    const foliageGeo = track(new ConeGeometry(1.5, 3.4, 7));
    const foliageMat = track(
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
    );
    const trunks = new InstancedMesh(trunkGeo, trunkMat, treeCount);
    const foliage = new InstancedMesh(foliageGeo, foliageMat, treeCount);
    trunks.castShadow = foliage.castShadow = true;
    trunks.receiveShadow = foliage.receiveShadow = true;
    const c = new Color();
    for (let i = 0; i < treeCount; i++) {
      const t = model.trees[i];
      _e.set(0, t.rot, 0);
      _q.setFromEuler(_e);
      _m4.compose(
        new Vector3(t.x, GROUND_TOP + 1.2 * t.scale, t.z),
        _q,
        new Vector3(t.scale, t.scale, t.scale),
      );
      trunks.setMatrixAt(i, _m4);
      _m4.compose(
        new Vector3(t.x, GROUND_TOP + (2.4 + 1.7) * t.scale, t.z),
        _q,
        new Vector3(t.scale, t.scale, t.scale),
      );
      foliage.setMatrixAt(i, _m4);
      foliage.setColorAt(i, c.set(t.leafColor));
    }
    trunks.instanceMatrix.needsUpdate = true;
    foliage.instanceMatrix.needsUpdate = true;
    if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
    group.add(trunks);
    group.add(foliage);
  }

  // ---- destruction: collapse a building's body + roof vertices ----
  const collapseRange = (mesh: Mesh | undefined | null, start: number, count: number, at: Vector3) => {
    if (!mesh || count === 0) return;
    const pos = mesh.geometry.getAttribute('position') as Float32BufferAttribute;
    for (let i = start; i < start + count; i++) {
      pos.setXYZ(i, at.x, at.y, at.z);
    }
    pos.needsUpdate = true;
  };

  const destroyBuilding = (id: number) => {
    const info = infos.get(id);
    if (!info || !info.alive) return;
    info.alive = false;
    const at = new Vector3(info.center[0], info.center[1], info.center[2]);
    const br = bodyRange.get(id);
    if (br) collapseRange(famMesh.get(br.fam), br.start, br.count, at);
    const rr = roofRange.get(id);
    if (rr) collapseRange(roofMesh, rr.start, rr.count, at);
  };

  const ground = {
    hx: model.span / 2 + 12,
    hy: 3,
    hz: model.span / 2 + 12,
    y: GROUND_TOP - 3,
  };

  const dispose = () => {
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        /* noop */
      }
    }
    group.clear();
  };

  return { group, colliders, ground, groundTop: GROUND_TOP, infos, destroyBuilding, dispose };
}
