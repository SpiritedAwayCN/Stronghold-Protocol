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
import { setGameData, bondLayers, unitBonds } from '../server/sim/content/support/index.js';
import { createDataStore } from '../public/js/data.js';
import { loadBrowserSim } from '../public/js/battle/runner.js';
import { makeBattle, checkInvariants, enemyRec } from './helpers/battleHarness.js';

const raw = Object.fromEntries(['config', 'chess', 'backups', 'garrisons', 'bonds', 'items', 'effects']
  .map(name => [name, JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url)))]));
const original = { ...raw, config: { ...raw.config, clemntRosterVersion: 'original' } };
const modified = applyRosterVariant(raw);
const C = 'chess_char_6_clemnt_a', L = 'chess_char_6_14_a';

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

test('Clement erosion trait gains own active bonds, including equipment grants and backup, with per-battle caps', () => {
  setGameData(modified);
  try {
    const items = Object.entries(raw.items).filter(([, r]) => r.canGiveBond || r.giveBondId === 'sargonShip')
      .filter(([id]) => id.endsWith('_a')).map(([id]) => id);
    for (const elite of [false, true]) for (const standIn of [false, true]) {
      const state = (active = true) => ({ count: active ? 3 : 0, active, tier: active ? 1 : 0, layers: 5 });
      const h = makeBattle({
        data: new DataSource(modified), autoFinish: false,
        units: [{ chessId: elite ? 'chess_char_6_clemnt_b' : C, standIn, items, row: 10, col: 3 }],
        bonds: { egirShip: state(), swiftShip: state(false), sargonShip: state(), preciShip: state() },
      });
      h.step();
      const unit = h.unit(1), n = elite ? 2 : 1;
      assert.ok(unitBonds(unit).includes('sargonShip'), 'equipment-granted bond is part of own bonds');
      const layers = id => bondLayers(h.b, 'p1', id);
      const burst = target => h.b.emit('elementBurst', { source: null, target, element: 'erosion' });
      const foe = h.spawn(enemyRec({ hp: 1e8, atk: 0 }), { pos: [10, 12] });
      h.b.emit('elementBurst', { target: foe, element: 'necrosis' });
      assert.equal(layers('egirShip'), 5);
      burst(foe); burst(unit);
      assert.equal(layers('egirShip'), 5 + 2 * n);
      assert.equal(layers('sargonShip'), 5 + 2 * n);
      assert.equal(layers('swiftShip'), 5, 'inactive own bond receives nothing');
      assert.equal(layers('preciShip'), 5, 'unrelated active bond receives nothing');
      unit.deployed = false; burst(foe); unit.deployed = true;
      assert.equal(layers('egirShip'), 5 + 2 * n, 'trait owner must be on field');
      h.b.flags.layerGainsEnabled = false; burst(foe); h.b.flags.layerGainsEnabled = true;
      assert.equal(layers('egirShip'), 5 + 2 * n, 'disabled layer gains do not consume cap');
      for (let i = 0; i < 20; i++) burst(foe);
      assert.equal(layers('egirShip'), 5 + 12 * n);
      assert.equal(layers('sargonShip'), 5 + 12 * n);
      assert.equal(unit.findBuff(`gar:garrison_clemnt_${elite ? 'b' : 'a'}`), null, 'old ATK reader is removed');
      assert.deepEqual(h.b.errors, []);
      checkInvariants(h.b);
    }
  } finally { setGameData(null); }
});

test('Clement trait listens to resolved erosion bursts, not gauge hits or burst cooldown hits', () => {
  setGameData(modified);
  try {
    const h = makeBattle({ data: new DataSource(modified), autoFinish: false,
      units: [{ chessId: C, row: 10, col: 3 }],
      bonds: { egirShip: { count: 3, active: true, tier: 1, layers: 0 } } });
    h.step();
    const unit = h.unit(1), foe = h.spawn(enemyRec({ hp: 1e8, atk: 0 }), { pos: [10, 12] });
    const hit = (source, target, amount) => h.b.dealDamage(source, target, { amount, type: 'element', element: 'erosion' });
    hit(unit, foe, 1);
    assert.equal(bondLayers(h.b, 'p1', 'egirShip'), 0);
    hit(unit, foe, foe.gaugeMax * 100);
    assert.equal(bondLayers(h.b, 'p1', 'egirShip'), 1);
    hit(unit, foe, foe.gaugeMax * 100);
    assert.equal(bondLayers(h.b, 'p1', 'egirShip'), 1);
    hit(foe, unit, unit.gaugeMax * 100);
    assert.equal(bondLayers(h.b, 'p1', 'egirShip'), 2, 'ally burst also triggers before burst damage resolves');
    assert.deepEqual(h.b.errors, []);
    checkInvariants(h.b);
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

test('production browser sim loader deploys the configured roster, including elites, backups and Lumen DIY', async () => {
  const base = new URL('../server/sim/', import.meta.url).href;
  try {
    for (const input of [raw, original]) {
      const fetched = new Set();
      const { ds } = await loadBrowserSim({
        base,
        fetchFn: async url => {
          const name = String(url).split('/').pop().replace('.json', '');
          fetched.add(name);
          const value = name === 'config' ? input.config
            : JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url)));
          return { ok: true, json: async () => structuredClone(value) };
        },
      });
      const enabled = input.config.clemntRosterVersion === 'modified';
      const expected = new DataSource(input);
      const id = enabled ? C : L;
      assert.deepEqual(ds.rawChess(id), expected.rawChess(id));
      assert.ok(fetched.has('config'), 'the battle loader must fetch roster switches, not rely on UI data');
      for (const elite of [false, true]) for (const standIn of [false, true]) {
        const chessId = elite ? id.replace(/_a$/, '_b') : id;
        assert.deepEqual(ds.getChess(chessId, { standIn }), expected.getChess(chessId, { standIn }));
        const h = makeBattle({ data: ds, autoFinish: false, units: [{ chessId, standIn, row: 10, col: 3 }] });
        assert.equal(h.b.allyUnits.length, 1, 'the board operator must not disappear at battle creation');
        h.step();
        assert.equal(h.unit(1).deployed, true);
        assert.deepEqual(h.b.errors, []);
        checkInvariants(h.b);
      }
      const charId = enabled ? 'char_4042_lumen' : 'char_4231_clemnt';
      for (const tier of [5, 6]) {
        const h = makeBattle({
          data: ds, autoFinish: false,
          units: [{ diy: { slot: `chess_char_${tier}_diy1_a`, charId, skillIndex: 1 }, row: 10, col: 3 }],
        });
        assert.equal(h.b.allyUnits.length, 1);
        h.step();
        assert.equal(h.unit(1).deployed, true);
        assert.equal(h.unit(1).def.charId, charId);
        assert.deepEqual(h.b.errors, []);
        checkInvariants(h.b);
      }
    }
  } finally {
    setSimData(modified);
    setGameData(null);
  }
});
