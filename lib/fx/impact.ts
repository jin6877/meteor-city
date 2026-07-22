/**
 * Impact FX (DESIGN §4-3 timeline): flash -> shockwave ring -> dust column ->
 * settle, plus accumulating crater/scorch decals. Everything is pooled and
 * updated imperatively; nothing here touches React state. The Engine reads
 * `bloomEnergy` each frame to spike PostFX Bloom on impact.
 */
import {
  AdditiveBlending,
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
  Float32BufferAttribute,
  Sprite,
  SpriteMaterial,
  Texture,
} from 'three';
import type { MeteorPreset } from '../meteorPresets';
import { SMOKE } from '../constants';

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

// ---------- rising smoke (dark, long-lived, alpha billboards) ----------
// Separate from dust: dust is a fast warm puff that falls back; smoke is a dark
// warm-gray column that RISES off the crater, expands, and slowly disperses
// (DESIGN §4-3 "먼지 기둥 상승 1~2s" extended). Alpha-blended (not additive) so
// it reads as smoke, not glow. Its own pooled budget, oldest reused first.
interface SmokeBurst {
  points: Points;
  vel: Float32Array;
  base: Float32Array;
  life: number;
  dur: number;
  active: boolean;
}
class SmokePool {
  private items: SmokeBurst[] = [];
  constructor(private group: Group, private tex: Texture, size: number, private perBurst: number) {
    for (let i = 0; i < size; i++) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(perBurst * 3), 3));
      const mat = new PointsMaterial({
        map: tex,
        size: SMOKE.sizeStart,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        color: SMOKE.color,
        // NormalBlending (default) — dark alpha smoke, never additive glow
      });
      const p = new Points(geo, mat);
      p.visible = false;
      p.frustumCulled = false;
      this.group.add(p);
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
  fire(pos: [number, number, number], amount: number, cool: boolean) {
    const it = this.items.find((i) => !i.active) ?? this.items[0];
    it.active = true;
    it.points.visible = true;
    it.life = 0;
    it.dur = SMOKE.life * (0.9 + Math.random() * 0.3);
    const mat = it.points.material as PointsMaterial;
    mat.color.set(cool ? SMOKE.colorCool : SMOKE.color);
    mat.size = SMOKE.sizeStart;
    mat.opacity = 0;
    const attr = it.points.geometry.getAttribute('position') as Float32BufferAttribute;
    const n = Math.min(this.perBurst, Math.max(6, Math.floor(this.perBurst * Math.min(1.4, amount))));
    for (let i = 0; i < this.perBurst; i++) {
      if (i < n) {
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.random() * SMOKE.spread;
        it.base[i * 3] = pos[0] + Math.cos(ang) * rad;
        it.base[i * 3 + 1] = pos[1] + Math.random() * SMOKE.seedColumn; // seed a short column
        it.base[i * 3 + 2] = pos[2] + Math.sin(ang) * rad;
        // mostly-up velocity with variance (elongates the plume), slight lateral drift
        it.vel[i * 3] = Math.cos(ang) * SMOKE.drift * (0.3 + Math.random() * 0.7);
        it.vel[i * 3 + 1] = SMOKE.rise + Math.random() * SMOKE.riseJitter;
        it.vel[i * 3 + 2] = Math.sin(ang) * SMOKE.drift * (0.3 + Math.random() * 0.7);
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
      // ramp in fast, HOLD near peak (so the column reads), then a long slow fade
      const a =
        t < 0.1
          ? t / 0.1
          : t < SMOKE.hold
            ? 1
            : 1 - (t - SMOKE.hold) / (1 - SMOKE.hold);
      mat.opacity = Math.max(0, a) * SMOKE.peakAlpha;
      mat.size = SMOKE.sizeStart + (SMOKE.sizeEnd - SMOKE.sizeStart) * t;
      const attr = it.points.geometry.getAttribute('position') as Float32BufferAttribute;
      for (let i = 0; i < this.perBurst; i++) {
        if (it.base[i * 3] > 90000) continue;
        it.vel[i * 3 + 1] *= 1 - 0.12 * dt; // buoyancy slowly bleeds off
        it.vel[i * 3] *= 1 + 0.25 * dt; // drift out as it dissipates
        it.vel[i * 3 + 2] *= 1 + 0.25 * dt;
        it.base[i * 3] += it.vel[i * 3] * dt;
        it.base[i * 3 + 1] += it.vel[i * 3 + 1] * dt;
        it.base[i * 3 + 2] += it.vel[i * 3 + 2] * dt;
        attr.setXYZ(i, it.base[i * 3], it.base[i * 3 + 1], it.base[i * 3 + 2]);
      }
      attr.needsUpdate = true;
    }
  }
  clear() {
    for (const it of this.items) {
      it.active = false;
      it.points.visible = false;
      (it.points.material as PointsMaterial).opacity = 0;
    }
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
  private smoke: SmokePool;
  private decals: DecalPool;
  private soft: Texture;
  private ring: Texture;
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
    // smoke budget is SEPARATE from debris/rubble and scales with tier
    this.smoke = new SmokePool(this.group, this.soft, low ? 6 : 8, low ? 26 : 40);
    this.decals = new DecalPool(this.group, 28);
  }

  /** Flash + shockwave ring + dust + bloom spike AT the contact point (any height). */
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
      // over water -> a pale, thin steam wisp rather than dark smoke
      this.smoke.fire(point, preset.dustAmount * 0.5, true);
    } else {
      this.flashes.fire(point, preset.flashColor, flashScale, preset.flashIntensity);
      this.rings.fire(point, R2, 0xf5ead8);
      this.dust.fire(point, preset.dustColor, preset.dustAmount, preset.dustCool);
      // rising smoke column off the impact/crater — bigger blasts smoke more
      this.smoke.fire(point, 0.7 + preset.dustAmount * 0.5, preset.dustCool);
    }
    this.bloomEnergy = Math.max(this.bloomEnergy, preset.bloomSpike);
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
    this.flashes.update(dt);
    this.rings.update(dt);
    this.dust.update(dt);
    this.smoke.update(dt);
    // bloom energy decays back toward 0 (Engine lerps actual bloom toward base)
    this.bloomEnergy = Math.max(0, this.bloomEnergy - dt * 2.2);
  }

  clearDecals() {
    this.decals.clear();
  }

  /** Drop any in-flight smoke (used on city reset/regenerate). */
  clearSmoke() {
    this.smoke.clear();
  }
}
