// SPDX-License-Identifier: GPL-2.0-or-later
//
// Plays "Kristall Vodiysi" with a bot (aims, fires, reloads, moves between
// targets, collects crystals, opens the gate) and records a 30 fps video.
//
//   node examples/kristall_vodiysi/record_gameplay.js <web_player_dir> <frames_dir> [max_seconds] [quality]
//   ffmpeg -framerate 30 -i <frames_dir>/f_%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 18 gameplay.mp4
//
// Time is virtual: the game loop is stepped by this script, so the video is
// smooth even when the machine renders slowly.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const [, , dir, framesDir, maxSecondsArg, quality] = process.argv;
const FPS = 30;
const MAX_SECONDS = +(maxSecondsArg || 150);

(async () => {
  fs.mkdirSync(framesDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(900000);
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
  await page.goto('file://' + path.resolve(dir) + '/index.html?' + (quality ? 'quality=' + quality + '&' : '') + 'scale=' + (process.env.BE_SCALE || '1'));
  await page.waitForFunction(() => window.BlendEngine && BlendEngine.game && BlendEngine.game.world, null, { timeout: 900000 });
  // Take over the frame loop only after loading (image decoding needs real frames).
  await page.evaluate(() => {
    window.__raf = [];
    window.__now = performance.now();
    window.requestAnimationFrame = (cb) => { window.__raf.push(cb); return 1; };
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
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
    g.settings.dynamicResolution = false;
    const bot = { stuck: 0, last: null, detour: 0, detourDir: 1, target: null, burst: 0, headAim: false };
    window.__bot = bot;
    const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
    const yawTo = (from, to) => Math.atan2(-(to[0] - from[0]), to[1] - from[1]);
    const lava = g.byName.get('KV_Lava_Pool');
    const lavaBox = lava ? g.nodeAABB(lava) : null;
    function avoidLava(pos, target) {
      if (!lavaBox) return target;
      const m = 1.4, b = { min: [lavaBox.min[0] - m, lavaBox.min[1] - m], max: [lavaBox.max[0] + m, lavaBox.max[1] + m] };
      for (let t = 0; t <= 1; t += 0.05) {
        const x = pos[0] + (target[0] - pos[0]) * t, y = pos[1] + (target[1] - pos[1]) * t;
        if (x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1]) {
          const corners = [[b.min[0], b.min[1]], [b.min[0], b.max[1]], [b.max[0], b.min[1]], [b.max[0], b.max[1]]];
          const cost = (c) => Math.hypot(c[0] - pos[0], c[1] - pos[1]) + Math.hypot(c[0] - target[0], c[1] - target[1]);
          corners.sort((c1, c2) => cost(c1) - cost(c2));
          return [corners[0][0], corners[0][1], target[2]];
        }
      }
      return target;
    }
    function visibleEnemy(pos) {
      const eye = [pos[0], pos[1], pos[2] + 1.55];
      let best = null, bestD = 38;
      for (const a of g.actors) {
        if (!a.alive || !a.actor.hostile) continue;
        const d = Math.hypot(a.position[0] - pos[0], a.position[1] - pos[1]);
        if (d > bestD) continue;
        const aim = [a.position[0], a.position[1], a.position[2] + 1.25];
        if (!g.hasLineOfSight(eye, aim)) continue;
        best = a; bestD = d;
      }
      return best;
    }
    const keys = g.input.keys;
    function step(dt) {
      const p = g.player, inp = g.input;
      for (const k of ['MOVE_FORWARD', 'MOVE_BACKWARD', 'MOVE_LEFT', 'MOVE_RIGHT', 'SPRINT']) inp.virtual.delete(k);
      keys.delete('LEFTMOUSE'); keys.delete('RIGHTMOUSE');
      if (!p || g.state !== 'playing' || g.dead || g.won) return;
      const pos = p.position;
      // 1. Combat: turn to the closest visible soldier and fire controlled bursts.
      if (!bot.target || !bot.target.alive || (g.frameNo % 15 === 0)) bot.target = visibleEnemy(pos);
      let moveTarget = null, interact = false;
      const enemy = bot.target;
      if (enemy) {
        if (!bot.headAimFor || bot.headAimFor !== enemy) { bot.headAimFor = enemy; bot.headAim = Math.random() < 0.45; }
        const aimPt = bot.headAim && enemy.character ? enemy.character.headWorld : [enemy.position[0], enemy.position[1], enemy.position[2] + 1.15];
        const cp = g.camPos || pos;
        const d = [aimPt[0] - cp[0], aimPt[1] - cp[1], aimPt[2] - cp[2]];
        const wantYaw = Math.atan2(-d[0], d[1]), wantPitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
        const ey = wrap(wantYaw - g.camYaw), ep = wantPitch - g.camPitch;
        g.camYaw += ey * Math.min(1, dt * 9);
        g.camPitch += ep * Math.min(1, dt * 9);
        const dist = Math.hypot(d[0], d[1]);
        if (dist > 11) keys.add('RIGHTMOUSE');
        if (Math.abs(ey) < 0.05 && Math.abs(ep) < 0.05) keys.add('LEFTMOUSE');
        // Keep some distance; strafe a little while shooting.
        if (dist < 6) moveTarget = [pos[0] - d[0], pos[1] - d[1], 0];
        else if (Math.sin(g.time * 0.9) > 0.3) moveTarget = [pos[0] + Math.cos(g.camYaw) * 3, pos[1] + Math.sin(g.camYaw) * 3, 0];
        else if (Math.sin(g.time * 0.9) < -0.3) moveTarget = [pos[0] - Math.cos(g.camYaw) * 3, pos[1] - Math.sin(g.camYaw) * 3, 0];
      } else {
        const hostiles = g.actors.filter((a) => a.alive && a.actor.hostile);
        const gems = g.nodes.filter((n) => n.tag === 'Coin' && n.alive);
        const door = g.doors[0];
        const near = (list) => list.sort((a, b) => Math.hypot(a.position[0] - pos[0], a.position[1] - pos[1]) - Math.hypot(b.position[0] - pos[0], b.position[1] - pos[1]))[0];
        const spring = g.byName.get('KV_Healing_Spring');
        if (p.health.cur < 35 && spring && spring.alive) moveTarget = spring.position;
        else if (hostiles.length) moveTarget = near(hostiles).position;
        else if (gems.length) moveTarget = near(gems).position;
        else if (door && door.open < 0.98) {
          const gx = door.box.min[0] - 0.9, gy = (door.box.min[1] + door.box.max[1]) / 2;
          moveTarget = [gx, gy, 0];
          interact = Math.hypot(pos[0] - gx, pos[1] - gy) < 0.8 || door.opening;
        } else moveTarget = [18.2, 10, 0];
        // Look where we walk.
        if (moveTarget) {
          const want = yawTo(pos, moveTarget);
          g.camYaw += wrap(want - g.camYaw) * Math.min(1, dt * 4);
          g.camPitch += (-0.12 - g.camPitch) * Math.min(1, dt * 3);
        }
      }
      if (moveTarget && !interact) {
        moveTarget = avoidLava(pos, moveTarget);
        const dx = moveTarget[0] - pos[0], dy = moveTarget[1] - pos[1];
        const dist = Math.hypot(dx, dy);
        if (dist > 0.5) {
          let want = Math.atan2(-dx, dy);
          const eye = [pos[0], pos[1], pos[2] + 0.9];
          const hit = g.world.raycast(eye, [-Math.sin(want), Math.cos(want), 0], Math.min(1.6, dist));
          if (bot.detour > 0) { bot.detour -= dt; want += bot.detourDir * 1.2; }
          else if (hit && hit.normal[2] < 0.6) { bot.detour = 0.7; bot.detourDir = Math.random() < 0.5 ? 1 : -1; }
          // Move relative to the camera yaw (the soldier strafes while aiming).
          const rel = wrap(want - g.camYaw);
          if (Math.cos(rel) > 0.38) inp.virtual.add('MOVE_FORWARD');
          if (Math.cos(rel) < -0.38) inp.virtual.add('MOVE_BACKWARD');
          if (Math.sin(rel) > 0.38) inp.virtual.add('MOVE_LEFT');
          if (Math.sin(rel) < -0.38) inp.virtual.add('MOVE_RIGHT');
          if (!enemy && dist > 7) inp.virtual.add('SPRINT');
        }
      }
      if (interact) inp.virtualPressed.add('INTERACT');
      const moving = inp.virtual.has('MOVE_FORWARD') || inp.virtual.has('MOVE_LEFT') || inp.virtual.has('MOVE_RIGHT') || inp.virtual.has('MOVE_BACKWARD');
      if (bot.last && Math.hypot(pos[0] - bot.last[0], pos[1] - bot.last[1]) < 0.015 && moving) bot.stuck += dt; else bot.stuck = 0;
      if (bot.stuck > 0.6) { inp.virtualPressed.add('JUMP'); bot.detour = 0.9; bot.detourDir = -bot.detourDir || 1; bot.stuck = 0; }
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
    await page.screenshot({ path: path.join(framesDir, 'f_' + String(i).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 90 });
    if (i % 30 === 0) {
      const s = await page.evaluate(() => {
        const g = BlendEngine.game, p = g.player;
        return { state: g.state, won: g.won, dead: g.dead, gems: g.objectives.collected, hp: Math.round(p.health.cur), mag: g.playerGun && g.playerGun.mag,
          enemies: g.actors.filter((a) => a.alive && a.actor.hostile).length, pos: p.position.map((v) => +v.toFixed(1)), kills: (p.vars.get('Kills') || { value: 0 }).value };
      });
      console.log(`t=${(i / FPS).toFixed(0)}s ${JSON.stringify(s)}`);
      if ((s.won || s.dead || s.state === 'ended') && endFrames < 0) endFrames = i + 3 * FPS;
    }
    if (endFrames >= 0 && i >= endFrames) break;
  }
  await browser.close();
})();
