import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource } from '../../server/sim/simdata.js';
import { TOKEN_IDS } from '../../server/sim/content/tokens.js';

const ds = getDefaultSource();
const approx = (a, b) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${a} ~= ${b}`);
const clean = (h) => { assert.deepEqual(h.b.errors, []); checkInvariants(h.b); };
const control = chessRec({ id: 'control', profession: 'TANK', skill: null, stats: { atk: 0, maxHp: 10000 } });
const filler = chessRec({ id: 'filler', profession: 'SNIPER', skill: null, stats: { atk: 0 } });
const arena = (units, extra = {}) => makeBattle({
  autoFinish: false, timeLimit: 200, hooks: ['heal', 'hpRegen'], captureNoisy: true,
  defs: { chess: { control, filler } }, units, ...extra,
});
const injured = (u) => { u.hp = u.s.maxHp * 0.4; return u.hp; };
const forbidHealing = (h, u) => h.b.addBuff(u, {
  key: 'test:healing', flags: { noHeal: true, healFree: true },
  mods: { healingDealtMul: 3, healingTakenMul: 4 },
});
const casts = (u) => assert.ok(u.skill.activate('test', { free: true }), `${u.name}: skill activates`);
const recovered = (h, source, target) => h.hooksOf('hpRegen').filter((c) => c.source === source && c.target === target);
const entry = (chessId, skillIndex = null, row = 10, col = 4, extra = {}) =>
  ({ chessId, skillIndex, row, col, dir: 'RIGHT', carryState: { sp: 0 }, ...extra });

test('HP regeneration ignores both heal prohibitions and healing multipliers, but ordinary healing does not', () => {
  const h = arena([entry('control'), entry('filler', null, 10, 5)], { content: 'none' });
  h.step(2);
  const s = h.unit('filler'), t = h.unit('control');
  h.b.addBuff(s, { key: 'test:out', mods: { healingDealtMul: 3 } });
  injured(t);
  forbidHealing(h, t);
  assert.equal(h.b.heal(s, t, 100), 0);
  assert.equal(h.b.heal(t, t, 100, { self: true }), 0);
  assert.equal(h.b.regenerateHp(s, t, 100), 100);
  assert.equal(h.hooksOf('heal').length, 0);
  assert.equal(recovered(h, s, t).length, 1);
  h.b.removeBuff(t, 'test:healing');
  h.b.addBuff(t, { key: 'test:in', mods: { healingTakenMul: 4 } });
  assert.equal(h.b.heal(s, t, 100), 1200);
  assert.equal(h.b.regenerateHp(s, t, 100), 100);
  clean(h);
});

test('HP regeneration has its own mutable hook, caps HP and retains statistics and client events', () => {
  const h = arena([entry('control'), entry('filler', null, 10, 5)], { content: 'none' });
  h.step(2);
  const s = h.unit('filler'), t = h.unit('control');
  injured(t);
  h.b.on('heal', (c) => { c.amount *= 10; });
  h.b.on('hpRegen', (c) => { c.amount *= 1.5; });
  const stat = s.stats.heal, tally = h.result().perPlayer.p1.healingDone;
  assert.equal(h.b.regenerateHp(s, t, 100), 150);
  approx(s.stats.heal - stat, 150);
  approx(h.result().perPlayer.p1.healingDone - tally, 150);
  assert.ok(h.eventsOf('heal').some((e) => e[1] === t.id && e[2] === 150));
  t.hp = t.s.maxHp - 0.25;
  assert.equal(h.b.regenerateHp(s, t, 100, { overheal: true }), 0.25);
  assert.equal(t.hp, t.s.maxHp);
  assert.equal(t.findBuff('overheal'), null);
  assert.equal(h.b.regenerateHp(s, t, 100), 0);
  for (const amount of [0, -1, NaN, Infinity]) assert.equal(h.b.regenerateHp(s, t, amount), 0);
  t.deployed = false;
  assert.equal(h.b.regenerateHp(s, t, 100), 0);
  t.deployed = true;
  clean(h);
});

test('a recovery hook cannot restore a target it retreats; legacy regen opts use the new channel', () => {
  const h = arena([entry('control'), entry('filler', null, 10, 5)], { content: 'none' });
  h.step(2);
  const s = h.unit('filler'), t = h.unit('control');
  injured(t);
  forbidHealing(h, t);
  assert.equal(h.b.heal(s, t, 100, { regen: true }), 100);
  assert.equal(h.hooksOf('heal').length, 0);
  h.b.on('hpRegen', () => h.b.retreat(t));
  const hp = t.hp;
  assert.equal(h.b.regenerateHp(s, t, 100), 0);
  assert.equal(t.hp, hp);
  clean(h);
});

test('recovery-specific reductions apply to both pulse and natural regeneration, not healing-only modifiers', () => {
  const h = arena([entry('control')], { content: 'none' });
  h.step(2);
  const t = h.unit('control');
  injured(t);
  forbidHealing(h, t);
  h.b.addBuff(t, { key: 'test:regen', mods: { hpRegen: 100, hpRegenMul: 0.5 } });
  assert.equal(h.b.regenerateHp(t, t, 100), 50);
  const hp = t.hp;
  h.run(1);
  approx(t.hp - hp, 50);
  assert.equal(h.hooksOf('heal').length, 0);
  clean(h);
});

const providers = ['chess_char_6_04', 'chess_char_4_25', 'chess_char_5_09', 'chess_char_2_14'];
const targets = ['chess_char_5_06_a', 'chess_char_5_01_a', 'chess_char_4_18_a', 'chess_char_2_17_a', 'chess_char_1_18_a'];
for (const base of providers) for (const variant of ['a', 'b']) for (const target of targets) {
  const id = `${base}_${variant}`;
  test(`${ds.rawChess(id).name} ${variant}: regeneration reaches ${ds.rawChess(target).name} under healFree`, () => {
    const h = arena([entry(id), entry(target, null, 9, 5)]);
    h.run(0.2);
    const s = h.unit(id), t = h.unit(target);
    assert.ok(s.rangeKeySet.has(t.tileR * 21 + t.tileC));
    const hp = injured(t);
    forbidHealing(h, t);
    h.run(3.1);
    const pulses = recovered(h, s, t);
    assert.ok(pulses.length >= 3);
    approx(t.hp - hp, pulses.reduce((n, c) => n + c.amount, 0));
    assert.ok(!h.hooksOf('heal').some((c) => c.source === s && c.target === t));
    assert.equal(h.b.heal(s, t, 100), 0);
    clean(h);
  });
}

const skillPulses = [
  ['chess_char_5_10', 2, 'S3'],
  ['chess_char_3_12', 1, 'S2'],
  ['chess_char_2_19', 1, 'S2'],
  ['chess_char_1_16', 1, 'hidden S2'],
  ['chess_char_5_15', 0, 'S1'],
  ['chess_char_5_15', 1, 'S2'],
  ['chess_char_6_04', 0, 'S1'],
  ['chess_char_6_04', 1, 'S2'],
  ['chess_char_4_25', 0, 'S1'],
  ['chess_char_4_25', 2, 'S3'],
];
for (const [base, skillIndex, label] of skillPulses) for (const variant of ['a', 'b']) {
  const id = `${base}_${variant}`;
  test(`${ds.rawChess(id).name} ${variant} ${label}: active recovery is not a treatment`, () => {
    const h = arena([entry(id, skillIndex), entry('chess_char_4_18_a', null, 10, 5)]);
    h.run(0.2);
    const s = h.unit(id), t = h.unit('chess_char_4_18_a');
    injured(t);
    forbidHealing(h, t);
    casts(s);
    h.run(3.1);
    assert.ok(recovered(h, s, t).length > 0);
    assert.ok(!h.hooksOf('heal').some((c) => c.source === s && c.target === t));
    clean(h);
  });
}

test('bard recovery respects isolated targets, while Yu S3 keeps its explicit isolation exemption', () => {
  const h = arena([
    entry('chess_char_4_25_a'), entry('chess_char_6_03_a', 2, 11, 4),
    entry('control', null, 10, 5), entry('filler', null, 9, 4),
  ]);
  h.run(0.2);
  const bard = h.unit('chess_char_4_25_a'), yu = h.unit('chess_char_6_03_a'), t = h.unit('control');
  const hp = injured(t);
  forbidHealing(h, t);
  h.b.addBuff(t, { key: 'test:isolated', flags: { isolated: true } });
  h.run(1.1);
  assert.equal(t.hp, hp);
  assert.equal(recovered(h, bard, t).length, 0);
  t.elem.erosion = 500;
  casts(yu);
  h.run(1.1);
  assert.ok(recovered(h, yu, t).length > 0);
  assert.ok(t.elem.erosion < 500);
  clean(h);
});

test('Skadi seaborn range extension regenerates a prohibited target without double-counting overlapping coverage', () => {
  const h = arena([entry('chess_char_6_04_a', 1), entry('chess_char_4_18_a', null, 10, 7)]);
  h.run(0.2);
  const s = h.unit('chess_char_6_04_a'), t = h.unit('chess_char_4_18_a');
  assert.ok(!s.rangeKeySet.has(t.tileR * 21 + t.tileC));
  assert.ok(h.b.spawnToken(s, TOKEN_IDS.seaborn, 10, 6));
  const hp = injured(t);
  forbidHealing(h, t);
  h.run(3.1);
  const pulses = recovered(h, s, t);
  assert.equal(pulses.length, 3);
  approx(t.hp - hp, pulses.reduce((n, c) => n + c.amount, 0));
  clean(h);
});

test('Skadi S3 replaces regeneration rather than leaving the healing trait active', () => {
  const h = arena([entry('chess_char_6_04_a', 2), entry('control', null, 10, 5)]);
  h.run(0.2);
  const s = h.unit('chess_char_6_04_a'), t = h.unit('control');
  const hp = injured(t);
  casts(s);
  h.run(3.1);
  assert.equal(t.hp, hp);
  assert.equal(recovered(h, s, t).length, 0);
  clean(h);
});

const selfSkills = [
  ['chess_char_1_02_a', 0], ['chess_char_1_18_a', 0],
  ['chess_char_3_16_a', 1], ['chess_char_4_22_a', 1], ['chess_char_5_17_a', 1],
];
for (const [id, skillIndex] of selfSkills) test(`${ds.rawChess(id).name}: self regeneration ignores treatment modifiers`, () => {
  const h = arena([entry(id, skillIndex)]);
  h.run(0.2);
  const u = h.unit(id);
  forbidHealing(h, u);
  casts(u);
  const hp = injured(u), rate = u.s.hpRegen;
  assert.ok(rate > 0);
  h.run(1);
  approx(u.hp - hp, rate);
  assert.equal(h.hooksOf('heal').length, 0);
  clean(h);
});

for (const id of ['chess_char_2_07_b', 'chess_char_4_05_a', 'chess_char_3_18_a']) {
  test(`${ds.rawChess(id).name}: conditional talent regeneration uses the same channel`, () => {
    const h = arena([entry(id)]);
    h.run(5);
    const u = h.unit(id);
    forbidHealing(h, u);
    const hp = injured(u), rate = u.s.hpRegen;
    assert.ok(rate > 0);
    h.run(1);
    approx(u.hp - hp, rate);
    assert.equal(h.hooksOf('heal').length, 0);
    clean(h);
  });
}

test('Angelina, Gladiia and Silverash alter recovery attributes without losing their target conditions', () => {
  for (const [id, target] of [
    ['chess_char_5_20_a', 'control'],
    ['chess_char_4_12_a', 'chess_char_2_07_b'],
    ['chess_char_5_14_a', 'chess_char_4_22_a'],
  ]) {
    const h = arena([entry(id), entry(target, null, 10, 5), entry('filler', null, 11, 5)]);
    h.run(0.5);
    const t = h.unit(target), other = h.unit('filler');
    forbidHealing(h, t);
    const hp = injured(t), rate = t.s.hpRegen;
    assert.ok(rate > 0);
    if (id !== 'chess_char_5_20_a') assert.equal(other.s.hpRegen, 0);
    h.run(1);
    approx(t.hp - hp, rate);
    clean(h);
  }
});

test('Mudrock receives HP redistribution independently of her healing prohibition', () => {
  const h = arena([entry('chess_char_4_25_a', 2), entry('chess_char_4_18_a', null, 10, 5)]);
  h.run(0.2);
  const s = h.unit('chess_char_4_25_a'), t = h.unit('chess_char_4_18_a');
  casts(s);
  h.run(0.1);
  injured(t);
  forbidHealing(h, t);
  h.b.addBuff(t, { key: 'test:noRegen', mods: { hpRegenMul: 0 } });
  h.run(2.1);
  approx(s.hp / s.s.maxHp, t.hp / t.s.maxHp);
  clean(h);
});

test('Mizuki Integrated Strategy module is fully declared but never installed in Stronghold', () => {
  const id = 'chess_char_4_09_b', moduleId = 'uniequip_004_mizuki';
  const h = arena([entry(id, 1, 10, 4, { moduleId })]);
  h.run(0.2);
  const u = h.unit(id), mb = u.def.talents.find((t) => !t.name && t.bb.hp_recovery_per_sec_by_max_hp_ratio)?.bb;
  assert.ok(mb);
  assert.deepEqual(u.kit.modeOnlyMods.integratedStrategy, {
    aspd: mb.attack_speed, hpRegenRatio: mb.hp_recovery_per_sec_by_max_hp_ratio, spRecoveryFlat: mb.sp_recovery_per_sec,
  });
  const hp = injured(u);
  h.run(3);
  assert.equal(u.hp, hp);
  assert.equal(u.s.hpRegen, 0);
  assert.equal(u.s.aspd, u.base.aspd);
  assert.equal(u.s.spRecovery, u.base.spRecovery);
  clean(h);
});

test('ordinary treatment skills remain prohibited; Lumen does not become regeneration', () => {
  for (const [id, skillIndex] of [['chess_char_5_11_a', 2], ['chess_char_6_14_a', 0]]) {
    const h = arena([entry(id, skillIndex), entry('control', null, 10, 5)]);
    h.run(0.2);
    const s = h.unit(id), t = h.unit('control');
    const hp = injured(t);
    forbidHealing(h, t);
    casts(s);
    h.run(3.1);
    assert.equal(t.hp, hp);
    assert.equal(recovered(h, s, t).length, 0);
    clean(h);
  }
});

test('Blaze revival regeneration works under healFree and never becomes an ordinary heal', () => {
  const h = arena([entry('chess_char_5_03_a')]);
  h.run(0.2);
  const u = h.unit('chess_char_5_03_a');
  h.b.dealDamage(null, u, { amount: 1e8, type: 'true', canDodge: false });
  assert.ok(u.mem.downed);
  forbidHealing(h, u);
  const hp = u.hp, rate = u.s.hpRegen;
  h.run(1);
  approx(u.hp - hp, rate);
  assert.ok(h.runUntil(() => !u.mem.downed, 40));
  assert.equal(u.hp, u.s.maxHp);
  clean(h);
});

test('generic bard traits regenerate on healFree without installing an operator-specific kit', () => {
  const bard = chessRec({ id: 'bard', profession: 'SUPPORT', subProfessionId: 'bard', stats: { atk: 1000 } });
  const h = arena([entry('bard'), entry('control', null, 10, 5)], {
    content: 'none', defs: { chess: { bard, control } },
  });
  h.run(0.2);
  const s = h.unit('bard'), t = h.unit('control');
  const hp = injured(t);
  forbidHealing(h, t);
  h.run(3.1);
  const pulses = recovered(h, s, t);
  assert.equal(pulses.length, 3);
  for (const c of pulses) approx(c.amount, 100);
  approx(t.hp - hp, 300);
  clean(h);
});

test('Tinman zones retain cached ATK, stacking and lifetime after the source retreats, but do not select isolated allies', () => {
  const h = arena([
    entry('chess_char_2_19_a', 1), entry('chess_char_4_18_a', null, 10, 5), entry('control', null, 9, 5),
  ]);
  h.run(0.2);
  const s = h.unit('chess_char_2_19_a'), t = h.unit('chess_char_4_18_a'), other = h.unit('control');
  const hp = injured(t), otherHp = injured(other), atk = s.s.atk;
  forbidHealing(h, t);
  h.b.addBuff(other, { key: 'test:isolated', flags: { isolated: true } });
  casts(s);
  h.b.addBuff(s, { key: 'test:atk', mods: { atkMul: 2 } });
  casts(s);
  h.b.addBuff(s, { key: 'test:atk2', mods: { atkMul: 2 } });
  h.b.retreat(s);
  h.run(1.1);
  const ratio = s.def.skill.bb.hp_recovery_per_sec_ratio;
  const pulses = recovered(h, s, t);
  assert.equal(pulses.length, 4, 'both zones pulse again after retreat');
  approx(pulses[0].amount, atk * ratio);
  approx(pulses[1].amount, atk * 2 * ratio);
  approx(pulses[2].amount, atk * ratio);
  approx(pulses[3].amount, atk * 2 * ratio);
  approx(t.hp - hp, atk * 6 * ratio);
  assert.equal(other.hp, otherHp);
  clean(h);
});

test('Thorns S2 reduces both healing and regeneration using its existing healing reduction value', () => {
  const e = enemyRec({ key: 'e', hp: 100000, atk: 0, speed: 0 });
  const h = arena([entry('chess_char_5_15_a', 1)], {
    defs: { enemies: { e } }, enemies: [{ key: 'e', pos: [10, 5] }],
  });
  h.run(0.2);
  const s = h.unit('chess_char_5_15_a'), t = h.enemies()[0];
  casts(s);
  h.run(0.2);
  const mul = s.def.skill.bb.heal_scale;
  assert.ok(mul < 1);
  approx(t.s.healingTakenMul, mul);
  approx(t.s.hpRegenMul, mul);
  t.hp = t.s.maxHp * 0.5;
  approx(h.b.heal(s, t, 100), 100 * mul);
  approx(h.b.regenerateHp(s, t, 100), 100 * mul);
  clean(h);
});

test('Muelsyse melee Flowing Shape recovers through its existing healing prohibition and dynamic healFree', () => {
  const h = arena([
    entry('chess_char_6_11_a', 1, 10, 3, { uid: 1 }),
    entry('control', null, 11, 5),
    { kind: 'token', tokenId: 'token_10030_mlyss_wtrman', row: 10, col: 5, ownerUid: 1 },
  ]);
  assert.ok(h.runUntil(() => h.b.allyUnits.some((u) => u.defId === 'token_10030_mlyss_wtrman' && u.mem.mlyss), 10));
  const s = h.unit('chess_char_6_11_a'), t = h.b.allyUnits.find((u) => u.defId === 'token_10030_mlyss_wtrman');
  assert.ok(t?.mem.mlyss && !t.mem.mlyss.ranged);
  assert.ok(t.def.abnormal.includes('healFree') && t.s.flags.noHeal);
  forbidHealing(h, t);
  casts(s);
  h.run(0.3);
  const hp = injured(t), rate = t.s.hpRegen;
  assert.ok(rate > 0);
  h.run(1);
  approx(t.hp - hp, rate);
  assert.equal(h.b.heal(s, t, 100), 0);
  clean(h);
});

test('Lumen rain HoT remains healing and stops restoring HP during healFree', () => {
  const h = arena([entry('chess_char_6_14_a', 0), entry('control', null, 10, 5)]);
  h.run(0.2);
  const s = h.unit('chess_char_6_14_a'), t = h.unit('control');
  injured(t);
  casts(s);
  h.b.forceAttack(s, [t]);
  h.run(0.2);
  assert.ok(t.findBuff(`lumen:rain:${s.id}`));
  forbidHealing(h, t);
  const hp = t.hp;
  h.run(1.1);
  assert.equal(t.hp, hp);
  assert.equal(recovered(h, s, t).length, 0);
  h.b.removeBuff(t, 'test:healing');
  h.b.addBuff(s, { key: 'test:disarm', flags: { disarm: true } });
  h.run(1.1);
  assert.ok(h.hooksOf('heal').some((c) => c.source === s && c.target === t && c.opts.hot));
  clean(h);
});

for (const variant of ['a', 'b']) {
  const id = `chess_char_6_20_${variant}`;
  for (const restriction of ['healFree', 'noHeal', 'profile.noHeal']) {
    test(`Eyja ${variant} mist: ${restriction} blocks both recovery amounts without removing or refreshing the buff`, () => {
      const h = arena([entry(id, 2), entry('control', null, 10, 5)]);
      h.run(0.6);
      const s = h.unit(id), t = h.unit('control');
      const hp = injured(t), atk = s.s.atk;
      for (let i = 0; i < 3; i++) h.b.heal(s, t, 1);
      const mist = t.findBuff(`agoat2:mist:${s.id}`), left = mist.timeLeft;
      assert.equal(mist.stacks, 3);
      const amount = atk * s.def.talents[0].bb.heal_scale * mist.stacks;
      const epAmount = amount * s.profile.heal.elementHealRatio;
      h.b.addBuff(s, { key: 'test:disarm', flags: { disarm: true }, mods: { atkMul: 2 } });
      if (restriction === 'profile.noHeal') t.profile.noHeal = true;
      else h.b.addBuff(t, { key: 'test:healing', flags: { [restriction]: true } });
      const gauges = ['erosion', 'burn', 'neural', 'apoptosis'];
      for (const k of gauges) t.elem[k] = 900;
      h.run(1.1);
      assert.equal(t.hp, hp + 3);
      for (const k of gauges) assert.equal(t.elem[k], 900);
      assert.equal(t.findBuff(mist.key), mist);
      assert.equal(mist.stacks, 3);
      approx(mist.timeLeft, left - 1.1);
      approx(mist.data.atk, atk);
      assert.equal(recovered(h, s, t).length, 0);
      assert.ok(!h.hooksOf('heal').some((c) => c.source === s && c.target === t && c.opts.hot));
      if (restriction === 'profile.noHeal') t.profile.noHeal = false;
      else h.b.removeBuff(t, 'test:healing');
      h.run(1);
      approx(t.hp - hp - 3, amount);
      for (const k of gauges) approx(900 - t.elem[k], epAmount);
      const hot = h.hooksOf('heal').filter((c) => c.source === s && c.target === t && c.opts.hot);
      assert.equal(hot.length, 1);
      approx(hot[0].amount, amount);
      assert.equal(mist.stacks, 3);
      approx(mist.timeLeft, left - 2.1);
      clean(h);
    });
  }

  for (const restriction of ['noHeal', 'healFree']) {
    test(`Eyja ${variant} self mist: ${restriction} preserves the ordinary self-healing rule`, () => {
      const h = arena([entry(id, 2)]);
      h.run(0.6);
      const u = h.unit(id);
      injured(u);
      h.b.heal(u, u, 1);
      const mist = u.findBuff(`agoat2:mist:${u.id}`), hp = u.hp;
      const amount = mist.data.atk * u.def.talents[0].bb.heal_scale;
      h.b.addBuff(u, { key: 'test:healing', flags: { [restriction]: true, disarm: true } });
      u.elem.erosion = 900;
      h.run(1.1);
      approx(u.hp - hp, restriction === 'healFree' ? 0 : amount);
      approx(900 - u.elem.erosion, restriction === 'healFree' ? 0 : amount * u.profile.heal.elementHealRatio);
      assert.equal(u.findBuff(mist.key), mist);
      clean(h);
    });
  }

  test(`Eyja ${variant} mist restores elemental damage at full HP without using actual HP restored as a gate`, () => {
    const h = arena([entry(id, 2), entry('control', null, 10, 5)]);
    h.run(0.6);
    const s = h.unit(id), t = h.unit('control');
    assert.equal(h.b.heal(s, t, 1), 0);
    const mist = t.findBuff(`agoat2:mist:${s.id}`), hp = t.hp;
    h.b.addBuff(s, { key: 'test:disarm', flags: { disarm: true } });
    t.elem.erosion = 900;
    h.run(1.1);
    assert.equal(t.hp, hp);
    approx(900 - t.elem.erosion, mist.data.atk * s.def.talents[0].bb.heal_scale * s.profile.heal.elementHealRatio);
    clean(h);
  });

  test(`Eyja ${variant} S1 independent elemental recovery still ignores healFree`, () => {
    const h = arena([entry(id, 0), entry('control', null, 10, 5)]);
    h.run(0.6);
    const s = h.unit(id), t = h.unit('control');
    casts(s);
    h.b.addBuff(s, { key: 'test:disarm', flags: { disarm: true } });
    forbidHealing(h, t);
    const hp = injured(t);
    t.elem.erosion = 900;
    h.run(1);
    assert.equal(t.hp, hp);
    assert.equal(t.findBuff(`agoat2:mist:${s.id}`), null);
    approx(900 - t.elem.erosion, s.s.atk * s.def.skill.bb['agoat2_s_1[aura].ep_heal_ratio']);
    clean(h);
  });
}

test('regeneration rejects dead, removed and boss-pool targets, including targets removed in its hook', () => {
  const h = arena([entry('control')], { content: 'none' });
  h.run(0.2);
  const t = h.unit('control');
  const hp = injured(t);
  for (const [key, value] of [['alive', false], ['removed', true], ['bossPool', {}]]) {
    const before = t[key];
    t[key] = value;
    assert.equal(h.b.regenerateHp(t, t, 100), 0);
    assert.equal(t.hp, hp);
    t[key] = before;
  }
  h.b.on('hpRegen', () => h.b.dealDamage(null, t, { amount: 1e8, type: 'true', canDodge: false }));
  assert.equal(h.b.regenerateHp(t, t, 100), 0);
  assert.equal(t.hp, 0);
  assert.ok(!t.alive);
  clean(h);
});
