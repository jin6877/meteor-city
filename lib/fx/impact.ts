/**
 * Impact FX (DESIGN §4-3 timeline): flash -> shockwave ring -> dust column ->
 * settle, plus accumulating crater/scorch decals. Everything is pooled and
 * updated imperatively; nothing here touches React state. The Engine reads
 * `bloomEnergy` each frame to spike PostFX Bloom on impact.
 */
import {
  AdditiveBlending,
  NormalBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  BufferGeometry,
  BufferAttribute,
  Float32BufferAttribute,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Texture,
} from 'three';
import type { MeteorPreset } from '../meteorPresets';
import { SMOKE, FIRE } from '../constants';

// ---------- textures (generated once) ----------
function softCircleTex(): Texture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new CanvasTexture(c);
}
function ringTex(): Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.62, 'rgba(255,255,255,0)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.9, 'rgba(255,255,255,0.15)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new CanvasTexture(c);
}
function craterTex(dark: number, rim: number): Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const dc = new Color(dark),
    rc = new Color(rim);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  const hx = (col: Color, a: number) =>
    `rgba(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0},${a})`;
  g.addColorStop(0.0, hx(dc, 0.95));
  g.addColorStop(0.55, hx(dc, 0.9));
  g.addColorStop(0.72, hx(rc, 0.85)); // raised rim, slightly lighter
  g.addColorStop(0.85, hx(dc, 0.4)); // scorch falloff
  g.addColorStop(1.0, hx(dc, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new CanvasTexture(c);
}

// ---------- flash (camera-facing sprite pool) ----------
class FlashPool {
  private items: { sprite: Sprite; life: number; dur: number; peak: number }[] = [];
  constructor(private group: Group, private tex: Texture, size: number) {
    for (let i = 0; i < size; i++) {
      const mat = new SpriteMaterial({
        map: tex,
        color: 0xffffff,
        blending: AdditiveBlending,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
      });
      const s = new Sprite(mat);
      s.visible = false;
      group.add(s);
      this.items.push({ sprite: s, life: 0, dur: 1, peak: 1 });
    }
  }
  fire(pos: [number, number, number], color: number, scale: number, intensity: number) {
    const it = this.items.find((i) => !i.sprite.visible) ?? this.items[0];
    it.sprite.visible = true;
    it.sprite.position.set(pos[0], pos[1], pos[2]);
    (it.sprite.material as SpriteMaterial).color.set(color);
    it.sprite.scale.setScalar(scale);
    it.life = 0;
    it.dur = 0.22;
    it.peak = Math.min(1, intensity / 8);
  }
  update(dt: number) {
    for (const it of this.items) {
      if (!it.sprite.visible) continue;
      it.life += dt;
      const t = it.life / it.dur;
      const mat = it.sprite.material as SpriteMaterial;
      if (t >= 1) {
        it.sprite.visible = false;
        mat.opacity = 0;
        continue;
      }
      // fast ramp (first 12%) then decay
      const a = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
      mat.opacity = Math.max(0, a) * it.peak;
      it.sprite.scale.setScalar(it.sprite.scale.x * (1 + dt * 0.6));
    }
  }
}

// ---------- shockwave rings (ground-hugging planes) ----------
class RingPool {
  private items: { mesh: Mesh; life: number; dur: number; maxR: number; base: number }[] = [];
  constructor(private group: Group, tex: Texture, size: number) {
    const geo = new PlaneGeometry(1, 1);
    for (let i = 0; i < size; i++) {
      const mat = new MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        color: 0xf5ead8, // warm dust white (DESIGN §4-3, no sci-fi cyan)
      });
      const m = new Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      group.add(m);
      this.items.push({ mesh: m, life: 0, dur: 1, maxR: 1, base: 1 });
    }
  }
  fire(pos: [number, number, number], maxR: number, color: number) {
    const it = this.items.find((i) => !i.mesh.visible) ?? this.items[0];
    it.mesh.visible = true;
    // ring hugs the contact height (building-top hits ring up high, ground hits low)
    it.mesh.position.set(pos[0], Math.max(0.14, pos[1]), pos[2]);
    (it.mesh.material as MeshBasicMaterial).color.set(color);
    it.life = 0;
    it.dur = 0.55;
    it.maxR = maxR;
    it.base = maxR * 0.3;
    it.mesh.scale.setScalar(it.base);
  }
  update(dt: number) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.life += dt;
      const t = it.life / it.dur;
      const mat = it.mesh.material as MeshBasicMaterial;
      if (t >= 1) {
        it.mesh.visible = false;
        mat.opacity = 0;
        continue;
      }
      const eased = 1 - Math.pow(1 - t, 2); // ease-out expand
      it.mesh.scale.setScalar(it.base + (it.maxR * 2 - it.base) * eased);
      mat.opacity = (1 - t) * 0.9;
    }
  }
}

