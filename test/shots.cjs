/* eslint-disable */
// Capture default + max-zoom + post-impact screenshots and confirm agents move.
const puppeteer = require('puppeteer-core');
const path = require('path');
const PORT = process.env.SMOKE_PORT || '3151';
const OUT = 'C:/Users/jin68/AppData/Local/Temp/claude/c--dev-project-side-app/ca750ade-268c-4251-82ca-f03bab9bbc54/scratchpad';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1360,860'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1360, height: 860, deviceScaleFactor: 1 });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.goto(`http://localhost:${PORT}/?seed=12345&type=rocky&size=M`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('window.__meteor && window.__meteor.ready && window.__meteor.ready()', { timeout: 60000, polling: 400 });
  await sleep(1500);
  await p.screenshot({ path: path.join(OUT, 'mc2-default.png') });

  // agents move?
  const a0 = await p.evaluate(() => window.__meteor.agentPos());
  await sleep(1600);
  const a1 = await p.evaluate(() => window.__meteor.agentPos());
  const moved = a0 && a1 && (Math.abs(a0[0]-a1[0]) + Math.abs(a0[1]-a1[1])) > 0.5;
  console.log('agent car pos', JSON.stringify(a0), '->', JSON.stringify(a1), 'MOVED=' + moved);

  // zoom OUT to max (few big wheel steps)
  const canvas = await p.$('canvas');
  const box = await canvas.boundingBox();
  await p.mouse.move(box.x + box.width/2, box.y + box.height/2);
  for (let i = 0; i < 16; i++) { await p.mouse.wheel({ deltaY: 500 }); await sleep(60); }
  await sleep(1600);
  await p.screenshot({ path: path.join(OUT, 'mc2-zoomout.png') });

  // zoom back in, drop a big comet, wait for fracture, screenshot
  for (let i = 0; i < 20; i++) { await p.mouse.wheel({ deltaY: -500 }); await sleep(50); }
  await p.goto(`http://localhost:${PORT}/?seed=12345&type=comet&size=L`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('window.__meteor && window.__meteor.ready && window.__meteor.ready()', { timeout: 60000, polling: 400 });
  await sleep(1000);
  for (const [x,z] of [[0,0],[-20,15],[25,-10]]) { await p.evaluate((x,z)=>window.__meteor.drop(x,z), x, z); await sleep(400); }
  let st;
  for (let i=0;i<40;i++){ await sleep(600); st = await p.evaluate(()=>window.__meteor.stats()); if (st.debris>20) break; }
  console.log('impact stats', JSON.stringify(st));
  await p.screenshot({ path: path.join(OUT, 'mc2-impact.png') });

  console.log('pageErrors:', errs.length, errs.slice(0,3).join(' | '));
  await b.close();
})().catch(e => { console.error('SHOTS CRASHED', e); process.exit(2); });
