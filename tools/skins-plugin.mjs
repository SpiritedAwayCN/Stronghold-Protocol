// Local skin authoring only: base generated manifests are inputs, never outputs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isPackPath, isPluginId } from '../shared/plugins/manifest.js';
import { isAssetKey, isSkinKey } from '../shared/plugins/visual.js';
import { packPlugin, checkPluginFolder, buildPluginLock } from '../server/plugins/pack.js';
import { readVanillaAssets } from '../server/plugins/registry.js';
import { normalizeAtlas } from './assets/atlas.mjs';
import { pngSize } from './assets/formats.mjs';

export function skinPluginDir(root, output = 'plugins/local-skins') {
  const dir = path.resolve(root, output);
  const plugins = path.resolve(root, 'plugins');
  if (path.dirname(dir) !== plugins || !isPluginId(path.basename(dir))) throw new Error('Skin output must be plugins/<plugin-id>');
  return dir;
}

/** Split a large catalogue at operator boundaries to respect the official 200 MB per-plugin limit. */
export function emitSkinPlugins(options) {
  const { root, source, maxBytes = 170 * 1024 * 1024 } = options;
  const base = skinPluginDir(root, options.output);
  const chunks = [];
  let chars = {}, bytes = 0;
  for (const [id, rec] of Object.entries(source.chars || {})) {
    const urls = new Set();
    const walk = (v) => {
      if (typeof v === 'string' && v.startsWith('/assets/')) urls.add(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(rec.skins);
    let size = 0;
    for (const url of urls) {
      const rel = url.slice(8);
      if (rel.split('/').some((p) => p.startsWith('.') || /[\\:%?]/.test(p))) continue;
      try { size += fs.statSync(path.join(root, 'public', 'assets', ...rel.split('/'))).size; } catch { /* unavailable */ }
    }
    if (bytes + size > maxBytes && Object.keys(chars).length) { chunks.push({ chars }); chars = {}; bytes = 0; }
    chars[id] = rec;
    bytes += size;
  }
  if (Object.keys(chars).length) chunks.push({ chars });
  if (!chunks.length) throw new Error('No skin resources exist locally');
  const results = chunks.map((chunk, i) => emitSkinPlugin({ ...options, source: chunk, output: i ? `${base}-${i + 1}` : base }));
  if (!options.dryRun) {
    for (let i = chunks.length + 1; fs.existsSync(`${base}-${i}/plugin.json`); i++) {
      const dir = `${base}-${i}`;
      const old = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
      if (old.class !== 'cosmetic' || old.name !== 'Local skin catalogue') break;
      fs.rmSync(dir, { recursive: true });
    }
  }
  return { dir: results.map((r) => r.dir).join(', '), skins: results.reduce((n, r) => n + r.skins, 0), tokens: results.reduce((n, r) => n + r.tokens, 0), files: results.reduce((n, r) => n + r.files, 0), results };
}

/** Import existing /assets resources into a normal, self-contained cosmetic plugin. Missing art is omitted. */
export function emitSkinPlugin({ root, source, output, dryRun = false }) {
  const dir = skinPluginDir(root, output);
  const id = path.basename(dir);
  const assetsRoot = path.resolve(root, 'public', 'assets');
  const files = new Map();
  const image = (url) => {
    if (typeof url !== 'string' || !url.startsWith('/assets/')) return null;
    const rel = url.slice('/assets/'.length);
    if (rel.split('/').some((p) => !p || p.startsWith('.') || /[\\:%?]/.test(p))) return null;
    const abs = path.resolve(assetsRoot, ...rel.split('/'));
    if (!abs.startsWith(assetsRoot + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    // Plugin paths deliberately exclude '#' / '@', although upstream dump filenames can contain them.
    const safe = rel.split('/').map((part) => /[^A-Za-z0-9_.-]/.test(part)
      ? path.basename(part, path.extname(part)).replace(/[^A-Za-z0-9_.-]/g, '_') + '-' + createHash('sha256').update(path.basename(part, path.extname(part))).digest('hex').slice(0, 8) + path.extname(part) : part).join('/');
    const dest = `art/${safe}`;
    if (!isPackPath(dest)) return null;
    files.set(dest, abs);
    return dest;
  };
  const model = (sp) => {
    if (!sp || typeof sp !== 'object') return null;
    const skel = image(sp.skel), atlas = image(sp.atlas);
    const textures = Array.isArray(sp.textures) ? sp.textures.map(image) : [];
    if (!skel || !atlas || !textures.length || textures.some((p) => !p)) return null;
    return { skel, atlas, textures, pma: !!sp.pma };
  };
  const chars = {};
  let skins = 0, tokens = 0;
  for (const [charId, rec] of Object.entries(source.chars || {})) {
    if (!isAssetKey(charId)) continue;
    const out = {};
    for (const [skinId, skin] of Object.entries(rec.skins || {})) {
      if (!isSkinKey(skinId)) continue;
      const entry = { name: String(skin.name || skinId).slice(0, 64), group: String(skin.group || '').slice(0, 64) };
      for (const field of ['avatar', 'avatarE2', 'portrait', 'portraitE2', 'illust']) {
        const p = image(skin[field]);
        if (p) entry[field] = p;
      }
      const front = model(skin.spine?.front), back = model(skin.spine?.back);
      if (front || back) entry.spine = { ...(front ? { front } : {}), ...(back ? { back } : {}) };
      for (const [tokenId, t] of Object.entries(skin.tokens || {})) {
        const spine = model(t.spine);
        if (!isAssetKey(tokenId) || !spine) continue;
        entry.tokens ||= {};
        entry.tokens[tokenId] = { ...(typeof t.tokenSkinId === 'string' ? { tokenSkinId: t.tokenSkinId } : {}), spine };
        tokens++;
      }
      if (Object.keys(entry).length <= 2) continue;
      out[skinId] = entry;
      skins++;
    }
    if (Object.keys(out).length) chars[charId] = { skins: out };
  }
  const assets = { chars };
  if (!skins) throw new Error('No skin resources exist locally');
  if (!dryRun) {
    if (fs.existsSync(path.join(dir, 'plugin.json'))) {
      const old = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
      if (old.class !== 'cosmetic' || old.name !== 'Local skin catalogue') throw new Error('Refusing to replace a plugin not authored by skins.mjs');
    }
    fs.rmSync(path.join(dir, 'art'), { recursive: true, force: true });
    for (const [rel, abs] of files) {
      const target = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (rel.endsWith('.atlas')) {
        const pages = new Map([...files].filter(([, src]) => path.dirname(src) === path.dirname(abs) && /\.(png|jpg|webp)$/i.test(src))
          .map(([dest, src]) => [path.basename(src), { name: path.basename(dest), src }]));
        const raw = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').replace(/^(?:[ \t]*\r?\n)+/, '');
        const { text } = normalizeAtlas(raw, {
          renamePage: (name) => pages.get(name)?.name || name,
          pageSize: (name) => pages.has(name) ? pngSize(fs.readFileSync(pages.get(name).src)) : null,
        });
        fs.writeFileSync(target, text);
      } else fs.copyFileSync(abs, target);
    }
    const manifest = { manifest: 2, id, name: 'Local skin catalogue', version: '1.0.0', app: '>=0.3.1 <0.4.0', api: 1, class: 'cosmetic', scope: ['room', 'personal'], permissions: ['assets.add', 'assets.override'], assets: 'skins.json' };
    fs.writeFileSync(path.join(dir, 'skins.json'), JSON.stringify(assets, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
    const r = packPlugin(dir, { vanilla: readVanillaAssets(path.join(root, 'data')), dataDir: path.join(root, 'data') });
    const problems = [...r.build.problems, ...(r.check?.problems || [])];
    if (!r.wrote || problems.length) throw new Error(problems.join('\n'));
  }
  return { dir, skins, tokens, files: files.size, assets };
}

export function verifySkinPlugins(options) {
  const base = skinPluginDir(options.root, options.output);
  const dirs = [base];
  for (let i = 2; fs.existsSync(`${base}-${i}/plugin.json`); i++) dirs.push(`${base}-${i}`);
  const results = dirs.map((output) => verifySkinPlugin({ ...options, output }));
  return { problems: results.flatMap((r) => r.problems), warnings: results.flatMap((r) => r.warnings) };
}

export function verifySkinPlugin({ root, output, fix = false }) {
  const dir = skinPluginDir(root, output);
  const opts = { vanilla: readVanillaAssets(path.join(root, 'data')), dataDir: path.join(root, 'data') };
  if (fix) {
    const r = packPlugin(dir, opts);
    if (!r.wrote || r.build.problems.length) return r.build;
  }
  const checked = checkPluginFolder(dir, 'skins/', opts);
  const built = buildPluginLock(dir, opts);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.lock.json'), 'utf8')); } catch { /* reported below */ }
  const files = built.lock?.files;
  const stale = !previous || !files || Object.keys(files).length !== Object.keys(previous.files || {}).length
    || Object.keys(files).some((p) => files[p].sha256 !== previous.files[p]?.sha256 || files[p].bytes !== previous.files[p]?.bytes);
  return { ...checked, problems: [...checked.problems, ...built.problems, ...(stale ? ['Skin plugin lock is stale; run verify --fix'] : [])] };
}
