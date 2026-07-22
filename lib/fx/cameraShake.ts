/**
 * Trauma-based camera shake (DESIGN §4-3): amplitude scales with trauma^2 and
 * decays. Applied by the Engine AFTER OrbitControls has positioned the camera,
 * so the offset never accumulates (controls reset it next frame). Rotation-led
 * with a small positional nudge; deliberately restrained to not wreck capture.
 */
import type { Camera, Vector3 } from 'three';

export class CameraShake {
  private trauma = 0;
  private t = 0;
  private maxPos = 1.4;
  private maxRot = 0.05;

  add(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Apply shake to the camera for this frame; call after controls.update(). */
  apply(camera: Camera, dt: number, offsetOut: Vector3) {
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    this.t += dt;
    const s = this.trauma * this.trauma;
    if (s <= 0.0001) {
      offsetOut.set(0, 0, 0);
      return;
    }
    // pseudo-noise from layered sines (smoother than pure random)
    const nx = Math.sin(this.t * 47.3) * Math.sin(this.t * 19.7);
    const ny = Math.sin(this.t * 53.1 + 1.3) * Math.sin(this.t * 23.2);
    const nz = Math.sin(this.t * 41.7 + 2.1) * Math.sin(this.t * 17.1);
    offsetOut.set(nx * this.maxPos * s, ny * this.maxPos * s, nz * this.maxPos * s);
    camera.position.add(offsetOut);
    camera.rotateZ(nz * this.maxRot * s);
  }

  get value() {
    return this.trauma;
  }
}