// ---------- dust bursts (Points pool) ----------
interface Burst {
  points: Points;
  vel: Float32Array;
  base: Float32Array;
  life: number;
  dur: number;
  active: boolean;
}
class DustPool {
  private items: Burst[] = [];
  constructor(private group: Group, private tex: Texture, size: number, private perBurst: number) {
    for (let i = 0; i < size; i++) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(perBurst * 3), 3));
      const mat = new PointsMaterial({
        map: tex,
        size: 6,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        color: 0x9a8f7e,
      });
      const p = new Points(geo, mat);
      p.visible = false;
      p.frustumCulled = false;
      group.add(p);
      this.items.push({
        points: p,
        vel: new Float32Array(perBurst * 3),
        base: new Float32Array(perBurst * 3),
        life: 0,
        dur: 1,
        active: false,
      });
    }
  }
  fire(pos: [number, number, number], color: number, amount: number, cool: boolean) {
    const it = this.items.find((i) => !i.active) ?? this.items[0];
    it.active = true;
    it.points.visible = true;
    it.life = 0;
    it.dur = cool ? 2.2 : 1.6;
    (it.points.material as PointsMaterial).color.set(color);
    (it.points.material as PointsMaterial).size = cool ? 7 : 6;
    const attr = it.points.geometry.getAttribute('position') as Float32BufferAttribute;
    const n = Math.min(this.perBurst, Math.floor(this.perBurst * Math.min(1.5, amount)));
    for (let i = 0; i < this.perBurst; i++) {
      if (i < n) {
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.random() * 2;
        it.base[i * 3] = pos[0] + Math.cos(ang) * rad;
        it.base[i * 3 + 1] = pos[1] + Math.random() * 1.5;
        it.base[i * 3 + 2] = pos[2] + Math.sin(ang) * rad;
        const out = 6 + Math.random() * 10;
        it.vel[i * 3] = Math.cos(ang) * out * (0.4 + Math.random() * 0.6);
        it.vel[i * 3 + 1] = 6 + Math.random() * 12; // rise
        it.vel[i * 3 + 2] = Math.sin(ang) * out * (0.4 + Math.random() * 0.6);
      } else {
        it.base[i * 3] = it.base[i * 3 + 1] = it.base[i * 3 + 2] = 99999;
        it.vel[i * 3] = it.vel[i * 3 + 1] = it.vel[i * 3 + 2] = 0;
      }
      attr.setXYZ(i, it.base[i * 3], it.base[i * 3 + 1], it.base[i * 3 + 2]);
    }
    attr.needsUpdate = true;
  }
  update(dt: number) {
    for (const it of this.items) {
      if (!it.active) continue;
      it.life += dt;
      const t = it.life / it.dur;
      const mat = it.points.material as PointsMaterial;
      if (t >= 1) {
        it.active = false;
        it.points.visible = false;
        mat.opacity = 0;
        continue;
      }
      mat.opacity = (1 - t) * 0.7;
      const attr = it.points.geometry.getAttribute('position') as Float32BufferAttribute;
      for (let i = 0; i < this.perBurst; i++) {
        if (it.base[i * 3] > 90000) continue;
        it.vel[i * 3 + 1] -= 9 * dt; // gravity on dust
        it.vel[i * 3] *= 1 - 0.6 * dt; // drag
        it.vel[i * 3 + 2] *= 1 - 0.6 * dt;
        it.base[i * 3] += it.vel[i * 3] * dt;
        it.base[i * 3 + 1] += it.vel[i * 3 + 1] * dt;
        it.base[i * 3 + 2] += it.vel[i * 3 + 2] * dt;
        attr.setXYZ(i, it.base[i * 3], it.base[i * 3 + 1], it.base[i * 3 + 2]);
      }
      attr.needsUpdate = true;
    }
  }
}

