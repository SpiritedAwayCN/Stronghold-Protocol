import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyRosterVariant } from '../shared/rosterVariant.js';
import { diyPool, diyRecord, validateDiyPicks } from '../shared/diy.js';
import { isDroppableChess, standInRecord } from '../shared/standIn.js';
import { atPotential } from '../shared/potential.js';
import { GameData } from '../server/match/gamedata.js';
import { SharedPool } from '../server/match/pool.js';
import { DataSource, setSimData } from '../server/sim/simdata.js';
import { KITTED_CHARS } from '../server/sim/content/kits/index.js';
import { setGameData } from '../server/sim/content/support/index.js';
import { createDataStore } from '../public/js/data.js';
import { makeBattle, checkInvariants } from './helpers/battleHarness.js';

const raw = Object.fromEntries(['config', 'chess', 'backups', 'garrisons', 'bonds', 'items', 'effects']
  .map(name => [name, JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url)))]));
const original = { ...raw, config: { ...raw.config, clemntRosterVersion: 'original' } };
const modified = applyRosterVariant(raw);
const C = 'chess_char_6_clemnt_a', L = 'chess_char_6_14_a';
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('default roster swaps the shared tier-6 stock, DIY picks and bond member lists without mutating original data', () => {
  assert.equal(raw.config.clemntRosterVersion, 'modified');
  const gd = new GameData(raw, 'mode_multi_normal');
  const pool = new SharedPool(gd);
  assert.equal(pool.has(C), true);
  assert.equal(pool.has(L), false);
  assert.equal(pool.cap(C), new SharedPool(new GameData(original, gd.modeId)).cap(L));
  assert.equal(gd.visibleChess.length, new GameData(original, gd.modeId).visibleChess.length);
  for (const tier of [5, 6]) {
    const picks = diyPool(tier, { data: modified, kitted: KITTED_CHARS });
    assert.ok(picks.includes('char_4042_lumen'));
    assert.ok(!picks.includes('char_4231_clemnt'));
  }
  for (const id of ['egirShip', 'swiftShip']) assert.ok(modified.bonds[id].visibleMembers.includes(C));
  for (const bond of Object.values(modified.bonds)) assert.ok(!bond.visibleMembers.includes(L));
  assert.equal(raw.chess[L].visible, true);
  assert.ok(raw.backups.diy.ownedPool.includes('char_4231_clemnt'));
  assert.deepEqual(applyRosterVariant(modified), modified, 'applying twice is idempotent');
});

test('disabled / missing / unknown switches preserve the complete original roster', () => {
  for (const value of ['original', undefined, 'unknown']) {
    const data = { ...raw, config: { ...raw.config, clemntRosterVersion: value } };
    assert.equal(applyRosterVariant(data), data);
    const gd = new GameData(data, 'mode_multi_normal');
    assert.ok(gd.visibleChess.includes(L));
    assert.ok(!gd.visibleChess.includes(C));
    assert.ok(diyPool(6, { data }).includes('char_4231_clemnt'));
    assert.ok(!diyPool(6, { data }).includes('char_4042_lumen'));
    assert.deepEqual(data.chess[L].garrisonIds, ['garrison_57_a']);
  }
  assert.throws(() => applyRosterVariant({ config: raw.config }), /regenerated backups/);
});

test('Clement defaults to S2, supports every skill and potential, and Sharp inherits both bonds and the trait', () => {
  const ds = new DataSource(raw);
  for (const suffix of ['a', 'b']) {
    const id = `chess_char_6_clemnt_${suffix}`;
    const rec = modified.chess[id];
    assert.equal(rec.chessType, 'NORMAL');
    assert.equal(rec.skill.skillId, 'skchr_clemnt_2');
    assert.deepEqual(rec.bonds, ['egirShip', 'swiftShip']);
    assert.equal(isDroppableChess(rec), suffix === 'a');
    const backup = standInRecord(rec, modified.backups);
    assert.equal(backup.charId, 'char_609_acguad');
    assert.deepEqual(backup.bonds, rec.bonds);
    assert.deepEqual(backup.garrisonIds, rec.garrisonIds);
    for (const potential of [1, 3, 6]) for (const skillIndex of [0, 1, 2]) {
      const h = makeBattle({ data: ds, autoFinish: false, units: [{ chessId: id, potential, skillIndex, row: 10, col: 3 }] });
      h.step();
      assert.equal(h.unit(1).skill.id, `skchr_clemnt_${skillIndex + 1}`);
      assert.ok(!h.unit(1).kit.generic);
      assert.deepEqual(h.b.errors, []);
      const expected = atPotential(raw.backups.units.char_4231_clemnt.forms[suffix === 'a' ? '2/1/4/0' : '2/60/7/3'], potential);
      assert.equal(ds.getChess(id, { potential, skillIndex }).stats.atk, expected.stats.atk);
      checkInvariants(h.b);
    }
  }
});

