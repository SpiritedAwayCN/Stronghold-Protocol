// test/render/fxsvrashwave.test.js — 银灰 S3 真银斩's per-attack semicircle wave.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';

let fake, FX;
before(async () => {
  fake = installFakePixi();
  FX = await import('../../public/js/render/fx.js');
});
after(() => fake.restore());

const cam = presetCamera('normal', { width: 1600, height: 900 });
const unit = (dir) => ({ id: 1, x: 3, y: 10, z: 0, hover: 0, dir, alive: true, destroyed: false, info: { defId: 'char_172_svrash' } });
const makeFx = (v) => {
  const P = fake.P, ctx = fakeViewCtx(P), map = new Map([[v.id, v]]);
  return new FX.FxSystem({
    P, layers: ctx.layers, cam: () => cam, heightAt: () => 0, settings: { quality: 'high' },
    timeScale: () => 2, loadLevel: () => 0, subProfOf: () => null, view: (id) => map.get(id) || null,
    screenSize: () => ({ width: 1600, height: 900 }), fieldTop: () => 120,
  });
};

test('真银斩 wave draws one continuous silver semicircle that follows all four facing directions', () => {
  for (const dir of ['UP', 'RIGHT', 'DOWN', 'LEFT']) {
    const fx = makeFx(unit(dir));
    fx.simFx('truesilverWave', 3, 10, { id: 1, attackInterval: 1.3 });
    assert.equal(fx.beamList.length, 1, `${dir}: one continuous arc is registered`);
    assert.equal(fx.beamList[0].arc, true, `${dir}: the effect uses the arc renderer`);
    fx.update(0.01);
    assert.ok(fx.beamList[0].t > 0, `${dir}: arc expands immediately`);
  }
});

test('真银斩 wave moves faster for a shorter attack interval', () => {
  const fast = makeFx(unit('RIGHT'));
  const slow = makeFx(unit('RIGHT'));
  fast.simFx('truesilverWave', 3, 10, { id: 1, attackInterval: 0.7 });
  slow.simFx('truesilverWave', 3, 10, { id: 1, attackInterval: 1.4 });
  assert.ok(fast.beamList[0].dur < slow.beamList[0].dur, 'shorter attack interval gives a faster wave');
});