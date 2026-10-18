import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from '../helpers/contentFixtures.js';
import { buildContentSet } from '../../server/plugins/contentSet.js';
import { makeMatch } from '../match/harness.js';
import { resolveSkill, planFor } from '../../public/js/render/vfx/skills.js';

const root = new URL('../../plugins/roster-clemnt/', import.meta.url);
const test = (name, run) => nodeTest(name, { skip: !fs.existsSync(new URL('plugin.json', root)) }, run);
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

test('roster-clemnt binds official effects for both forms and resolves the S2 loop', t => {
  const { data } = compose(t);
  const unit = 'char_4231_clemnt', skillId = 'skchr_clemnt_2';
  const skill = { rootClass: 'CastSkill', mode: 1, effects: ['clemnt_skill_02_buff_01'], uses: [{
    role: 'loop', keys: ['clemnt_skill_02_buff_01'], from: 'ActiveBuffAbility._buffs', on: 'owner',
    buff: 'clemnt_s2[switch_mode]', life: { type: 'LIMITED', key: 'duration' },
  }] };
  const idx = { version: 3, units: { [unit]: { skills: { [skillId]: skill } } }, skills: { [skillId]: skill },
    prefabs: { clemnt_skill_02_buff_01: { looping: true } } };
  for (const form of ['a', 'b']) {
    const rec = data.chess[`chess_x_roster_clemnt_clemnt_${form}`];
    assert.deepEqual(rec.fx, { unit, skills: { '0': 'skchr_clemnt_1', '1': skillId, '2': 'skchr_clemnt_3' } });
    const info = { kind: 'op', skillIndex: 1, spine: rec.charId };
    const resolved = resolveSkill(idx, { info, rec });
    assert.equal(resolved.unitKey, unit);
    assert.equal(resolved.skillId, skillId);
    assert.equal(resolved.via, 'plugin');
    assert.ok(planFor(idx, { info, rec }).plan.loop.some(e => e.key === 'clemnt_skill_02_buff_01'));
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
