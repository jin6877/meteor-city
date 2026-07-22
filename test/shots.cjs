/* eslint-disable */
// Reality-pass verification: blue windows, chunky rubble (no slivers), rubble
// stays, meteor embedded, building-top burst at contact height, trees felled.
const puppeteer = require('puppeteer-core');
const path = require('path');
const PORT = process.env.SMOKE_PORT || '3153';
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
  await p.goto(`http://localhost:${PORT}/?seed=12345&type=rocky&size=L`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('window.__meteor && window.__meteor.ready && window.__meteor.ready()', { timeout: 60000, polling: 400 });
  await sleep(1500);
  await p.screenshot({ path: path.join(OUT, 'mc3-default.png') });
  const before = await p.evaluate(() => window.__meteor.stats());
  console.log('before:', JSON.stringify(before));

  // drop several onto downtown (near origin => tall towers); record the highest
  // contact point to prove building-top bursts fire up high (item 5).
  let maxImpactY = 0;
  const spots = [[0,0],[12,-8],[-10,10],[8,14],[-14,-6]];
  for (const [x,z] of spots) {
    await p.evaluate((x,z)=>window.__meteor.drop(x,z), x, z);
    await sleep(400);
  }
  let st;
  for (let i=0;i<50;i++){
    await sleep(600);
    st = await p.evaluate(()=>window.__meteor.stats());
    const li = await p.evaluate(()=>window.__meteor.lastImpact());
    if (li) maxImpactY = Math.max(maxImpactY, li[1]);
    if (st.rubble > 40 && st.debris < st.rubble) break;
  }
  console.log('after impacts:', JSON.stringify(st));
  console.log('max contact height (item5):', maxImpactY.toFixed(1));

  // let everything settle so any slivers would be obvious and rubble bakes
  // (SwiftShader sim is slow, so wait generously)
  await sleep(9000);
  const settled = await p.evaluate(()=>window.__meteor.stats());
  console.log('settled:', JSON.stringify(settled));

  // zoom in toward the crater for chunky-rubble / embedded-meteor detail
  const canvas = await p.$('canvas');
  const box = await canvas.boundingBox();
  await p.mouse.move(box.x + box.width/2, box.y + box.height/2);
  for (let i=0;i<10;i++){ await p.mouse.wheel({ deltaY: -420 }); await sleep(50); }
  await sleep(1200);
  await p.screenshot({ path: path.join(OUT, 'mc3-after.png') });

  console.log('pageErrors:', errs.length, errs.slice(0,3).join(' | '));
  await b.close();
})().catch(e => { console.error('SHOTS CRASHED', e); process.exit(2); });
