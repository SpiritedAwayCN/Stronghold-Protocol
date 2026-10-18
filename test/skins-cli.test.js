import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emitSkinPlugin, emitSkinPlugins, skinPluginDir, verifySkinPlugin } from '../tools/skins-plugin.mjs';
import { catalogueJobs, officialNameOf, tokenSkinMapOf, tokenSkinFileJobs, sourceJobs } from '../tools/skins.mjs';
import { spineEntry, tokenSkinOwner } from '../public/js/assets.js';
import { locateAssetPath, readAssetOverlay } from '../shared/plugins/visual.js';
import { png, skel, atlas } from './helpers/pluginFixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'skins.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SP_SKINS_REPO: '', NODE_USE_ENV_PROXY: '1' } });

test('CLI is manual, offline-safe, and does not expose a generated-data output', () => {
  const help = run('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--import-commit/);
  assert.match(help.stdout, /read-only base manifest/);
  const local = run('local', '--offline');
  assert.equal(local.status, 1);
  assert.match(local.stdout, /local resource root required/);
  const dry = run('fetch', '--offline', '--dry-run', '--limit=1');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /no network or file writes/);
  assert.equal(run('fetch', '--offline').status, 2);
  assert.equal(run('plan', '--offline', '--probe').status, 2);
  assert.throws(() => skinPluginDir(ROOT, 'data'), /plugins/);
});

test('offline catalogue and official token maps preserve exact skin ids and all file alternatives', async () => {
  const authored = await sourceJobs();
  assert.ok(authored.from.endsWith('skins-catalogue.json'));
  assert.ok(authored.jobs.length > 0);
  const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'research', '08-skins-catalogue.json')));
  assert.ok(catalogueJobs(bundled).length > 500, 'bundled offline metadata preserves the full original catalogue');
  const table = { charSkins: { 'char_100_x@ambienceSynesthesia#4': {
    skinId: 'char_100_x@ambienceSynesthesia#4', displaySkin: { skinName: 'Outfit', skinGroupName: 'Series' },
    tokenSkinMap: [{ tokenId: 'token_x', tokenSkinId: 'token_x_ambienceSynesthesia#4' }, null, { bad: 1 }],
  } } };
  const jobs = catalogueJobs({ chars: { char_100_x: [{ id: 'char_100_x@ambienceSynesthesia#4', name: 'Outfit' }] } });
  assert.equal(jobs[0].skinId, 'char_100_x@ambienceSynesthesia#4');
  assert.ok(jobs[0].spine.variants.length);
  assert.equal(officialNameOf(table, 'char_100_x_ambienceSynesthesia_4').id, jobs[0].skinId);
  assert.equal(tokenSkinMapOf(table, jobs[0].skinId).length, 1);
  const tasks = tokenSkinFileJobs([...jobs, ...jobs], table);
  assert.equal(tasks.length, 3, 'one download per file, even when several outfits name it');
  assert.ok(tasks.every((t) => t.urls.length === 2 && t.urls[0].includes('/Spine/') && t.urls[1].includes('/Front/')));
});

test('skin token models are checked overlay fields; default and missing-art fallbacks remain intact', () => {
  const at = ['chars', 'char_100_x', 'skins', 'char_100_x@series#1', 'tokens', 'token_x', 'spine'];
  assert.equal(locateAssetPath(at).kind, 'spine');
  const file = { skel: 'm/t.skel', atlas: 'm/t.atlas', textures: ['m/t.png'] };
  const overlay = { chars: { char_100_x: { skins: { 'char_100_x@series#1': { name: 'Outfit', tokens: { token_x: { tokenSkinId: 'token_x_series#1', spine: file } } } } } } };
  const read = readAssetOverlay(overlay, { vanilla: { chars: { char_100_x: {} } }, permissions: ['assets.override'], has: () => true });
  assert.deepEqual(read.problems, []);
  assert.ok(read.ops.some((op) => op.at.join('.') === at.join('.')));
  const own = { skel: '/base.skel', atlas: '/base.atlas', anims: { idle: 'Idle' } };
  const worn = { ...own, skel: '/skin.skel' };
  const m = { tokens: { token_x: { spine: own } }, chars: { char_100_x: { skins: { s: { tokens: { token_x: { spine: worn } } } } } } };
  assert.equal(tokenSkinOwner(m, 'token_x'), 'char_100_x', 'cosmetic mapping supports summons with no vanilla owner');
  assert.equal(spineEntry(m, 'token_x', { skin: 's' }).skel, worn.skel);
  assert.equal(spineEntry(m, 'token_x', { skin: 's' }).fallback, own);
  assert.equal(spineEntry(m, 'token_x', { skin: 'missing' }), own);
});

