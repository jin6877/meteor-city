'use client';

import { useFrame, useThree } from '@react-three/fiber';
import type { Engine } from '@/lib/engine';

/**
 * Drives the imperative Engine once per rendered frame. Priority 1 makes this
 * run AFTER drei's OrbitControls (priority 0) so camera shake, applied to the
 * camera here, isn't immediately overwritten by controls this frame.
 */
export default function EngineRunner({ engine }: { engine: Engine }) {
  const camera = useThree((s) => s.camera);
  useFrame((_, delta) => {
    engine.update(delta, camera);
  }, 1);
  return null;
}
