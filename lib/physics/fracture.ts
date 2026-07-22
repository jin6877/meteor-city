/**
 * Runtime Voronoi fracture cache (three-pinata). PROJECT.md wants runtime
 * fracture but forbids per-impact hitches. Key insight: this version of
 * three-pinata splits a whole mesh uniformly (no impact point), so we
 * pre-fracture a UNIT cube a few times at load (~3-5ms each), cache the
 * fragment geometries + convex-hull points, then reuse them for every building
 * by baking the building's size into the instance matrix + scaled hull. No
 * fracture call happens during gameplay -> no hitch.
 */
import { BoxGeometry, Mesh, MeshStandardMaterial, type BufferGeometry } from 'three';
import { fracture, FractureOptions } from 'three-pinata';

export interface FragmentProto {
  geometry: BufferGeometry; // unit-cube-local fragment ([-0.5,0.5] space)
  hull: Float32Array; // vertex positions for Rapier convex hull (unit space)
  centroid: [number, number, number]; // for radial impulse direction
}

export interface FractureTemplate {
  count: number; // fragment count of this template (for size/zone-proportional detail)
  protos: FragmentProto[];
}

let cache: FractureTemplate[] | null = null;
let cacheKey = '';

function fractureOne(fragmentCount: number, mat: MeshStandardMaterial): FractureTemplate {
  const cube = new BoxGeometry(1, 1, 1);
  const mesh = new Mesh(cube, mat);
  const opts = new FractureOptions();
  opts.fragmentCount = fragmentCount;
  opts.fractureMode = 'Convex';
  opts.fracturePlanes = { x: true, y: true, z: true };
  const frags = fracture(mesh, opts);
  const protos: FragmentProto[] = [];
  for (const f of frags) {
    const g = f.toGeometry();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position');
    const hull = new Float32Array(pos.count * 3);
    let cx = 0,
      cy = 0,
      cz = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i),
        y = pos.getY(i),
        z = pos.getZ(i);
      hull[i * 3] = x;
      hull[i * 3 + 1] = y;
      hull[i * 3 + 2] = z;
      cx += x;
      cy += y;
      cz += z;
    }
    const inv = pos.count > 0 ? 1 / pos.count : 0;
    protos.push({ geometry: g, hull, centroid: [cx * inv, cy * inv, cz * inv] });
  }
  cube.dispose();
  return { count: frags.length || fragmentCount, protos };
}

/**
 * Build one template per requested fragment count (coarse..fine). Small/far
 * buildings use a coarse template, large/near ones a fine template, so bigger
 * buildings shatter into more pieces. All runs happen once at load.
 */
export function buildFractureCache(counts: number[] = [12, 20]): FractureTemplate[] {
  const key = counts.slice().sort((a, b) => a - b).join(',');
  if (cache && cacheKey === key) return cache;
  const mat = new MeshStandardMaterial();
  cache = counts.map((c) => fractureOne(c, mat));
  cacheKey = key;
  return cache;
}

export function getFractureCache(): FractureTemplate[] | null {
  return cache;
}

/** Test/deterministic helper (no cache side effect). */
export function fractureUnitCube(fragmentCount: number): FragmentProto[] {
  const cube = new BoxGeometry(1, 1, 1);
  const mesh = new Mesh(cube, new MeshStandardMaterial());
  const opts = new FractureOptions();
  opts.fragmentCount = fragmentCount;
  opts.fractureMode = 'Convex';
  opts.fracturePlanes = { x: true, y: true, z: true };
  const frags = fracture(mesh, opts);
  cube.dispose();
  return frags.map((f) => {
    const g = f.toGeometry();
    const pos = g.getAttribute('position');
    const hull = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      hull[i * 3] = pos.getX(i);
      hull[i * 3 + 1] = pos.getY(i);
      hull[i * 3 + 2] = pos.getZ(i);
    }
    return { geometry: g, hull, centroid: [0, 0, 0] as [number, number, number] };
  });
}
