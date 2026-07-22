'use client';

/**
 * PostFX stack (DESIGN §5), retuned to kill the washed-out look:
 *   AO -> TiltShift2 -> ToneMapping(ACES) -> Bloom -> grade -> CA -> Vignette -> SMAA
 *
 * Key fixes:
 *  - TiltShift2 makes a HORIZONTAL sharp band (start/end define a horizontal
 *    line) instead of the default vertical band, with a gentle taper. Its blur
 *    is driven by zoom: subtle up close, ~off when zoomed out (the miniature
 *    illusion only reads near). The city body stays sharp.
 *  - Bloom runs AFTER tone mapping, i.e. on [0,1] color with a high threshold,
 *    so only the impact flash / bright emissives bloom — not the daytime city.
 *  - Softer Vignette so zoomed-out corners don't read as black.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useMemo, useRef } from 'react';
import {
  EffectComposer,
  Bloom,
  N8AO,
  TiltShift2,
  HueSaturation,
  BrightnessContrast,
  ChromaticAberration,
  Vignette,
  SMAA,
  ToneMapping,
} from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import type { BloomEffect } from 'postprocessing';
import { Vector2, Vector3 } from 'three';
import type { Engine } from '@/lib/engine';
import type { QualityPreset } from '@/lib/quality';

// horizontal focus line (sharp band across screen mid, blur above/below)
const TILT_START: [number, number] = [0.0, 0.55];
const TILT_END: [number, number] = [1.0, 0.55];

type UniformHolder = { uniforms: Map<string, { value: number }> };

export default function PostFX({
  engine,
  quality,
  radius,
}: {
  engine: Engine;
  quality: QualityPreset;
  radius: number;
}) {
  const camera = useThree((s) => s.camera);
  const bloomRef = useRef<BloomEffect | null>(null);
  const tiltRef = useRef<UniformHolder | null>(null);

  // callback refs (functions are omitted by the lib's JSON.stringify memo key)
  const setBloom = useCallback((e: BloomEffect | null) => {
    bloomRef.current = e;
  }, []);
  const setTilt = useCallback((e: unknown) => {
    tiltRef.current = (e as UniformHolder | null) ?? null;
  }, []);

  const target = useMemo(() => new Vector3(0, 4, 0), []);

  useFrame(() => {
    if (bloomRef.current) {
      const t = engine.bloom.value;
      const cur = bloomRef.current.intensity;
      bloomRef.current.intensity = cur + (t - cur) * 0.35;
    }
    if (tiltRef.current) {
      // zoom-linked blur: full up close, ~0 when zoomed out
      const dist = camera.position.distanceTo(target);
      const near = radius * 0.6;
      const far = radius * 1.85;
      const k = Math.min(1, Math.max(0, (dist - near) / (far - near)));
      const eased = k * k * (3 - 2 * k); // smoothstep
      const blur = 0.13 * (1 - eased) + 0.015 * eased;
      const u = tiltRef.current.uniforms.get('blur');
      if (u) u.value = blur;
    }
  });

  return (
    <EffectComposer multisampling={0} enableNormalPass={quality.ao}>
      {quality.ao ? (
        <N8AO
          aoRadius={0.7}
          intensity={1.0}
          distanceFalloff={1.0}
          color="#2a2620"
          halfRes={quality.tier === 'low'}
        />
      ) : (
        <></>
      )}

      {quality.tiltShift ? (
        <TiltShift2
          ref={setTilt}
          blur={0.1}
          taper={0.9}
          start={TILT_START}
          end={TILT_END}
          samples={12}
        />
      ) : (
        <></>
      )}

      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />

      {quality.bloom ? (
        <Bloom
          ref={setBloom}
          intensity={0.28}
          luminanceThreshold={0.9}
          luminanceSmoothing={0.08}
          mipmapBlur
          radius={0.5}
        />
      ) : (
        <></>
      )}

      <HueSaturation saturation={0.08} hue={0} />
      <BrightnessContrast brightness={0.0} contrast={0.05} />

      {quality.chromaticAberration ? (
        <ChromaticAberration
          offset={new Vector2(0.0009, 0.0009)}
          radialModulation={false}
          modulationOffset={0}
        />
      ) : (
        <></>
      )}

      {quality.vignette ? <Vignette offset={0.4} darkness={0.32} /> : <></>}

      <SMAA />
    </EffectComposer>
  );
}