// ---------- generic particle field (continuous ring buffer, per-particle look) ----------
// One Points cloud whose particles can differ in size / color / alpha over their
// own lifetime (a plain PointsMaterial can't — its size is per-cloud). A tiny
// ShaderMaterial gives us per-particle gl_PointSize + color + alpha, so a single
// bounded pool backs flame, embers, and the smoke column. Ring-buffer emission
// recycles the oldest particle, capping live count regardless of emission rate.
interface FieldCfg {
  additive: boolean;
  sizeStart: number;
  sizeEnd: number;
  colorStart: Color;
  colorEnd: Color;
  peakAlpha: number;
  hold: number; // fraction of life held near peak before fade
  gravity: number; // subtracted from vy each second (embers arc down)
  buoyancyDamp: number; // vy *= (1 - this*dt) (smoke tops out)
  drift: number; // vx,vz *= (1 + this*dt) (expands as it disperses)
  boost: number; // rgb multiplier (>1 pushes additive flame cores into Bloom)
  tintJitter: number; // per-particle brightness variance
}

const POINT_VERT = /* glsl */ `
  uniform float uScale;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (uScale / max(-mv.z, 0.1));
    gl_Position = projectionMatrix * mv;
  }
`;
const POINT_FRAG = /* glsl */ `
  uniform sampler2D uTex;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.002) discard;
    float a = texture2D(uTex, gl_PointCoord).a * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`;

class ParticleField {
  readonly points: Points;
  private cfg: FieldCfg;
  private n: number;
  private cursor = 0;
  private geo: BufferGeometry;
  private mat: ShaderMaterial;
  // per-particle state
  private px: Float32Array;
  private aSize: Float32Array;
  private aColor: Float32Array;
  private aAlpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private seed: Float32Array;
  private c0: Float32Array; // per-particle start color (rgb)
  private c1: Float32Array; // per-particle end color (rgb)

