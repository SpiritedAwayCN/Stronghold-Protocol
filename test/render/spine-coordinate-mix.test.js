import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MODEL = 'char_263_skadi_summer_3';
const ROOT = path.resolve('plugins', 'local-skins', 'art', 'spine', 'op', 'char_263_skadi', MODEL);
let rt, base, core, SpineActor;
before(async () => {
  class Canvas { getContext() { return { fillRect() {}, clearRect() {}, drawImage() {} }; } }
  globalThis.HTMLCanvasElement ??= Canvas;
  globalThis.document ??= { createElement: () => new Canvas() };
  rt = require('@pixi-spine/runtime-3.8');
  base = require('@pixi-spine/base');
  core = require('@pixi/core');
  ({ SpineActor } = await import('../../public/js/render/spine.js'));
});

const entry = (model = MODEL) => ({ skel: `/local-skins/${model}/front/${model}.skel`, anims: { idle: 'Idle' } });

// A real AnimationState with two attachment coordinate frames: both authored poses put the visible vertex at x=0.
function synthetic(model = MODEL) {
  const data = new rt.SkeletonJson({
    newBoundingBoxAttachment: (_skin, name) => new rt.BoundingBoxAttachment(name),
  }).readSkeletonData({
    skeleton: { spine: '3.8.99' }, bones: [{ name: 'root' }, { name: 'hip', parent: 'root' }],
    slots: [{ name: 'body', bone: 'hip', attachment: 'idle' }],
    skins: [{ name: 'default', attachments: { body: {
      idle: { type: 'boundingbox', vertexCount: 1, vertices: [-1000, 0] },
      attack: { type: 'boundingbox', vertexCount: 1, vertices: [0, 0] },
    } } }],
    animations: {
      Idle: { bones: { hip: { translate: [{ time: 0, x: 1000 }, { time: 1, x: 1000 }] } }, slots: { body: { attachment: [{ time: 0, name: 'idle' }] } } },
      Attack: { bones: { hip: { translate: [{ time: 0, x: 0 }, { time: 1, x: 0 }] } }, slots: { body: { attachment: [{ time: 0, name: 'attack' }] } } },
    },
  });
  globalThis.PIXI = { spine: { Spine: class {
    constructor(d) { this.spineData = d; this.skeleton = new rt.Skeleton(d); this.stateData = new rt.AnimationStateData(d); this.state = new rt.AnimationState(this.stateData); }
    update(dt) { this.state.update(dt); this.state.apply(this.skeleton); this.skeleton.updateWorldTransform(); }
  } } };
  return new SpineActor(data, entry(model));
}
function vertex(a) {
  const slot = a.spine.skeleton.slots[0], v = new Float32Array(2);
  slot.getAttachment().computeWorldVertices(slot, 0, 2, v, 0, 2);
  return v[0];
}

test('coordinate-frame attachment switches use whole poses; other models retain their mixes', () => {
  for (const model of [MODEL, 'ordinary_model']) {
    const a = synthetic(model);
    a.update(0.1);
    assert.equal(vertex(a), 0);
    a._play('Attack', false, { mix: 0.06 });
    a.update(1 / 60);
    if (model === MODEL) assert.equal(vertex(a), 0);
    else assert.ok(vertex(a) > 700, 'control reproduces the attachment/bone mix displacement');
    if (model === MODEL) {
      a._play('Idle', true);
      a.update(1 / 60);
      assert.equal(vertex(a), 0, 'return to idle also keeps the coordinate frame intact');
    }
  }
});

test('queued transitions preserve authored clip duration and disable mixing only for this skin', () => {
  for (const model of [MODEL, 'ordinary_model']) {
    const a = synthetic(model);
    a._play('Attack', false);
    a.update(0.1);
    a._queue('Idle', true);
    const e = a.spine.state.tracks[0].next;
    assert.equal(e.mixDuration, model === MODEL ? 0 : 0.12);
    assert.equal(e.delay, model === MODEL ? 1 : 0.88);
    if (model === MODEL) {
      for (let i = 0; i < 70; i++) { a.update(1 / 60); assert.equal(vertex(a), 0); }
      assert.equal(a.spine.state.tracks[0].animation.name, 'Idle');
    }
  }
});

function drawn(skeleton) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity], v = new Float32Array(16384);
  for (const slot of skeleton.drawOrder) {
    const att = slot.getAttachment();
    if (!att || !slot.bone.active || slot.color.a * att.color.a <= 0.004) continue;
    let n = 0;
    if (att instanceof rt.RegionAttachment) { att.updateOffset(); att.computeWorldVertices(slot.bone, v, 0, 2); n = 8; }
    else if (att instanceof rt.MeshAttachment) { n = att.worldVerticesLength; att.computeWorldVertices(slot, 0, n, v, 0, 2); }
    for (let k = 0; k < n; k += 2) {
      bounds[0] = Math.min(bounds[0], v[k]); bounds[1] = Math.min(bounds[1], v[k + 1]);
      bounds[2] = Math.max(bounds[2], v[k]); bounds[3] = Math.max(bounds[3], v[k + 1]);
    }
  }
  return bounds;
}
for (const side of ['front', 'back']) test(`WR04 ${side}: real attachment geometry stays at the feet through attack transitions`, {
  skip: !existsSync(path.join(ROOT, side, `${MODEL}.skel`)) && 'optional local skin is not installed',
}, (t) => {
  const stem = path.join(ROOT, side, MODEL);
  const atlas = new base.TextureAtlas(readFileSync(`${stem}.atlas`, 'utf8'), (_line, cb) => cb(new core.BaseTexture(null, { width: 2048, height: 2048 })));
  const data = new rt.SkeletonBinary(new rt.AtlasAttachmentLoader(atlas)).readSkeletonData(new Uint8Array(readFileSync(`${stem}.skel`)));
  globalThis.PIXI = { spine: { Spine: rt.Spine } };
  const make = (model) => new SpineActor(data, entry(model));
  const control = make('ordinary_model');
  control.update(0.1); control._play('Attack', false, { mix: 0.06 }); control.update(1 / 60);
  const bad = drawn(control.spine.skeleton);
  assert.ok(bad[2] > 600 || bad[1] < -700, `control reproduces displacement: ${bad}`);
  t.diagnostic(`unfixed first frame: ${bad.map(Math.round).join(', ')}`);
  const a = make(MODEL);
  a.update(0.1);
  for (const clip of ['Attack', 'Idle', 'Attack_Begin', 'Attack', 'Attack_End', 'Idle', 'Attack', 'Attack', 'Idle']) {
    a._play(clip, clip === 'Idle', { mix: 0.06 });
    for (let i = 0; i < 6; i++) {
      a.update(1 / 60);
      const p = drawn(a.spine.skeleton);
      assert.ok(p.every(Number.isFinite) && p[0] > -500 && p[2] < 500 && p[1] > -550 && p[3] < 200, `${clip} frame ${i}: ${p}`);
    }
  }
});