test('Clement trait combines active layers before floor division, uses 1% / 2% and refreshes on gains, including backup', () => {
  setGameData(modified);
  try {
    for (const elite of [false, true]) for (const standIn of [false, true]) {
      for (const [a, s, active, steps] of [[1, 1, true, 1], [3, 4, true, 3], [3, 100, false, 1], [0, 0, true, 0]]) {
        const state = (layers, on) => ({ count: on ? 3 : 0, active: on, tier: on ? 1 : 0, layers });
        const h = makeBattle({
          data: new DataSource(modified), autoFinish: false,
          units: [{ chessId: elite ? 'chess_char_6_clemnt_b' : C, standIn, row: 10, col: 3 }],
          bonds: { egirShip: state(a, true), swiftShip: state(s, active) },
        });
        h.step();
        const unit = h.unit(1), gid = elite ? 'garrison_clemnt_b' : 'garrison_clemnt_a';
        const rate = elite ? 0.02 : 0.01;
        approx(unit.findBuff(`gar:${gid}`)?.mods.atkPct ?? 0, steps * rate);
        h.b.addLayers('p1', 'egirShip', 2, 'test');
        h.step(2);
        approx(unit.findBuff(`gar:${gid}`).mods.atkPct, (steps + 1) * rate);
        assert.deepEqual(h.b.errors, []);
      }
    }
  } finally { setGameData(null); }
});

test('Lumen DIY has only 协防, no trait, and faithfully runs all skills at both tiers', () => {
  const ds = new DataSource(modified);
  for (const tier of [5, 6]) for (const elite of [false, true]) for (const skillIndex of [0, 1, 2]) {
    const slot = `chess_char_${tier}_diy1_a`;
    const pick = { charId: 'char_4042_lumen', skillIndex };
    assert.equal(validateDiyPicks({ [slot]: pick }, { data: modified, kitted: KITTED_CHARS }).ok, true);
    const rec = diyRecord(slot, pick, { data: modified, elite });
    assert.deepEqual(rec.bonds, ['emptyShip']);
    assert.deepEqual(rec.garrisonIds, []);
    const h = makeBattle({ data: ds, autoFinish: false, units: [{ diy: { slot, ...pick }, elite, row: 10, col: 3 }] });
    h.step();
    assert.equal(h.unit(1).skill.id, `skchr_lumen_${skillIndex + 1}`);
    assert.ok(!h.unit(1).kit.generic);
    assert.deepEqual(h.b.errors, []);
    checkInvariants(h.b);
  }
  assert.equal(validateDiyPicks({ chess_char_6_diy1_a: { charId: 'char_4231_clemnt', skillIndex: 1 } },
    { data: modified, kitted: KITTED_CHARS }).error, 'BAD_TARGET');
});

test('browser UI and browser-injected simulation resolve exactly the same roster as the server, enabled and disabled', async () => {
  for (const input of [raw, original]) {
    const store = createDataStore({
      rosterRules: true,
      fetch: async url => {
        const name = String(url).split('/').pop().replace('.json', '');
        return { ok: true, json: async () => structuredClone(input[name]) };
      },
    });
    await store.loadAll('chess', 'bonds', 'garrisons', 'backups');
    const expected = applyRosterVariant(input);
    for (const name of ['chess', 'bonds', 'garrisons', 'backups']) assert.deepEqual(store.get(name), expected[name]);
    const browser = setSimData(input);
    assert.deepEqual(browser.rawChess(C), expected.chess[C] ?? null);
    assert.deepEqual(browser.rawBackups(), expected.backups);
  }
  setSimData(modified);
});
