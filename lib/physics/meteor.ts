/**
 * Meteor: physics body (CCD so it can't tunnel through the city at high speed)
 * + the visible low-poly displaced mesh differentiated per preset (DESIGN §4-1).
 */
import RAPIER from '@dimforge/rapier3d-compat';
import {
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Color,
  Group,
  ConeGeometry,
  AdditiveBlending,
  BackSide,
} from 'three';
import type { MeteorPreset } from '../meteorPresets';

type RWorld = InstanceType<typeof RAPIER.World>;
type RBody = InstanceType<typeof RAPIER.RigidBody>;

export interface MeteorBody {
  body: RBody;
  colliderHandle: number;
}

export function spawnMeteorBody(
  world: RWorld,
  opts: {
    radius: number;
    density: number;
    pos: [number, number, number];
    vel: [number, number, number];
  },
): MeteorBody {
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(opts.pos[0], opts.pos[1], opts.pos[2])
    .setCcdEnabled(true) // continuous collision — critical for a fast meteor
    .setCanSleep(false)
    .setLinearDamping(0.0);
  const body = world.createRigidBody(bodyDesc);
  const colDesc = RAPIER.ColliderDesc.ball(opts.radius)
    .setDensity(opts.density)
    .setRestitution(0.05)
    .setFriction(0.6)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  const collider = world.createCollider(colDesc, body);
  body.setLinvel({ x: opts.vel[0], y: opts.vel[1], z: opts.vel[2] }, true);
  return { body, colliderHandle: collider.handle };
}

/** Deterministic-ish hash for per-vertex displacement (not seed-critical). */
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Build the visible meteor object: displaced icosphere + optional tail. */
export function buildMeteorMesh(preset: MeteorPreset, radius: number): Group {
  const group = new Group();
  const geo = new IcosahedronGeometry(radius, preset.detail);
  const pos = geo.getAttribute('position');
  const v = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < pos.count; i++) {
    v.x = pos.getX(i);
    v.y = pos.getY(i);
    v.z = pos.getZ(i);
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    const n = hash3(v.x * 2.1, v.y * 2.1, v.z * 2.1) - 0.5;
    const scale = 1 + n * preset.noise;
    pos.setXYZ(i, (v.x / len) * radius * scale, (v.y / len) * radius * scale, (v.z / len) * radius * scale);
  }
  geo.computeVertexNormals();

  const mat = new MeshStandardMaterial({
    color: new Color(preset.bodyColor),
    roughness: preset.roughness,
    metalness: preset.metalness,
    emissive: new Color(preset.emissive),
    emissiveIntensity: preset.emissiveIntensity,
    flatShading: preset.flat,
  });
  const mesh = new Mesh(geo, mat);
  mesh.castShadow = true;
  group.add(mesh);

  // hot rim / glow shell (subtle, additive)
  if (preset.emissiveIntensity > 0.2) {
    const glowGeo = new IcosahedronGeometry(radius * 1.18, 1);
    const glowMat = new MeshStandardMaterial({
      color: new Color(preset.emissive),
      emissive: new Color(preset.emissive),
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.25,
      blending: AdditiveBlending,
      side: BackSide,
      depthWrite: false,
    });
    group.add(new Mesh(glowGeo, glowMat));
  }

  // comet / iron tail
  if (preset.id === 'comet' || preset.id === 'iron') {
    const tailLen = radius * (preset.id === 'comet' ? 7 : 3.5);
    const tailGeo = new ConeGeometry(radius * 0.85, tailLen, 12, 1, true);
    const tailMat = new MeshStandardMaterial({
      color: new Color(preset.trailColor),
      emissive: new Color(preset.trailColor),
      emissiveIntensity: 1.2,
      transparent: true,
      opacity: preset.id === 'comet' ? 0.4 : 0.3,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const tail = new Mesh(tailGeo, tailMat);
    // tail points up (opposite of downward travel); cone apex up
    tail.position.y = tailLen / 2;
    group.add(tail);
    group.userData.tail = tail;
  }

  group.userData.meshMat = mat;
  return group;
}
