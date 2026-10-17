import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from '../helpers/contentFixtures.js';
import { buildContentSet } from '../../server/plugins/contentSet.js';
import { makeMatch } from '../match/harness.js';

const root = new URL('../../plugins/roster-clemnt/', import.meta.url);
const read = file => JSON.parse(fs.readFileSync(new URL(file, root), 'utf8'));

function compose(t) {
  const f = fixture(t), manifest = read('plugin.json');
  f.put(manifest.id, manifest, Object.fromEntries(manifest.data.map(file => [file, read(file)])));
  const set = buildContentSet({ registry: f.registry, ids: [manifest.id] });
  assert.deepEqual(set.problems, []);
  return set;
}

test('roster-clemnt composes both trait forms without the old skill-start garrison', t => {
  const { data } = compose(t);
  for (const [form, amount, maxPerBattle] of [['a', 1, 12], ['b', 2, 24]]) {
    const piece = data.chess[`chess_x_roster_clemnt_clemnt_${form}`];
    assert.ok(piece);
    assert.equal(piece.garrisonIds.length, 1);
    const tr = data.garrisons[piece.garrisonIds[0]].operatorTrait;
    assert.ok(tr);
    assert.equal(tr.spec.talents[0].when, 'elementBurst');
    assert.deepEqual(tr.spec.talents[0].do[0].layers, { bond: 'selfActive', amount, maxPerBattle });
    assert.equal(piece.garrisonIds.includes(`garrison_x_roster_clemnt_${form}`), false);
  }
});

test('roster-clemnt Ulpian replacement grants ordinary and elite gifts after stock exhaustion', t => {
  const { data } = compose(t), item = 'chess_item_3_07_e_a';
  for (const [form, count] of [['a', 1], ['b', 2]]) {
    const h = makeMatch({ data, mode: 'solo', fake: true }).start();
    h.toPrep(1);
    const ps = h.ps('p_0'), pool = h.m.itemPool;
    for (let i = 0; i < pool.cap(item); i++) assert.ok(ps.acquireItem(item));
    assert.equal(pool.left(item), 0);
    const held = pool.held(item);
    assert.ok(ps.acquireChess(`chess_char_5_05_${form}`));
    assert.equal(pool.held(item), held + count);
    assert.deepEqual(h.logs.error, []);
  }
});
