'use client';

/**
 * Aim preview (DESIGN §4-2): ground reticle + predicted crater rings (R1/R2) +
 * a thin vertical guide + a slowly-spinning ghost meteor. Restrained, technical
 * — no neon HUD. Reads a shared ref and updates imperatively (no React state on
 * pointer move). Color shifts cool over water.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Group,
  Mesh,
  IcosahedronGeometry,
  MeshBasicMaterial,
  Color,
  DoubleSide,
} from 'three';
import { resolveMeteor } from '@/lib/meteorPresets';
import { BRAND_EMBER } from '@/lib/constants';
import type { MeteorType, MeteorSize } from '@/lib/share';

export interface AimState {
  active: boolean;
  point: { x: number; y: number; z: number };
  overWater: boolean;
}

const GHOST_H = 46;
const WHITE = new Color('#ffffff');
const COOL = new Color('#9fd0de');
const EMBER = new Color(BRAND_EMBER);
const EMBER_SOFT = new Color('#f59a6e');

export default function AimReticle({
  aim,
  type,
  size,
}: {
  aim: RefObject<AimState>;
  type: MeteorType;
  size: MeteorSize;
}) {
  const groupRef = useRef<Group>(null);
  const reticleRef = useRef<Mesh>(null);
  const r1Ref = useRef<Mesh>(null);
  const r2Ref = useRef<Mesh>(null);
  const ghostRef = useRef<Mesh>(null);

  const resolved = useMemo(() => resolveMeteor(type, size), [type, size]);

  // rebuild ghost geometry sized to the meteor radius on type/size change
  const ghostGeo = useMemo(
    () => new IcosahedronGeometry(resolved.radius, 1),
    [resolved.radius],
  );

  useEffect(() => {
    if (r1Ref.current) r1Ref.current.scale.setScalar(resolved.R1);
    if (r2Ref.current) r2Ref.current.scale.setScalar(resolved.R2);
  }, [resolved]);

  useFrame((_, dt) => {
    const g = groupRef.current;
    const st = aim.current;
    if (!g || !st) return;
    if (!st.active) {
      g.visible = false;
      return;
    }
    g.visible = true;
    g.position.set(st.point.x, 0, st.point.z);
    const c = st.overWater ? COOL : WHITE;
    if (reticleRef.current)
      (reticleRef.current.material as MeshBasicMaterial).color.copy(c);
    if (r1Ref.current)
      (r1Ref.current.material as MeshBasicMaterial).color.copy(
        st.overWater ? COOL : EMBER,
      );
    if (ghostRef.current) ghostRef.current.rotation.y += dt * 0.8;
  });

  return (
    <group ref={groupRef} visible={false}>
      {/* reticle ring */}
      <mesh ref={reticleRef} rotation-x={-Math.PI / 2} position-y={0.16}>
        <ringGeometry args={[1.7, 2.1, 48]} />
        <meshBasicMaterial color={WHITE} transparent opacity={0.6} side={DoubleSide} depthWrite={false} />
      </mesh>
      {/* R1 predicted crater ring (ember) */}
      <mesh ref={r1Ref} rotation-x={-Math.PI / 2} position-y={0.15}>
        <ringGeometry args={[0.965, 1.0, 64]} />
        <meshBasicMaterial color={EMBER} transparent opacity={0.35} side={DoubleSide} depthWrite={false} />
      </mesh>
      {/* R2 blast ring (soft ember) */}
      <mesh ref={r2Ref} rotation-x={-Math.PI / 2} position-y={0.15}>
        <ringGeometry args={[0.985, 1.0, 72]} />
        <meshBasicMaterial color={EMBER_SOFT} transparent opacity={0.22} side={DoubleSide} depthWrite={false} />
      </mesh>
      {/* faint vertical guide */}
      <mesh position-y={GHOST_H / 2}>
        <cylinderGeometry args={[0.05, 0.05, GHOST_H, 6]} />
        <meshBasicMaterial color={WHITE} transparent opacity={0.18} depthWrite={false} />
      </mesh>
      {/* ghost meteor */}
      <mesh ref={ghostRef} geometry={ghostGeo} position-y={GHOST_H}>
        <meshBasicMaterial
          color={new Color(resolved.preset.bodyColor)}
          transparent
          opacity={0.3}
          wireframe={false}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