test('emitter copies only existing art, rewrites unsafe dump filenames, packs and repairs a cosmetic plugin', () => {
  const id = `skin-cli-test-${process.pid}`;
  const art = path.join(ROOT, 'public', 'assets', id);
  const out = path.join(ROOT, 'plugins', id);
  const before = fs.readFileSync(path.join(ROOT, 'data', 'assets.json'));
  fs.mkdirSync(art, { recursive: true });
  try {
    fs.writeFileSync(path.join(art, 'outfit#1.png'), png());
    fs.writeFileSync(path.join(art, 'outfit#1.skel'), skel({ animations: { Idle: [['OnStart', 1]], Skill_3_Loop: [['OnAttack', 0.5]] } }));
    fs.writeFileSync(path.join(art, 'outfit#1.atlas'), '\n\n' + atlas(['outfit#1.png']));
    const prefix = `/assets/${id}/outfit#1`;
    const source = { chars: { char_102_texas: { avatar: '/do-not-override.png', skins: {
      'char_102_texas@series#1': { name: 'Outfit', avatar: prefix + '.png', spine: { front: { skel: prefix + '.skel', atlas: prefix + '.atlas', textures: [prefix + '.png'] } } },
      unavailable: { name: 'Absent', avatar: '/assets/not-installed.png' },
    } } } };
    assert.equal(emitSkinPlugin({ root: ROOT, source, output: out, dryRun: true }).skins, 1);
    assert.equal(fs.existsSync(out), false);
    const result = emitSkinPlugin({ root: ROOT, source, output: out });
    assert.equal(result.skins, 1);
    const overlay = JSON.parse(fs.readFileSync(path.join(out, 'skins.json')));
    assert.deepEqual(Object.keys(overlay.chars.char_102_texas), ['skins']);
    assert.equal(verifySkinPlugin({ root: ROOT, output: out }).problems.length, 0);
    const lock = JSON.parse(fs.readFileSync(path.join(out, 'plugin.lock.json')));
    const atlasFile = Object.keys(lock.files).find((p) => p.endsWith('.atlas'));
    const atlasText = fs.readFileSync(path.join(out, atlasFile), 'utf8');
    assert.ok(!atlasText.startsWith('\n'), 'import removes the leading blank lines that break pixi-spine');
    assert.ok(!atlasText.includes('outfit#1.png'), 'only page references follow safe filename rewrites');
    assert.ok(Object.values(lock.spine)[0].anims.skills['2'], 'official pack resolves numbered outfit clips');
    const image = Object.keys(lock.files).find((p) => p.endsWith('.png'));
    fs.appendFileSync(path.join(out, image), Buffer.from([1]));
    assert.ok(verifySkinPlugin({ root: ROOT, output: out }).problems.length > 0, 'changed art invalidates its lock');
    assert.equal(verifySkinPlugin({ root: ROOT, output: out, fix: true }).problems.length, 0);
    const second = { ...source, chars: { ...source.chars, char_103_angel: source.chars.char_102_texas } };
    const split = emitSkinPlugins({ root: ROOT, source: second, output: out, maxBytes: 1 });
    assert.equal(split.results.length, 2, 'large collections split at operator boundaries');
    assert.ok(fs.existsSync(out + '-2'));
    emitSkinPlugins({ root: ROOT, source, output: out });
    assert.equal(fs.existsSync(out + '-2'), false, 'shrinking a collection removes obsolete tool-owned packs');
    assert.deepEqual(fs.readFileSync(path.join(ROOT, 'data', 'assets.json')), before);
  } finally {
    fs.rmSync(art, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(out + '-2', { recursive: true, force: true });
  }
});
