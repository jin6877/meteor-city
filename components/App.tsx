'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Vector3 } from 'three';
import Scene from './Scene';
import HUD from './HUD';
import Loading from './Loading';
import ErrorFallback from './ErrorFallback';
import { Engine } from '@/lib/engine';
import { detectQuality, type Tier } from '@/lib/quality';
import { generateCity } from '@/lib/city/generateCity';
import { buildCityMeshes } from '@/lib/city/buildCityMeshes';
import type { CityModel } from '@/lib/city/cityTypes';
import {
  readShareState,
  buildShareUrl,
  randomSeed,
  isMeteorType,
  isMeteorSize,
  type MeteorType,
  type MeteorSize,
} from '@/lib/share';

type Phase = 'loading' | 'ready' | 'error';

function webglOk(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function savePref(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [progress, setProgress] = useState(0.05);
  const [loadLabel, setLoadLabel] = useState('운석 궤도 계산 중…');
  const [errorDetail, setErrorDetail] = useState<string | undefined>();

  const [seed, setSeed] = useState<number>(1);
  const [type, setType] = useState<MeteorType>('rocky');
  const [size, setSize] = useState<MeteorSize>('M');
  const [resetKey, setResetKey] = useState(0);
  const [model, setModel] = useState<CityModel | null>(null);

  const [toast, setToast] = useState<string | null>(null);
  const [hint, setHint] = useState(true);
  const [hudHidden, setHudHidden] = useState(false);
  const [hudDim, setHudDim] = useState(false);
  const [slomo, setSlomo] = useState(false);

  const engineRef = useRef<Engine | null>(null);
  const settingsRef = useRef<{ type: MeteorType; size: MeteorSize }>({ type, size });
  const seedRef = useRef<number>(1);
  const toastTimer = useRef<number>(0);
  const quality = useMemo(() => {
    const forced = (loadPref('mc:tier') as Tier | null) ?? undefined;
    return detectQuality(forced === 'high' || forced === 'low' ? forced : undefined);
  }, []);

  // keep the drop-handler's snapshot of type/size/seed current without mutating during render
  useEffect(() => {
    settingsRef.current = { type, size };
  }, [type, size]);
  useEffect(() => {
    seedRef.current = seed;
  }, [seed]);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // ---- one-time init: read share URL, boot engine ----
  useEffect(() => {
    let cancelled = false;
    if (!webglOk()) {
      setErrorDetail('WebGL 컨텍스트를 만들 수 없어요.');
      setPhase('error');
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const prefType = loadPref('mc:type');
    const prefSize = loadPref('mc:size');
    const fallback = {
      seed: randomSeed(),
      type: (isMeteorType(prefType) ? prefType : 'rocky') as MeteorType,
      size: (isMeteorSize(prefSize) ? prefSize : 'M') as MeteorSize,
    };
    const { state, seedWasInvalid } = readShareState(params, fallback);
    setSeed(state.seed);
    setType(state.type);
    setSize(state.size);

    const engine = new Engine(quality);
    engineRef.current = engine;

    (async () => {
      try {
        setProgress(0.2);
        setLoadLabel('물리 엔진 깨우는 중…');
        await engine.init();
        if (cancelled) return;
        setProgress(0.75);
        setLoadLabel('도시 짓는 중…');
        // first city built by the seed effect once phase === 'ready'
        setPhase('ready');
        if (seedWasInvalid) {
          flashToast('링크가 깨졌어요 — 새 도시를 지었어요.');
        }
      } catch (e) {
        if (cancelled) return;
        setErrorDetail(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- (re)build the city on seed / reset changes ----
  useEffect(() => {
    const engine = engineRef.current;
    if (phase !== 'ready' || !engine) return;
    const m = generateCity(seed);
    const build = buildCityMeshes(m, quality.treeFactor);
    engine.setCity(m, build);
    setModel(m);
    setProgress(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, resetKey, phase]);

  // ---- persist prefs + keep URL query in sync (shareable, reproducible) ----
  useEffect(() => {
    if (phase !== 'ready') return;
    savePref('mc:type', type);
    savePref('mc:size', size);
    const url = buildShareUrl(window.location.origin, window.location.pathname, {
      seed,
      type,
      size,
    });
    window.history.replaceState(null, '', url);
  }, [seed, type, size, phase]);

  // ---- debug hook for automated verification (set once, reads live state) ----
  useEffect(() => {
    if (phase !== 'ready') return;
    const w = window as unknown as Record<string, unknown>;
    w.__meteor = {
      ready: () => (engineRef.current?.getStats().buildingsAlive ?? 0) > 0,
      stats: () => engineRef.current?.getStats(),
      agentPos: () => engineRef.current?.agentSample() ?? null,
      lastImpact: () => engineRef.current?.lastImpactPoint ?? null,
      seed: () => seedRef.current,
      drop: (x: number, z: number) => {
        const s = settingsRef.current;
        engineRef.current?.dropMeteor(new Vector3(x, 0.3, z), s.type, s.size);
      },
      setSlomo: (on: boolean) => engineRef.current?.toggleSlomo(on),
    };
    return () => {
      if (w.__meteor) delete w.__meteor;
    };
  }, [phase]);

  // ---- HUD idle auto-fade (keep capture clean, DESIGN §6) ----
  useEffect(() => {
    let t: number;
    const wake = () => {
      setHudDim(false);
      window.clearTimeout(t);
      t = window.setTimeout(() => setHudDim(true), 2800);
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    wake();
    return () => {
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.clearTimeout(t);
    };
  }, []);

  // ---- handlers ----
  const onDrop = useCallback(() => {
    if (hint) setHint(false);
  }, [hint]);

  const regenerate = useCallback(() => {
    setSeed(randomSeed());
    setHint(false);
  }, []);
  const reset = useCallback(() => {
    setResetKey((k) => k + 1);
  }, []);
  const toggleSlomo = useCallback(
    (on: boolean) => {
      setSlomo(on);
      engineRef.current?.toggleSlomo(on);
    },
    [],
  );
  const share = useCallback(async () => {
    const url = buildShareUrl(window.location.origin, window.location.pathname, {
      seed,
      type,
      size,
    });
    try {
      await navigator.clipboard.writeText(url);
      flashToast('이 도시, 친구한테 던져보세요 — 링크 복사됨.');
    } catch {
      flashToast(url);
    }
  }, [seed, type, size, flashToast]);

  if (phase === 'error') return <ErrorFallback detail={errorDetail} />;

  return (
    <>
      {engineRef.current && model ? (
        <Scene
          engine={engineRef.current}
          model={model}
          quality={quality}
          type={type}
          size={size}
          settingsRef={settingsRef}
          onDrop={onDrop}
        />
      ) : null}

      {phase === 'loading' || !model ? (
        <Loading progress={progress} label={loadLabel} />
      ) : null}

      {phase === 'ready' && model ? (
        <HUD
          type={type}
          size={size}
          slomo={slomo}
          hidden={hudHidden}
          dim={hudDim}
          seed={seed}
          onType={setType}
          onSize={setSize}
          onSlomo={toggleSlomo}
          onRegenerate={regenerate}
          onReset={reset}
          onShare={share}
          onToggleHud={() => setHudHidden((v) => !v)}
        />
      ) : null}

      {hint && phase === 'ready' && model && !hudHidden ? (
        <div className="pointer-events-none fixed left-1/2 top-6 z-30 -translate-x-1/2 rounded-full bg-[#1c1f26]/85 px-4 py-1.5 text-sm text-[#f2eee6] shadow-lg backdrop-blur-sm">
          도시를 클릭해 떨어뜨리세요
        </div>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-28 left-1/2 z-40 -translate-x-1/2 rounded-xl bg-[#1c1f26]/95 px-4 py-2 text-sm text-[#f2eee6] shadow-lg">
          {toast}
        </div>
      ) : null}
    </>
  );
}
