// SPDX-License-Identifier: GPL-2.0-or-later
//
// Browser test for BlendEngine film features: sequencer camera cuts, film end
// screen and the offline PNG/ZIP film render.
//
//   blender --background --python tests/runtime_web/export_templates.py -- /tmp/be film
//   node tests/runtime_web/film_test.js /tmp/be/film/web_player [frames.zip]
const { chromium } = require('playwright');
const fs = require('fs');
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
(async () => {
  const dir = process.argv[2];
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
  page.setDefaultTimeout(600000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + dir + '/index.html?quality=high');
  await page.waitForFunction(() => window.BlendEngine && BlendEngine.game && BlendEngine.game.world);
  assert(await page.isVisible('#menu-film'), 'film buttons visible');
  await page.click('#menu-film');
  // Jump the sequencer to two shots and screenshot each.
  for (const [t, name] of [[1.5, 'film_shot1.png'], [4.5, 'film_shot2.png']]) {
    const info = await page.evaluate((t) => { const g = BlendEngine.game; g.cinematic.time = t; g.updateCinematic(0); return { state: g.state, cam: g.activeCamera && g.activeCamera.name, frame: g.cinematicFrame().toFixed(1), fov: g.activeCamera.animFov && g.activeCamera.animFov.toFixed(3) }; }, t);
    assert(info.state === 'cinematic' && info.cam === (t < 3 ? 'BE_Shot_Dolly' : 'BE_Shot_Orbit'), 'camera cut at ' + info.frame + ' -> ' + info.cam);
  }
  const ended = await page.evaluate(() => { const g = BlendEngine.game; if (!g.cinematic) g.startCinematic({ film: true }); g.cinematic.time = 100; g.updateCinematic(0); return g.state; });
  assert(ended === 'ended' && (await page.textContent('#menu-title')) === 'The End', 'film ends with The End screen');
  // Offline film render of 3 frames.
  const zipInfo = await page.evaluate(async () => {
    const g = BlendEngine.game;
    const blob = await g.renderFilm({ frameStart: 70, frameEnd: 72, samples: 6, size: [640, 360] });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { size: buf.length, b64: btoa(bin), state: g.state, canvas: [g.ui.canvas.width, g.ui.canvas.height] };
  });
  const zip = Buffer.from(zipInfo.b64, 'base64');
  if (process.argv[3]) fs.writeFileSync(process.argv[3], zip);
  assert(zip.readUInt32LE(0) === 0x04034b50 && zip.readUInt32LE(zip.length - 22) === 0x06054b50 && zip.readUInt16LE(zip.length - 12) === 4, 'film render ZIP has 3 frames + README');
  assert(zipInfo.state === 'ended' && zipInfo.canvas[0] === 1280, 'renderer restored after film render');
  assert(errors.length === 0, 'no page errors ' + JSON.stringify(errors.slice(0, 5)));
  await browser.close();
})();
