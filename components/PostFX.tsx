'use client';

/**
 * PostFX stack (DESIGN §5). Order: AO -> TiltShift(signature) -> Bloom ->
 * color grade -> micro CA -> Vignette -> SMAA -> ACES tone map. Restraint is
 * the point (§7 Don't): high Bloom threshold, micro CA, warm-dark AO. Bloom
 * intensity is driven each frame from engine.bloom.value for the impact spike.
 */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
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
import { Vector2 } from 'three';
import type { Engine } from '@/lib/engine';
import type { QualityPreset } from '@/lib/quality';

export default function PostFX({
  engine,
  quality,
}: {
  engine: Engine;
  quality: QualityPreset;
}) {
  const bloomRef = useRef<BloomEffect>(null);

  useFrame(() => {
    if (bloomRef.current) {
      // spike on impact, lerp back toward the base level
      const target = engine.bloom.value;
      const cur = bloomRef.current.intensity;
      bloomRef.current.intensity = cur + (target - cur) * 0.35;
    }
  });

  return (
    <EffectComposer multisampling={0} enableNormalPass={quality.ao}>
      {quality.ao ? (
        <N8AO
          aoRadius={0.75}
          intensity={1.0}
          distanceFalloff={1.0}
          color="#2a2620"
          halfRes={quality.tier === 'low'}
        />
      ) : (
        <></>
      )}

      {quality.tiltShift ? (
        <TiltShift2 blur={0.25} taper={0.4} />
      ) : (
        <></>
      )}

      {quality.bloom ? (
        <Bloom
          ref={bloomRef}
          intensity={0.5}
          luminanceThreshold={0.85}
          luminanceSmoothing={0.12}
          mipmapBlur
          radius={0.6}
        />
      ) : (
        <></>
      )}

      <HueSaturation saturation={0.08} hue={0} />
      <BrightnessContrast brightness={0.0} contrast={0.05} />

      {quality.chromaticAberration ? (
        <ChromaticAberration offset={new Vector2(0.001, 0.001)} radialModulation={false} modulationOffset={0} />
      ) : (
        <></>
      )}

      {quality.vignette ? (
        <Vignette offset={0.35} darkness={0.5} />
      ) : (
        <></>
      )}

      <SMAA />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  );
}