  constructor(group: Group, tex: Texture, count: number, cfg: FieldCfg) {
    this.cfg = cfg;
    this.n = count;
    this.px = new Float32Array(count * 3);
    this.aSize = new Float32Array(count);
    this.aColor = new Float32Array(count * 3);
    this.aAlpha = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.max = new Float32Array(count);
    this.seed = new Float32Array(count);
    this.c0 = new Float32Array(count * 3);
    this.c1 = new Float32Array(count * 3);

    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.px, 3));
    this.geo.setAttribute('aSize', new BufferAttribute(this.aSize, 1));
    this.geo.setAttribute('aColor', new BufferAttribute(this.aColor, 3));
    this.geo.setAttribute('aAlpha', new BufferAttribute(this.aAlpha, 1));
    this.mat = new ShaderMaterial({
      uniforms: { uTex: { value: tex }, uScale: { value: 300 } },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: cfg.additive ? AdditiveBlending : NormalBlending,
    });
    this.points = new Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    group.add(this.points);
  }

  /** Spawn one particle (overwrites the oldest slot). Optional per-emit colors. */
  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number,
    colA?: Color,
    colB?: Color,
  ) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.px[i * 3] = x;
    this.px[i * 3 + 1] = y;
    this.px[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = 0;
    this.max[i] = life;
    this.seed[i] = Math.random();
    const a = colA ?? this.cfg.colorStart;
    const b = colB ?? this.cfg.colorEnd;
    this.c0[i * 3] = a.r; this.c0[i * 3 + 1] = a.g; this.c0[i * 3 + 2] = a.b;
    this.c1[i * 3] = b.r; this.c1[i * 3 + 1] = b.g; this.c1[i * 3 + 2] = b.b;
  }

  update(dt: number) {
    const { sizeStart, sizeEnd, peakAlpha, hold, gravity, buoyancyDamp, drift, boost, tintJitter } =
      this.cfg;
    for (let i = 0; i < this.n; i++) {
      const m = this.max[i];
      if (m <= 0) continue; // dead / never emitted
      const l = this.life[i] + dt;
      if (l >= m) {
        this.max[i] = 0;
        this.aAlpha[i] = 0;
        this.aSize[i] = 0;
        continue;
      }
      this.life[i] = l;
      const t = l / m;
      // integrate
      const vy = this.vel[i * 3 + 1] * (1 - buoyancyDamp * dt) - gravity * dt;
      this.vel[i * 3 + 1] = vy;
      this.vel[i * 3] *= 1 + drift * dt;
      this.vel[i * 3 + 2] *= 1 + drift * dt;
      this.px[i * 3] += this.vel[i * 3] * dt;
      this.px[i * 3 + 1] += vy * dt;
      this.px[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      // visual
      const sm = 0.7 + this.seed[i] * 0.6;
      this.aSize[i] = (sizeStart + (sizeEnd - sizeStart) * t) * sm;
      const tint = (1 + (this.seed[i] - 0.5) * tintJitter) * boost;
      this.aColor[i * 3] = (this.c0[i * 3] + (this.c1[i * 3] - this.c0[i * 3]) * t) * tint;
      this.aColor[i * 3 + 1] =
        (this.c0[i * 3 + 1] + (this.c1[i * 3 + 1] - this.c0[i * 3 + 1]) * t) * tint;
      this.aColor[i * 3 + 2] =
        (this.c0[i * 3 + 2] + (this.c1[i * 3 + 2] - this.c0[i * 3 + 2]) * t) * tint;
      const a = t < 0.12 ? t / 0.12 : t < hold ? 1 : 1 - (t - hold) / (1 - hold);
      this.aAlpha[i] = Math.max(0, a) * peakAlpha;
    }
    (this.geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aColor') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as BufferAttribute).needsUpdate = true;
  }

  clear() {
    this.max.fill(0);
    this.aAlpha.fill(0);
    this.aSize.fill(0);
    (this.geo.getAttribute('aAlpha') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------- fire system (disaster drama: flames + embers + smoke columns) ----------
// A fire "site" is ignited at each impact crater and at a few of the buildings it
// levels. It burns for a while — breathing / re-igniting via a flare envelope —
// continuously spitting short-lived flame tongues + rising embers and feeding a
// dark smoke column, then fades. Bigger blasts light bigger, longer fires. Flame
// + ember + smoke each have their OWN pooled particle budget (tier-scaled),
// separate from debris; a site cap drops the oldest fire. The base miniature tone
// is kept (translucent smoke, small bright flames), the drama is in accumulation.
interface FireSite {
  x: number; y: number; z: number;
  rad: number;
  intensity: number;
  born: number;
  life: number;
  phase: number;
  flameAcc: number;
  emberAcc: number;
  smokeAcc: number;
}
class FireSystem {
  private flame: ParticleField;
  private ember: ParticleField;
  private smoke: ParticleField;
  private sites: FireSite[] = [];
  private maxSites: number;
  private simTime = 0;
  // scratch colors (avoid per-emit allocation)
  private _cool0 = new Color(SMOKE.colorCool);
  private _cool1 = new Color(SMOKE.colorCool).lerp(new Color(0xffffff), 0.25);

  constructor(group: Group, soft: Texture, low: boolean) {
    this.maxSites = low ? FIRE.sites.low : FIRE.sites.high;
    this.flame = new ParticleField(group, soft, low ? FIRE.flameCount.low : FIRE.flameCount.high, {
      additive: true,
      sizeStart: FIRE.flameSizeStart,
      sizeEnd: FIRE.flameSizeEnd,
      colorStart: new Color(FIRE.hot),
      colorEnd: new Color(FIRE.deep),
      peakAlpha: 0.9,
      hold: 0.15,
      gravity: 0,
      buoyancyDamp: 0.4,
      drift: 0.2,
      boost: 1.5, // bright cores tip over the Bloom threshold
      tintJitter: 0.25,
    });
    this.ember = new ParticleField(group, soft, low ? FIRE.emberCount.low : FIRE.emberCount.high, {
      additive: true,
      sizeStart: FIRE.emberSize,
      sizeEnd: FIRE.emberSize * 0.4,
      colorStart: new Color(FIRE.emberColor),
      colorEnd: new Color(FIRE.deep),
      peakAlpha: 1.0,
      hold: 0.2,
      gravity: FIRE.emberGravity,
      buoyancyDamp: 0.1,
      drift: 0.1,
      boost: 1.4,
      tintJitter: 0.3,
    });
    this.smoke = new ParticleField(group, soft, low ? SMOKE.count.low : SMOKE.count.high, {
      additive: false,
      sizeStart: SMOKE.sizeStart,
      sizeEnd: SMOKE.sizeEnd,
      colorStart: new Color(SMOKE.color),
      colorEnd: new Color(SMOKE.colorEnd),
      peakAlpha: SMOKE.peakAlpha,
      hold: SMOKE.hold,
      gravity: 0,
      buoyancyDamp: SMOKE.buoyancyDamp,
      drift: SMOKE.drift,
      boost: 1,
      tintJitter: 0.14,
    });
  }

  /** Light a fire at an impact/collapse site. scale ~ blast R1. */
  ignite(pos: [number, number, number], scale: number, cool: boolean) {
    if (cool) return; // water/ice gets steam (via puffSmoke), not flame
    const rad = Math.max(FIRE.radiusMin, Math.min(FIRE.radiusMax, scale * FIRE.radiusScale));
    const intensity = 0.7 + Math.min(1.6, scale / 22);
    this.sites.push({
      x: pos[0], y: Math.max(0.2, pos[1]), z: pos[2],
      rad,
      intensity,
      born: this.simTime,
      life: FIRE.life * (0.7 + intensity * 0.4) + Math.random() * FIRE.lifeJitter,
      phase: Math.random() * 10,
      flameAcc: 0, emberAcc: 0, smokeAcc: 0,
    });
    while (this.sites.length > this.maxSites) this.sites.shift();
  }

  /** One-shot smoke puff at the moment of impact (dark, or pale steam over water). */
  puffSmoke(pos: [number, number, number], amount: number, cool: boolean) {
    const n = Math.max(8, Math.floor(22 * Math.min(1.6, amount)));
    for (let k = 0; k < n; k++) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * SMOKE.spread * 1.4;
      const vy = SMOKE.rise * (0.7 + Math.random() * 0.9) + Math.random() * SMOKE.riseJitter;
      const life = SMOKE.life * (0.7 + Math.random() * 0.4);
      if (cool) {
        this.smoke.emit(
          pos[0] + Math.cos(ang) * r, pos[1] + Math.random() * SMOKE.seedColumn, pos[2] + Math.sin(ang) * r,
          Math.cos(ang) * SMOKE.drift, vy, Math.sin(ang) * SMOKE.drift, life,
          this._cool0, this._cool1,
        );
      } else {
        this.smoke.emit(
          pos[0] + Math.cos(ang) * r, pos[1] + Math.random() * SMOKE.seedColumn, pos[2] + Math.sin(ang) * r,
          Math.cos(ang) * SMOKE.drift, vy, Math.sin(ang) * SMOKE.drift, life,
        );
      }
    }
  }

  update(dt: number, simTime: number) {
    this.simTime = simTime;
    for (let i = this.sites.length - 1; i >= 0; i--) {
      const s = this.sites[i];
      const age = simTime - s.born;
      if (age >= s.life) {
        this.sites.splice(i, 1);
        continue;
      }
      const lifeK = 1 - age / s.life; // overall fade to death
      // breathing / re-ignition flare (fire never sits at a flat brightness)
      const flare = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin((age + s.phase) * (6.283 / FIRE.reignite)));
      const strength = lifeK * flare * s.intensity;

      s.flameAcc += FIRE.flameRate * strength * dt;
      let nf = s.flameAcc | 0;
      s.flameAcc -= nf;
      while (nf-- > 0) {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * s.rad * 0.55;
        this.flame.emit(
          s.x + Math.cos(ang) * r,
          s.y + Math.random() * s.rad * 0.3,
          s.z + Math.sin(ang) * r,
          Math.cos(ang) * 0.6 + (Math.random() - 0.5) * 1.6,
          FIRE.flameRise * (0.7 + Math.random() * 0.7),
          Math.sin(ang) * 0.6 + (Math.random() - 0.5) * 1.6,
          FIRE.flameLife * (0.7 + Math.random() * 0.6),
        );
      }

      s.emberAcc += FIRE.emberRate * strength * dt;
      let ne = s.emberAcc | 0;
      s.emberAcc -= ne;
      while (ne-- > 0) {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * s.rad * 0.5;
        this.ember.emit(
          s.x + Math.cos(ang) * r,
          s.y + Math.random() * s.rad * 0.3,
          s.z + Math.sin(ang) * r,
          Math.cos(ang) * (1 + Math.random() * 2),
          FIRE.emberRise * (0.6 + Math.random() * 0.9),
          Math.sin(ang) * (1 + Math.random() * 2),
          FIRE.emberLife * (0.6 + Math.random() * 0.8),
        );
      }

      s.smokeAcc += FIRE.smokeRate * (0.5 + strength * 0.7) * dt;
      let ns = s.smokeAcc | 0;
      s.smokeAcc -= ns;
      while (ns-- > 0) {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * s.rad * 0.5;
        this.smoke.emit(
          s.x + Math.cos(ang) * r,
          s.y + s.rad * 0.3 + Math.random() * SMOKE.seedColumn,
          s.z + Math.sin(ang) * r,
          Math.cos(ang) * SMOKE.drift,
          SMOKE.rise + Math.random() * SMOKE.riseJitter,
          Math.sin(ang) * SMOKE.drift,
          SMOKE.life * (0.8 + Math.random() * 0.4),
        );
      }
    }
    this.flame.update(dt);
    this.ember.update(dt);
    this.smoke.update(dt);
  }

  clear() {
    this.sites.length = 0;
    this.flame.clear();
    this.ember.clear();
    this.smoke.clear();
  }

  dispose() {
    this.flame.dispose();
    this.ember.dispose();
    this.smoke.dispose();
  }
}

// ---------- decals (crater/scorch ring buffer) ----------
class DecalPool {
  private meshes: Mesh[] = [];
  private cursor = 0;
  private geo = new PlaneGeometry(1, 1);
  private texCache = new Map<string, Texture>();
  constructor(private group: Group, private max: number) {}
  private tex(dark: number, rim: number): Texture {
    const key = `${dark}_${rim}`;
    let t = this.texCache.get(key);
    if (!t) {
      t = craterTex(dark, rim);
      this.texCache.set(key, t);
    }
    return t;
  }
  place(pos: [number, number, number], size: number, dark: number, rim: number) {
    let m = this.meshes[this.cursor];
    if (!m) {
      const mat = new MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        side: DoubleSide,
      });
      m = new Mesh(this.geo, mat);
      m.rotation.x = -Math.PI / 2;
      this.group.add(m);
      this.meshes[this.cursor] = m;
    }
    (m.material as MeshBasicMaterial).map = this.tex(dark, rim);
    (m.material as MeshBasicMaterial).needsUpdate = true;
    m.position.set(pos[0], 0.09 + this.cursor * 0.002, pos[2]);
    m.scale.setScalar(size);
    m.rotation.z = Math.random() * Math.PI;
    m.visible = true;
    this.cursor = (this.cursor + 1) % this.max;
  }
  clear() {
    for (const m of this.meshes) m.visible = false;
    this.cursor = 0;
  }
}

