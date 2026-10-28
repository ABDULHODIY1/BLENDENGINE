// SPDX-License-Identifier: GPL-2.0-or-later
//
// Plays "Kristall Vodiysi" with a simple bot and records a 30 fps video.
//
//   node examples/kristall_vodiysi/record_gameplay.js <web_player_dir> <frames_dir> [max_seconds]
//   ffmpeg -framerate 30 -i <frames_dir>/f_%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 18 gameplay.mp4
//
// Time is virtual: requestAnimationFrame and setTimeout are driven by this script,
// so the video is smooth even when the machine renders slowly.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const [, , dir, framesDir, maxSecondsArg] = process.argv;
const FPS = 30;
const MAX_SECONDS = +(maxSecondsArg || 150);

(async () => {
  fs.mkdirSync(framesDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(600000);
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
  await page.addInitScript(() => {
    window.__raf = [];
    window.__now = 0;
    window.requestAnimationFrame = (cb) => { window.__raf.push(cb); return window.__raf.length; };
  });
  await page.goto('file://' + path.resolve(dir) + '/index.html');
  await page.waitForFunction(() => window.BlendEngine && BlendEngine.game && BlendEngine.game.world, null, { timeout: 600000 });

  await page.evaluate(() => {
    // Virtual timers so toasts and reloads follow game time, not wall time.
    const timers = [];
    window.setTimeout = (fn, ms) => { timers.push({ at: window.__now + (ms || 0), fn }); return timers.length; };
    window.__tick = (ms) => {
      window.__now += ms;
      for (let i = timers.length - 1; i >= 0; i--) if (timers[i].at <= window.__now) { const t = timers.splice(i, 1)[0]; try { t.fn(); } catch (e) { console.error(e); } }
      const cbs = window.__raf; window.__raf = [];
      for (const cb of cbs) cb(window.__now);
    };
    const style = document.createElement('style');
    style.textContent = '.toast { animation: none !important; opacity: 1 !important; }';
    document.head.appendChild(style);

    // ---------------------------------------------------------------- the bot
    const g = BlendEngine.game;
    // Fixed full resolution for the recording (frame timing here is virtual).
    g.settings.dynamicResolution = false;
    g.renderer.setScale(1);
    const bot = { stuck: 0, last: null, detour: 0, detourDir: 1, waitDoor: 0, log: [] };
    window.__bot = bot;
    const yawTo = (from, to) => Math.atan2(-(to[0] - from[0]), to[1] - from[1]);
    const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
    const lava = g.byName.get('KV_Lava_Pool');
    const lavaBox = lava ? g.nodeAABB(lava) : null;
    function avoidLava(pos, target) {
      if (!lavaBox) return target;
      const m = 1.4, b = { min: [lavaBox.min[0] - m, lavaBox.min[1] - m], max: [lavaBox.max[0] + m, lavaBox.max[1] + m] };
      for (let t = 0; t <= 1; t += 0.05) {
        const x = pos[0] + (target[0] - pos[0]) * t, y = pos[1] + (target[1] - pos[1]) * t;
        if (x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1]) {
          const corners = [[b.min[0], b.min[1]], [b.min[0], b.max[1]], [b.max[0], b.min[1]], [b.max[0], b.max[1]]];
          corners.sort((c1, c2) => (Math.hypot(c1[0] - pos[0], c1[1] - pos[1]) + Math.hypot(c1[0] - target[0], c1[1] - target[1])) - (Math.hypot(c2[0] - pos[0], c2[1] - pos[1]) + Math.hypot(c2[0] - target[0], c2[1] - target[1])));
          return [corners[0][0], corners[0][1], target[2]];
        }
      }
      return target;
    }
    function step(dt) {
      const p = g.player, inp = g.input;
      inp.virtual.delete('MOVE_FORWARD');
      inp.virtual.delete('SPRINT');
      if (!p || g.state !== 'playing' || g.dead || g.won) return;
      const pos = p.position;
      let target = null, attack = false, interact = false;
      const enemy = g.actors.filter((a) => a.alive && a.actor.hostile && Math.hypot(a.position[0] - pos[0], a.position[1] - pos[1]) < 4.5)
        .sort((a, b) => Math.hypot(a.position[0] - pos[0], a.position[1] - pos[1]) - Math.hypot(b.position[0] - pos[0], b.position[1] - pos[1]))[0];
      const gems = g.nodes.filter((n) => n.tag === 'Coin' && n.alive);
      const door = g.doors[0];
      if (enemy) { target = enemy.position; attack = true; }
      else if (p.health.cur < 45 && g.byName.get('KV_Healing_Spring').alive) target = g.byName.get('KV_Healing_Spring').position;
      else if (gems.length) target = gems.sort((a, b) => Math.hypot(a.position[0] - pos[0], a.position[1] - pos[1]) - Math.hypot(b.position[0] - pos[0], b.position[1] - pos[1]))[0].position;
      else if (door && door.open < 0.98) {
        // Walk up to the gate, then press E (doors open within 2.5 m of their box).
        const gx = door.box.min[0] - 0.9, gy = (door.box.min[1] + door.box.max[1]) / 2;
        target = [gx, gy, 0];
        interact = Math.hypot(pos[0] - gx, pos[1] - gy) < 0.7 || door.opening;
      }
      else target = [18.2, 10, 0];
      if (!attack) target = avoidLava(pos, target);
      const dist = Math.hypot(target[0] - pos[0], target[1] - pos[1]);
      let want = yawTo(pos, target);
      // Feel ahead and turn around obstacles.
      const eye = [pos[0], pos[1], pos[2] - p.ctrl.footOffset + 0.9];
      const ahead = [-Math.sin(want), Math.cos(want), 0];
      const hit = g.world.raycast(eye, ahead, Math.min(1.8, dist));
      if (bot.detour > 0) { bot.detour -= dt; want += bot.detourDir * 1.1; }
      else if (hit && hit.normal[2] < 0.6 && !attack) { bot.detour = 0.7; bot.detourDir = Math.random() < 0.5 ? 1 : -1; }
      g.camYaw += wrap(want - g.camYaw) * Math.min(1, dt * 4.5);
      g.camPitch += (-0.3 - g.camPitch) * Math.min(1, dt * 2);
      const facing = Math.abs(wrap(want - g.camYaw)) < 0.9;
      if (facing && !(interact) && !(attack && dist < 1.4)) inp.virtual.add('MOVE_FORWARD');
      if (!attack && dist > 8 && facing) inp.virtual.add('SPRINT');
      if (attack && dist < 3.0 && g.fireCooldown <= 0) inp.virtualPressed.add('ATTACK');
      if (interact) { inp.virtualPressed.add('INTERACT'); bot.waitDoor += dt; }
      // Unstick: jump and sidestep when not making progress.
      if (bot.last && Math.hypot(pos[0] - bot.last[0], pos[1] - bot.last[1]) < 0.02 && inp.virtual.has('MOVE_FORWARD')) bot.stuck += dt; else bot.stuck = 0;
      if (bot.stuck > 0.5) { inp.virtualPressed.add('JUMP'); bot.detour = 0.8; bot.detourDir = -bot.detourDir || 1; bot.stuck = 0; }
      bot.last = pos.slice();
    }
    const update = g.update.bind(g);
    g.update = (dt) => { step(dt); update(dt); };
  });

  await page.click('#menu-play');
  const total = MAX_SECONDS * FPS;
  let endFrames = -1;
  for (let i = 0; i < total; i++) {
    await page.evaluate((ms) => window.__tick(ms), 1000 / FPS);
    await page.screenshot({ path: path.join(framesDir, 'f_' + String(i).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 88 });
    if (i % 30 === 0) {
      const s = await page.evaluate(() => { const g = BlendEngine.game; const p = g.player; return { state: g.state, won: g.won, dead: g.dead, gems: g.objectives.collected, hp: Math.round(p.health.cur), pos: p.position.map((v) => +v.toFixed(1)), kills: (p.vars.get('Kills') || { value: 0 }).value }; });
      console.log(`t=${(i / FPS).toFixed(0)}s ${JSON.stringify(s)}`);
      if ((s.won || s.dead || s.state === 'ended') && endFrames < 0) endFrames = i + 3 * FPS;
    }
    if (endFrames >= 0 && i >= endFrames) break;
  }
  await browser.close();
})();
