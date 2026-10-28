// SPDX-License-Identifier: GPL-2.0-or-later
//
// Browser gameplay test for the BlendEngine 3D runtime (runtime_web/).
//
// 1. Export the "3D Starter World" and "Cyberpunk Zombie Shooter" templates
//    with Ship > Prepare Build Package (target Web), or headless:
//      blender --background --python tests/runtime_web/export_templates.py -- /tmp/be basic shooter
// 2. Run with Node.js and Playwright (Chromium):
//      node tests/runtime_web/gameplay_test.js <starter>/web_player <shooter>/web_player
//
// Checks wall collision, jumping, coin pickup + score, locked portal, damage
// zones, victory, restart, NPC attacks, hitscan shooting and NPC stability.
const { chromium } = require('playwright');
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
(async () => {
  const [,, basicDir, shooterDir] = process.argv;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // ---------------- basic template
  await page.goto('file://' + basicDir + '/index.html?quality=low');
  await page.waitForFunction(() => window.BlendEngine && BlendEngine.game && BlendEngine.game.world);
  await page.click('#menu-play');
  const step = (n, fn) => page.evaluate(([n, fn]) => { const g = BlendEngine.game; const f = new Function('g', fn); for (let i = 0; i < n; i++) { f(g); g.update(1 / 60); } return null; }, [n, fn || '']);
  // Walk into the east wall for 6 seconds.
  await page.evaluate(() => { const g = BlendEngine.game; g.player.position = [8, -2, g.player.position[2]]; g.camYaw = -Math.PI / 2; });
  await page.keyboard.down('KeyW');
  await step(360);
  await page.keyboard.up('KeyW');
  let r = await page.evaluate(() => ({ x: BlendEngine.game.player.position[0], z: BlendEngine.game.player.position[2], gr: BlendEngine.game.player.ctrl.grounded }));
  assert(r.x > 11 && r.x < 13.9, 'wall stops player (x=' + r.x.toFixed(2) + ')');
  assert(r.gr, 'player grounded after walking');
  // Jump.
  await page.evaluate(() => BlendEngine.game.input.pressedKeys.add('SPACE'));
  await step(1);
  await step(12);
  r = await page.evaluate(() => ({ z: BlendEngine.game.player.position[2], gr: BlendEngine.game.player.ctrl.grounded }));
  assert(!r.gr, 'player airborne after jump');
  await step(120);
  r = await page.evaluate(() => BlendEngine.game.player.ctrl.grounded);
  assert(r, 'player lands again');
  // Coin pickup.
  r = await page.evaluate(() => {
    const g = BlendEngine.game, coin = g.nodes.find(n => n.tag === 'Coin');
    g.player.position = [coin.position[0], coin.position[1], g.player.position[2]];
    g.update(1 / 60);
    return { alive: coin.alive, score: g.player.vars.get('Score').value, collected: g.objectives.collected };
  });
  assert(!r.alive && r.score === 10 && r.collected === 1, 'coin collected adds score ' + JSON.stringify(r));
  // Portal before all coins does not win.
  r = await page.evaluate(() => {
    const g = BlendEngine.game, portal = g.byName.get('BE_Exit_Portal');
    g.player.position = [13.3, portal.position[1], g.player.position[2]];
    g.update(1 / 60);
    return g.won;
  });
  assert(r === false, 'portal locked until all coins collected');
  // Damage zone hurts.
  r = await page.evaluate(() => {
    const g = BlendEngine.game, zone = g.nodes.find(n => n.tag === 'Damage');
    g.actors.forEach(a => a.alive = false);
    const hp0 = g.player.health.cur;
    for (let i = 0; i < 60; i++) { g.player.position = [zone.position[0], zone.position[1], g.player.position[2]]; g.update(1 / 60); }
    return [hp0, g.player.health.cur];
  });
  assert(r[1] < r[0] - 10, 'damage zone hurts player ' + r.map(v => v.toFixed(1)));
  // Collect all coins then portal -> victory.
  r = await page.evaluate(() => {
    const g = BlendEngine.game;
    for (const coin of g.nodes.filter(n => n.tag === 'Coin' && n.alive)) { g.player.position = [coin.position[0], coin.position[1], g.player.position[2] + 0.2]; g.update(1 / 60); g.update(1 / 60); }
    const portal = g.byName.get('BE_Exit_Portal');
    g.player.position = [13.3, portal.position[1], g.player.position[2]];
    g.update(1 / 60);
    return { won: g.won, collected: g.objectives.collected, coins: g.objectives.coins };
  });
  assert(r.won, 'victory after all coins + portal ' + JSON.stringify(r));
  // Restart resets.
  await page.click('#menu-play');
  r = await page.evaluate(() => ({ state: BlendEngine.game.state, won: BlendEngine.game.won, coins: BlendEngine.game.objectives.collected }));
  assert(r.state === 'playing' && !r.won && r.coins === 0, 'play again resets level');
  // Enemy attack kills eventually -> game over.
  r = await page.evaluate(() => {
    const g = BlendEngine.game; const e = g.actors.find(a => a.actor.hostile);
    for (let i = 0; i < 60 * 30 && !g.dead; i++) { g.player.position = [e.position[0] + 0.8, e.position[1], g.player.position[2]]; g.update(1 / 60); }
    return { dead: g.dead, hp: g.player.health.cur };
  });
  assert(r.dead, 'hostile NPC can kill the player ' + JSON.stringify(r));

  // ---------------- shooter template
  await page.goto('file://' + shooterDir + '/index.html?quality=low');
  await page.waitForFunction(() => window.BlendEngine && BlendEngine.game && BlendEngine.game.world);
  await page.click('#menu-play');
  r = await page.evaluate(() => {
    const g = BlendEngine.game, z = g.actors[0];
    let shots = 0;
    for (let i = 0; i < 400 && z.alive; i++) {
      const head = [z.position[0], z.position[1], z.position[2] - z.actor.footOffset + z.actor.height * 0.5];
      const d = [head[0] - g.camPos[0], head[1] - g.camPos[1], head[2] - g.camPos[2]];
      g.camYaw = Math.atan2(-d[0], d[1]); g.camPitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
      g.updateCamera(0);
      if (g.fireCooldown <= 0) { g.attack(); shots++; }
      g.fireCooldown = Math.max(0, g.fireCooldown - 1 / 60);
    }
    return { alive: z.alive, shots, kills: g.player.vars.get('Kills').value, ammo: g.player.vars.get('Ammo').value };
  });
  assert(!r.alive && r.kills === 1, 'shooting kills a zombie ' + JSON.stringify(r));
  r = await page.evaluate(() => { const g = BlendEngine.game; for (let i = 0; i < 300; i++) g.update(1 / 60); return g.actors.filter(a => a.alive).every(a => a.position.every(Number.isFinite) && a.position[2] > -5) && g.actors.filter(a => a.alive).length >= 4; });
  assert(r, 'zombies stay on the map with finite positions');
  assert(errors.length === 0, 'no page errors ' + JSON.stringify(errors.slice(0, 5)));
  await browser.close();
})();
