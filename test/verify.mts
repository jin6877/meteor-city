/**
 * Headless unit checks for the invariants the contract calls out:
 *  1. city generation is deterministic (same seed -> identical city)
 *  2. seed / type / size URL parsing is validated (hostile input rejected)
 *  3. the debris pool never exceeds its global cap under sustained spawning
 *
 * Run: npx esbuild test/verify.mts --bundle --platform=node --format=cjs \
 *        --outfile=.verify.cjs && node .verify.cjs
 * (three's InstancedMesh is CPU-only here; Rapier -compat inlines its WASM.)
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { generateCity } from '../lib/city/generateCity';
import { parseSeed, readShareState, isMeteorType, isMeteorSize } from '../lib/share';
import { makeWorld } from '../lib/physics/world';
import { DebrisSystem } from '../lib/physics/debrisPool';
import { Vector3 } from 'three';

let failures = 0;
function ok(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
}

// ---- 1. determinism ----
function determinism() {
  const a = JSON.stringify(generateCity(12345));
  const b = JSON.stringify(generateCity(12345));
  const c = JSON.stringify(generateCity(12346));
  ok('same seed -> identical city', a === b);
  ok('different seed -> different city', a !== c);
  // stable across a range
  let stable = true;
  for (const s of [0, 1, 777, 2 ** 31 - 1]) {
    if (JSON.stringify(generateCity(s)) !== JSON.stringify(generateCity(s))) stable = false;
  }
  ok('deterministic across seed range', stable);
}

// ---- 2. seed / share parsing ----
function parsing() {
  ok('parseSeed digits', parseSeed('123') === 123);
  ok('parseSeed trims', parseSeed('  42 ') === 42);
  ok('parseSeed abs', parseSeed('-5') === 5);
  ok('parseSeed rejects letters', parseSeed('abc') === null);
  ok('parseSeed rejects overlong', parseSeed('123456789012345') === null);
  ok('parseSeed rejects empty', parseSeed('') === null);
  ok('parseSeed rejects null', parseSeed(null) === null);
  ok('type whitelist', isMeteorType('rocky') && !isMeteorType('nuke'));
  ok('size whitelist', isMeteorSize('L') && !isMeteorSize('XL'));

  const fb = { seed: 999, type: 'rocky' as const, size: 'M' as const };
  const good = readShareState(new URLSearchParams('seed=42&type=comet&size=L'), fb);
  ok('readShareState valid', good.state.seed === 42 && good.state.type === 'comet' && good.state.size === 'L' && !good.seedWasInvalid);
  const bad = readShareState(new URLSearchParams('seed=%3Cscript%3E&type=evil'), fb);
  ok('readShareState hostile -> fallback + flag', bad.state.seed === 999 && bad.state.type === 'rocky' && bad.seedWasInvalid);
}

// ---- 3. debris cap ----
async function cap() {
  await RAPIER.init();
  const world = makeWorld();
  const ACTIVE = 50;
  const RUBBLE = 400;
  const debris = new DebrisSystem(world, {
    activeCap: ACTIVE,
    rubbleCap: RUBBLE,
    castShadow: false,
  });
  const impact = new Vector3(0, 0, 0);
  let maxActive = 0;
  // sustained voxel-chunking: far more chunks than the active cap. Over-cap
  // chunks are force-baked into static rubble (residue), so active bodies stay
  // bounded while rubble accumulates.
  for (let i = 0; i < 30; i++) {
    debris.fractureBuilding([i * 10, 0, 0], [8, 40, 8], 0x888888, impact, 1.0, 0xc24a20, 0.3, 20);
    world.step();
    debris.update(i * 0.05);
    maxActive = Math.max(maxActive, debris.count);
  }
  ok('active debris never exceeds activeCap', debris.count <= ACTIVE && maxActive <= ACTIVE, `max=${maxActive} cap=${ACTIVE}`);
  ok('active pool actually fills', maxActive >= ACTIVE * 0.6, `max=${maxActive}`);
  ok('rubble accumulates (persistent residue)', debris.rubble > 0, `rubble=${debris.rubble}`);
  ok('rubble bounded by rubbleCap', debris.rubble <= RUBBLE, `rubble=${debris.rubble}`);

  debris.reset();
  ok('reset clears active', debris.count === 0);
  ok('reset clears rubble', debris.rubble === 0);
}

(async () => {
  determinism();
  parsing();
  await cap();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
