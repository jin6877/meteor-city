/* eslint-disable */
/**
 * Headless browser smoke test (system Chrome + software WebGL/SwiftShader).
 * Verifies end-to-end: app loads (WASM init), city renders with no page errors,
 * click-drop causes destruction (debris up / buildings down), debris stays
 * capped under sustained drops, and the same seed reproduces the same city.
 *
 * Run: node test/smoke.cjs   (needs the prod server running; PORT via SMOKE_PORT)
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const PORT = process.env.SMOKE_PORT || '3147';
const BASE = `http://localhost:${PORT}`;
const OUT =
  process.env.SMOKE_OUT ||
  'C:/Users/jin68/AppData/Local/Temp/claude/c--dev-project-side-app/ca750ade-268c-4251-82ca-f03bab9bbc54/scratchpad';
const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--window-size=1280,800',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  const waitReady = async () => {
    await page.waitForFunction(
      'window.__meteor && window.__meteor.ready && window.__meteor.ready()',
      { timeout: 45000, polling: 400 },
    );
  };

  // ---------- Phase A: load + render + drop ----------
  await page.goto(`${BASE}/?seed=12345&type=rocky&size=M`, {
    waitUntil: 'domcontentloaded',
  });
  await waitReady();
  ok('app becomes ready (WASM + city built)', true);

  const renderer = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  console.log('      GPU renderer:', renderer);

  await sleep(800);
  const stats0 = await page.evaluate(() => window.__meteor.stats());
  console.log('      stats0:', JSON.stringify(stats0));
  ok('city rendered (buildings > 0)', stats0.buildingsAlive > 0, `alive=${stats0.buildingsAlive}`);
  await page.screenshot({ path: path.join(OUT, 'mc-city.png') });

  // drop a few rocky meteors near center. NOTE: software WebGL (SwiftShader)
  // runs at a few fps and the engine clamps per-frame sim time (anti spiral of
  // death), so meteors take many wall-clock seconds to land here. Poll for the
  // impact instead of assuming a fixed delay.
  for (const [x, z] of [[0, 0], [20, -10], [-15, 15]]) {
    await page.evaluate((x, z) => window.__meteor.drop(x, z), x, z);
    await sleep(500);
  }
  let stats1 = stats0;
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    stats1 = await page.evaluate(() => window.__meteor.stats());
    if (stats1.debris > 0 && stats1.buildingsAlive < stats0.buildingsAlive) break;
  }
  console.log('      stats1:', JSON.stringify(stats1));
  ok('drop produced debris', stats1.debris > 0, `debris=${stats1.debris}`);
  ok('drop destroyed buildings', stats1.buildingsAlive < stats0.buildingsAlive, `${stats0.buildingsAlive} -> ${stats1.buildingsAlive}`);
  await page.screenshot({ path: path.join(OUT, 'mc-impact.png') });

  // ---------- Phase B: seed reproducibility ----------
  await page.goto(`${BASE}/?seed=12345&type=rocky&size=M`, {
    waitUntil: 'domcontentloaded',
  });
  await waitReady();
  await sleep(600);
  const statsB = await page.evaluate(() => window.__meteor.stats());
  ok(
    'same seed reproduces same city',
    statsB.buildingsAlive === stats0.buildingsAlive,
    `${stats0.buildingsAlive} vs ${statsB.buildingsAlive}`,
  );

  const statsDiffSeed = await (async () => {
    await page.goto(`${BASE}/?seed=424242&type=rocky&size=M`, {
      waitUntil: 'domcontentloaded',
    });
    await waitReady();
    await sleep(500);
    return page.evaluate(() => window.__meteor.stats());
  })();
  ok(
    'different seed -> different city',
    statsDiffSeed.buildingsAlive !== stats0.buildingsAlive,
    `${stats0.buildingsAlive} vs ${statsDiffSeed.buildingsAlive}`,
  );

  // ---------- Phase C: cap holds under sustained comet-L drops ----------
  await page.goto(`${BASE}/?seed=999&type=comet&size=L`, {
    waitUntil: 'domcontentloaded',
  });
  await waitReady();
  await sleep(500);
  const statsC0 = await page.evaluate(() => window.__meteor.stats());
  let capMax = 0;
  for (let i = 0; i < 22; i++) {
    const x = ((i * 37) % 200) - 100;
    const z = ((i * 53) % 200) - 100;
    await page.evaluate((x, z) => window.__meteor.drop(x, z), x, z);
    await sleep(700);
    const s = await page.evaluate(() => window.__meteor.stats());
    capMax = Math.max(capMax, s.debris);
  }
  await sleep(3000);
  const statsCap = await page.evaluate(() => window.__meteor.stats());
  console.log('      cap phase max debris:', capMax, 'final:', statsCap.debris, 'buildings', statsC0.buildingsAlive, '->', statsCap.buildingsAlive);
  ok('debris stayed bounded under sustained drops', capMax > 0 && capMax <= 300, `max=${capMax}`);
  ok('sustained drops destroyed buildings', statsCap.buildingsAlive < statsC0.buildingsAlive, `${statsC0.buildingsAlive} -> ${statsCap.buildingsAlive}`);
  ok('sustained drops still running (not crashed)', statsCap.ready === true);
  await page.screenshot({ path: path.join(OUT, 'mc-cap.png') });

  // ---------- error report ----------
  const benignConsole = consoleErrors.filter(
    (t) => !/pretendard|font|favicon|Failed to load resource/i.test(t),
  );
  console.log('      pageErrors:', pageErrors.length, 'consoleErrors(non-benign):', benignConsole.length);
  if (pageErrors.length) console.log('        ', pageErrors.slice(0, 5).join('\n         '));
  if (benignConsole.length) console.log('        ', benignConsole.slice(0, 5).join('\n         '));
  ok('no uncaught page errors', pageErrors.length === 0);
  ok('no non-benign console errors', benignConsole.length === 0);

  await browser.close();
  console.log(failures === 0 ? '\nSMOKE: ALL PASS' : `\nSMOKE: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE CRASHED:', e);
  process.exit(2);
});
