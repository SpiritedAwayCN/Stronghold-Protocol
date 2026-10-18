import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from '../helpers/contentFixtures.js';
import { buildContentSet } from '../../server/plugins/contentSet.js';
import { makeMatch, give } from '../match/harness.js';
import { GameData } from '../../server/match/gamedata.js';
import { SharedPool, drawDisabledBonds } from '../../server/match/pool.js';
import { createRng } from '../../server/sim/rng.js';
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

test('roster-clemnt has the same copy weight as every ordinary tier-six operator', t => {
  const { data } = compose(t), id = 'chess_x_roster_clemnt_clemnt_a';
  for (const mode of ['mode_single_normal', 'mode_multi_normal']) {
    const gd = new GameData(data, mode), pool = new SharedPool(gd), cap = gd.isSolo ? 5 : 10;
    assert.equal(pool.cap(id), cap);
    assert.equal(pool.has('chess_char_6_14_a'), false, 'replaced Lumen is outside the pool');
    const peers = [...pool.entries].filter(([, e]) => e.tier === 6);
    assert.ok(peers.length > 1);
    for (const [peer, entry] of peers) assert.equal(entry.cap, cap, peer);
    const checkWeights = () => {
      const eligible = [...pool.entries].filter(([, e]) => e.left > 0);
      const total = eligible.reduce((sum, [, e]) => sum + e.left, 0), hits = new Map();
      // Exhaust every copy's interval midpoint, so an unequal weight cannot hide in sampling noise.
      for (let i = 0; i < total; i++) {
        const drawn = pool.roll(() => (i + 0.5) / total, { maxTier: 6 });
        hits.set(drawn, (hits.get(drawn) || 0) + 1);
      }
      for (const [peer, entry] of eligible) assert.equal(hits.get(peer), entry.left, peer);
    };
    checkWeights();
    pool.take(id, 1); checkWeights();
    pool.give(id, 1); checkWeights();
    for (let seed = 1; seed <= 64; seed++) {
      const disabled = drawDisabledBonds(gd, createRng(seed));
      const off = new Set([...disabled.drawn, ...disabled.staticOff]);
      assert.equal(disabled.banned.includes(id), data.chess[id].bonds.every(b => off.has(b)));
      const matchPool = new SharedPool(gd, disabled);
      assert.equal(matchPool.cap(id), disabled.banned.includes(id) ? 0 : cap);
    }
  }
});

test('roster-clemnt Ulpian replacement grants ordinary and elite gifts after stock exhaustion', t => {
  const { data } = compose(t), item = 'chess_item_3_07_e_a';
  const investors = Object.values(data.chess).filter(c => c.visible && !c.isGolden && c.bonds?.includes('investShip'));
  for (const layers of [null, 0, 100]) for (const [form, count] of [['a', 1], ['b', 2]]) {
    const h = makeMatch({ data, mode: 'solo', fake: true }).start();
    t.after(() => h.m.dispose());
    h.toPrep(1);
    const ps = h.ps('p_0'), pool = h.m.itemPool;
    for (let i = 0; i < pool.cap(item); i++) assert.ok(ps.acquireItem(item));
    assert.equal(pool.left(item), 0);
    if (layers !== null) {
      for (const c of investors.slice(0, 3)) give(h.m, ps, c.chessId);
      ps.layers.investShip = layers; ps.recompute();
      assert.equal(ps.bonds.investShip.active, true);
    }
    const repeat = layers === null ? 1 : layers >= 100 ? 3 : 2;
    const held = pool.held(item);
    assert.ok(ps.acquireChess(`chess_char_5_05_${form}`));
    assert.equal(pool.held(item), held + count * repeat);
    assert.deepEqual(h.logs.error, []);
  }
});
