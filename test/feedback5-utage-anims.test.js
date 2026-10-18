// 宴's skill clips (the owner's playtest of 2026-10-07: 「干员宴的模型开局时是跪地的状态」): her one unnumbered skill set
// (Skill_Start / Skill_Loop / Skill_End, a sit-down rest) belongs to S1 分神 only; S2 — the 卫戍 default 落地斩·破门, on
// from every deployment for its duration — attacks with her ordinary clips (tools/assets/spine.js PREFAB_SPINE_ROLES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoles } from '../tools/assets/anim-roles.mjs';
import { applyRoleFix, PREFAB_SPINE_ROLES } from '../tools/assets/spine.mjs';
import { installFakePixi, fakeViewCtx } from './render/fakepixi.js';
import { presetCamera } from '../public/js/render/projection.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIPS = ['Attack', 'Die', 'Idle', 'Skill_End', 'Skill_Loop', 'Skill_Start', 'Start'];
const durations = Object.fromEntries(CLIPS.map((n) => [n, 1]));

test('宴: the resolver alone gives both skill indices the sit-down set; the role fix keeps it for S1 and attacks normally in S2', () => {
  const resolved = resolveRoles(CLIPS, { skillIndices: [1, 0], durations });
  assert.equal(resolved.skills['1'].loop, 'Skill_Loop', 'by name alone, S2 would kneel (the reported bug)');
  const { roles, missing } = applyRoleFix(resolved, PREFAB_SPINE_ROLES.char_337_utage, durations);
  assert.deepEqual(missing, []);
  assert.equal(roles.skills['0'].loop, 'Skill_Loop', 'S1 分神 keeps her rest');
  assert.equal(roles.skills['1'].loop, 'Attack');
  assert.equal(roles.skills['1'].via, 'attack', "via 'attack': the renderer plays no skill clip (render/spine.js)");
  assert.equal(roles.skill.index, 1, 'the primary (equipped by default) skill is S2');
  assert.equal(roles.skill.via, 'attack');
});

test('宴 cosmetic plugin roles: S2 never enters S1 stance, including skill slot and form resets', async () => {
  const fake = installFakePixi();
  try {
    const { SpineActor } = await import('../public/js/render/spine.js');
    // Same options as plugin skeletonClipData: no character-specific build fix.
    const anims = resolveRoles(CLIPS, { skillIndices: [0, 1, 2], durations });
    const entry = { anims, animations: durations };
    const make = (id) => new SpineActor({ animations: CLIPS.map(name => ({ name })) }, entry, id);
    const a = make('char_337_utage');
    a.setSkillIndex(1);
    a.setSkill(true);
    assert.equal(a.current, 'Idle', 'deployment buff never plays Skill_Start');
    assert.equal(a.roles.skill.via, 'attack');
    for (let n = 0; n < 3; n++) {
      a.attack(1);
      assert.equal(a.current, 'Attack');
      a.update(2);
      assert.equal(a.current, 'Idle');
    }
    a.setForm({ idle: 'Start' });
    a.setForm(null);
    assert.equal(a.roles.skill.loop, 'Attack');
    a.setSkill(false);
    a.setSkillIndex(0);
    a.setSkill(true);
    assert.equal(a.current, 'Skill_Start', 'S1 still enters its non-attacking stance');
    assert.equal(a.roles.skill.loop, 'Skill_Loop');
    assert.equal(a._attackClip(), null, 'S1 stance has no attack clip');
    const other = make('char_other');
    other.setSkillIndex(1);
    assert.equal(other.roles.skill.loop, 'Skill_Loop', 'unverified operators keep their roles');
    assert.equal(anims.skills['1'].loop, 'Skill_Loop', 'cached/shared metadata is not mutated');
    const { UnitView } = await import('../public/js/render/units.js');
    const ctx = fakeViewCtx(fake.P, {
      cam: () => presetCamera('normal', { width: 1280, height: 720 }),
      assets: { picture: () => null, spineEntry: () => entry,
        spine: { acquire: async () => ({ animations: CLIPS.map(name => ({ name })) }), release() {} } },
    });
    const view = new UnitView(ctx, { id: 1, kind: 'op', side: 'ally', spine: 'char_337_utage',
      skin: 'char_337_utage@summer#4', skillIndex: 1, maxHp: 100 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.actor.roles.skill.loop, 'Attack', 'UnitView passes the effective body for skin models');
    view.destroy();
  } finally { fake.restore(); }
});

test('宴: the shipped manifest carries the fix on both models', () => {
  const a = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
  for (const side of ['front', 'back']) {
    const an = a.chars.char_337_utage.spine[side].anims;
    assert.equal(an.skill.via, 'attack', `${side}: no kneeling during 落地斩·破门`);
    assert.equal(an.skills['1'].via, 'attack', side);
    assert.equal(an.skills['0'].loop, 'Skill_Loop', `${side}: S1 分神 sits down`);
  }
});
