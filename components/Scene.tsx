'use client';

/**
 * The R3F Canvas + everything React manages (DESIGN §3 lighting / §5 PostFX).
 * The imperative Engine (debris/fx/physics) is mounted as a single <primitive>
 * so its hundreds of pieces never touch the reconciler. Pointer picking drives
 * the aim ref + click-to-drop (click vs drag separated by movement threshold).
 */
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Environment, Lightformer, MeshReflectorMaterial } from '@react-three/drei';
import {
  NoToneMapping,
  BackSide,
  Color,
  DoubleSide,
  ShaderMaterial,
  Vector3,
  type Mesh,
} from 'three';
import EngineRunner from './EngineRunner';
import PostFX from './PostFX';
import AimReticle, { type AimState } from './AimReticle';
import type { Engine } from '@/lib/engine';
import type { QualityPreset } from '@/lib/quality';
import type { CityModel } from '@/lib/city/cityTypes';
import { isOverWater } from '@/lib/city/cityTypes';
import {
  SUN_DIR,
  SUN_COLOR,
  SUN_INTENSITY,
  HEMI_SKY,
  HEMI_GROUND,
  HEMI_INTENSITY,
  ENV_INTENSITY,
  SKY_TOP,
  SKY_HORIZON,
  FOG_COLOR,
  WATER_BODY,
} from '@/lib/constants';
import type { MeteorType, MeteorSize } from '@/lib/share';

// ---------- gradient studio backdrop (DESIGN §3, no dramatic sky) ----------
function GradientSky({ radius }: { radius: number }) {
  const mat = useMemo(() => {
    return new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new Color(SKY_TOP) },
        horizon: { value: new Color(SKY_HORIZON) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 top; uniform vec3 horizon;
        void main(){
          float t = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 c = mix(horizon, top, smoothstep(0.35, 0.85, t));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
  }, []);
  return (
    <mesh scale={radius * 4} renderOrder={-1}>
      <sphereGeometry args={[1, 24, 16]} />
      <primitive object={mat} attach="material" />
    </mesh>
  );
}

// ---------- scene lighting + fog + shadow-frustum fit ----------
function SceneSetup({ radius }: { radius: number }) {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.environmentIntensity = ENV_INTENSITY;
  }, [scene]);

  const sun = new Vector3(...SUN_DIR).normalize().multiplyScalar(radius * 2.2);
  const shadowExtent = radius * 1.15;
  return (
    <>
      <fog attach="fog" args={[FOG_COLOR, radius * 1.3, radius * 3.2]} />
      <hemisphereLight args={[HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY]} />
      <directionalLight
        position={[sun.x, sun.y, sun.z]}
        intensity={SUN_INTENSITY}
        color={SUN_COLOR}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-radius={3.5}
        shadow-bias={-0.0003}
        shadow-normalBias={0.02}
        shadow-camera-near={1}
        shadow-camera-far={radius * 5}
        shadow-camera-left={-shadowExtent}
        shadow-camera-right={shadowExtent}
        shadow-camera-top={shadowExtent}
        shadow-camera-bottom={-shadowExtent}
      />
      <Environment resolution={64}>
        <Lightformer form="rect" intensity={1.1} position={[0, radius, -radius]} scale={[radius * 2, radius, 1]} color="#e7eef2" />
        <Lightformer form="rect" intensity={1.6} position={[radius, radius, radius * 0.5]} scale={[radius, radius, 1]} color="#fff2df" />
        <Lightformer form="rect" intensity={0.6} position={[-radius, radius * 0.7, radius]} scale={[radius, radius, 1]} color="#d9e6ee" />
      </Environment>
    </>
  );
}

