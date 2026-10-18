// RENDER_E2E=1 CHROME_PATH=<Chrome executable> node --test test/render/spine-coordinate-mix.browser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MODEL = 'char_263_skadi_summer_3';
const ASSET = `plugins/local-skins/art/spine/op/char_263_skadi/${MODEL}`;
test('WR04: browser pixels stay near the feet through the first Attack frames', {
  skip: process.env.RENDER_E2E !== '1' || !existsSync(CHROME) || !existsSync(path.join(ASSET, 'front', `${MODEL}.skel`)),
  timeout: 60000,
}, async (t) => {
  const { default: puppeteer } = await import('puppeteer-core');
  const root = path.resolve('.');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><body></body>'); return; }
    const file = path.resolve(root, url.pathname.startsWith('/plugins/') ? `.${url.pathname}` : `public${url.pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) { res.writeHead(403).end(); return; }
    try {
      const ext = path.extname(file);
      res.setHeader('Content-Type', ext === '.js' ? 'text/javascript' : ext === '.png' ? 'image/png' : 'application/octet-stream');
      res.end(readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ url: '/vendor/pixi.min.js' });
    await page.addScriptTag({ url: '/vendor/pixi-spine.js' });
    const results = await page.evaluate(async ({ ASSET, MODEL }) => {
      const { SpineActor } = await import('/js/render/spine.js');
      const app = new PIXI.Application({ width: 1600, height: 1200, backgroundAlpha: 0 });
      app.stop();
      const out = [];
      for (const side of ['front', 'back']) {
        const url = `/${ASSET}/${side}/${MODEL}.skel`;
        const resource = await PIXI.Assets.load(url);
        for (const fixed of [false, true]) {
          const a = new SpineActor(resource.spineData, { skel: fixed ? url : '/ordinary.skel', anims: { idle: 'Idle' } });
          a.spine.position.set(400, 1000);
          app.stage.addChild(a.spine);
          a.update(0.1); a._play('Attack', false, { mix: 0.06 });
          for (let frame = 0; frame < 4; frame++) {
            a.update(1 / 60);
            app.renderer.render(app.stage);
            const pixels = app.renderer.extract.pixels();
            let far = 0, ink = 0;
            for (let y = 0; y < 1200; y++) for (let x = 0; x < 1600; x++) {
              if (pixels[(y * 1600 + x) * 4 + 3] <= 1) continue;
              ink++;
              if (x > 1000 || y < 400) far++;
            }
            out.push({ side, fixed, frame, far, ink });
          }
          app.stage.removeChild(a.spine);
          a.spine.destroy({ children: true });
        }
      }
      app.destroy(true);
      return out;
    }, { ASSET, MODEL });
    for (const side of ['front', 'back']) {
      const old = results.filter(r => r.side === side && !r.fixed);
      assert.ok(old.some(r => r.far > 100), `${side}: control visibly reproduces the jump`);
      for (const r of results.filter(r => r.side === side && r.fixed)) {
        assert.ok(r.ink > 100, `${side} frame ${r.frame}: model is visible`);
        assert.equal(r.far, 0, `${side} frame ${r.frame}: no pixels at the displaced position`);
      }
      t.diagnostic(`${side}: unfixed distant pixels ${old.map(r => r.far).join(', ')}, fixed 0 each frame`);
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