export interface FXOptions {
  lowTier?: boolean;
  dustPerBurst?: number;
}

export class FXManager {
  readonly group = new Group();
  private flashes: FlashPool;
  private rings: RingPool;
  private dust: DustPool;
  private fire: FireSystem;
  private decals: DecalPool;
  private soft: Texture;
  private ring: Texture;
  private t = 0; // fx-local monotonic clock for fire-site aging
  bloomEnergy = 0; // decays each frame; Engine maps to Bloom intensity

  constructor(opts: FXOptions = {}) {
    const low = opts.lowTier ?? false;
    const dustPerBurst = opts.dustPerBurst ?? 48;
    this.group.name = 'fx';
    this.soft = softCircleTex();
    this.ring = ringTex();
    this.flashes = new FlashPool(this.group, this.soft, 8);
    this.rings = new RingPool(this.group, this.ring, 8);
    this.dust = new DustPool(this.group, this.soft, 10, dustPerBurst);
    // fire/ember/smoke budgets are SEPARATE from debris/rubble and scale with tier
    this.fire = new FireSystem(this.group, this.soft, low);
    this.decals = new DecalPool(this.group, 28);
  }

  /** Flash + shockwave ring + dust + smoke puff + bloom spike AT the contact point. */
  burst(
    point: [number, number, number],
    preset: MeteorPreset,
    R1: number,
    R2: number,
    overWater: boolean,
  ) {
    const flashScale = R1 * 0.9;
    if (overWater) {
      this.flashes.fire(point, 0xdff1f7, flashScale * 0.8, preset.flashIntensity * 0.7);
      this.rings.fire(point, R2, 0xbfe0ea);
      this.dust.fire(point, 0xcfe2e8, preset.dustAmount * 1.3, true); // splash
      this.dust.fire([point[0], point[1] + 1, point[2]], 0xdff1f7, 0.6, true);
      // over water -> a pale steam wisp rather than dark smoke
      this.fire.puffSmoke(point, preset.dustAmount * 0.6, true);
    } else {
      this.flashes.fire(point, preset.flashColor, flashScale, preset.flashIntensity);
      this.rings.fire(point, R2, 0xf5ead8);
      this.dust.fire(point, preset.dustColor, preset.dustAmount, preset.dustCool);
      // immediate dark smoke puff off the blast (fires then keep the column going)
      this.fire.puffSmoke(point, 1.0 + preset.dustAmount * 0.6, preset.dustCool);
    }
    this.bloomEnergy = Math.max(this.bloomEnergy, preset.bloomSpike);
  }

  /** Light a persistent fire (flames + embers + smoke column). scale ~ blast R1. */
  ignite(point: [number, number, number], scale: number, cool: boolean) {
    this.fire.ignite(point, scale, cool);
  }

  /** Persistent crater + scorch decal on the GROUND (where the meteor embeds). */
  crater(point: [number, number, number], preset: MeteorPreset, overWater: boolean) {
    if (overWater) return; // water gets ripples, not a crater
    this.decals.place(
      point,
      preset.R1 * 1.5 * preset.craterScale,
      preset.craterDark,
      0x6e6152,
    );
  }

  update(dt: number) {
    this.t += dt;
    this.flashes.update(dt);
    this.rings.update(dt);
    this.dust.update(dt);
    this.fire.update(dt, this.t);
    // bloom energy decays back toward 0 (Engine lerps actual bloom toward base)
    this.bloomEnergy = Math.max(0, this.bloomEnergy - dt * 2.2);
  }

  clearDecals() {
    this.decals.clear();
  }

  /** Drop all in-flight fire/ember/smoke (used on city reset/regenerate). */
  clearSmoke() {
    this.fire.clear();
  }

  dispose() {
    this.fire.dispose();
  }
}