// ---------- water (DESIGN §2) ----------
function Water({ model, quality }: { model: CityModel; quality: QualityPreset }) {
  if (model.water.length === 0) return null;

  const sameZ = model.water.every((w) => Math.abs(w.z - model.water[0].z) < 0.01);
  const sameX = model.water.every((w) => Math.abs(w.x - model.water[0].x) < 0.01);
  const straight = sameZ || sameX;

  if (straight && quality.tier === 'high') {
    // one reflector plane over the river bbox — the miniature "jewel"
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const w of model.water) {
      minX = Math.min(minX, w.x - w.w / 2);
      maxX = Math.max(maxX, w.x + w.w / 2);
      minZ = Math.min(minZ, w.z - w.d / 2);
      maxZ = Math.max(maxZ, w.z + w.d / 2);
    }
    return (
      <mesh rotation-x={-Math.PI / 2} position={[(minX + maxX) / 2, 0.06, (minZ + maxZ) / 2]}>
        <planeGeometry args={[maxX - minX, maxZ - minZ]} />
        <MeshReflectorMaterial
          color="#2e4a54"
          roughness={0.08}
          metalness={0}
          blur={[200, 60]}
          mixStrength={0.55}
          depthScale={6}
          minDepthThreshold={0.9}
          resolution={512}
          mirror={0.6}
        />
      </mesh>
    );
  }

  // fallback: cheap glossy planes (env-reflection), one per cell — robust on L rivers / low tier
  return (
    <group>
      {model.water.map((w, i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[w.x, 0.06, w.z]}>
          <planeGeometry args={[w.w, w.d]} />
          <meshStandardMaterial color={new Color(WATER_BODY)} roughness={0.12} metalness={0} envMapIntensity={1} />
        </mesh>
      ))}
    </group>
  );
}

// ---------- pointer picking plane + click-to-drop ----------
function Ground({
  model,
  engine,
  aim,
  settingsRef,
  onDrop,
}: {
  model: CityModel;
  engine: Engine;
  aim: MutableRefObject<AimState>;
  settingsRef: MutableRefObject<{ type: MeteorType; size: MeteorSize }>;
  onDrop: () => void;
}) {
  const planeRef = useRef<Mesh>(null);
  const down = useRef<{ x: number; y: number; t: number; button: number }>({
    x: 0,
    y: 0,
    t: 0,
    button: -1,
  });
  const size = model.span + 80;

  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      const d = down.current;
      down.current = { x: 0, y: 0, t: 0, button: -1 };
      if (d.button !== 0) return;
      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      const dt = performance.now() - d.t;
      if (dist > 7 || dt > 600) return; // it was a drag, not a click
      if (!aim.current.active) return;
      const p = aim.current.point;
      const s = settingsRef.current;
      engine.dropMeteor(new Vector3(p.x, 0.3, p.z), s.type, s.size);
      onDrop();
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, [engine, aim, settingsRef, onDrop]);

  return (
    <mesh
      ref={planeRef}
      rotation-x={-Math.PI / 2}
      position-y={0.02}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => {
        aim.current.active = true;
        aim.current.point.x = e.point.x;
        aim.current.point.y = e.point.y;
        aim.current.point.z = e.point.z;
        aim.current.overWater = isOverWater(model, e.point.x, e.point.z);
      }}
      onPointerOut={() => {
        aim.current.active = false;
      }}
      onPointerDown={(e: ThreeEvent<PointerEvent>) => {
        down.current = {
          x: e.nativeEvent.clientX,
          y: e.nativeEvent.clientY,
          t: performance.now(),
          button: e.nativeEvent.button,
        };
      }}
    >
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial colorWrite={false} depthWrite={false} side={DoubleSide} />
    </mesh>
  );
}

export default function Scene({
  engine,
  model,
  quality,
  type,
  size,
  settingsRef,
  onDrop,
}: {
  engine: Engine;
  model: CityModel;
  quality: QualityPreset;
  type: MeteorType;
  size: MeteorSize;
  settingsRef: MutableRefObject<{ type: MeteorType; size: MeteorSize }>;
  onDrop: () => void;
}) {
  const aim = useRef<AimState>({
    active: false,
    point: { x: 0, y: 0, z: 0 },
    overWater: false,
  });
  const radius = model.radius;

  return (
    <Canvas
      shadows
      dpr={quality.dpr}
      gl={{
        antialias: false,
        toneMapping: NoToneMapping, // ACES applied by the ToneMapping effect
        powerPreference: 'high-performance',
      }}
      camera={{
        position: [radius * 1.15, radius * 0.95, radius * 1.15],
        fov: 30,
        near: 1,
        far: radius * 8,
      }}
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }}
    >
      <SceneSetup radius={radius} />
      <GradientSky radius={radius} />

      {/* imperative engine content (city + debris + fx) — one primitive */}
      <primitive object={engine.root} />

      <Water model={model} quality={quality} />
      <Ground
        model={model}
        engine={engine}
        aim={aim}
        settingsRef={settingsRef}
        onDrop={onDrop}
      />
      <AimReticle aim={aim} type={type} size={size} />

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={radius * 0.4}
        maxDistance={radius * 2.6}
        maxPolarAngle={1.3}
        minPolarAngle={0.15}
        target={[0, 4, 0]}
      />

      <EngineRunner engine={engine} />
      <PostFX engine={engine} quality={quality} />
    </Canvas>
  );
}
