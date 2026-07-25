// On-demand fetch of the Caveman2Cosmos (Civ4) source files from GitHub at the locked ref, cached
// under .civ4-cache/<ref>/. The Node sibling of com.civstudio.data.Civ4Files (same cache layout, so
// the two share downloads) — the raw C2C art/XML is no longer vendored under data/civ4/. See
// docs/civ4-files.md.
//
// Speed: the sync get()/resolveArt() the bakers call serve straight from the disk cache. Warm the
// cache first with the async prefetch() (parallel fetch over the whole art/XML set) so a bake does
// not pay a per-file round trip. A cold sync call falls back to a single `gh api` subprocess, so
// everything still works without a prefetch — just slower.
//
//   import { get, resolveArt, prefetch, REF } from './civ4.mjs';
//   await prefetch({ arts: buttonPaths, files: ['CIV4BonusInfos.xml'] });   // warm (parallel)
//   const dds = resolveArt('Art/Terrain/Textures/Land/GrassDetail.dds');    // sync, case-insensitive
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = 'caveman2cosmos/Caveman2Cosmos';
const API = `https://api.github.com/repos/${REPO}/contents/`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOCK = path.join(ROOT, 'civstudio-engine/src/main/resources/civ4-source.lock');

export const REF = (() => {
  try { const s = fs.readFileSync(LOCK, 'utf8').trim(); if (s) return s; } catch { /* fall through */ }
  return 'master';
})();

const CACHE = path.join(process.env.CIV4_CACHE_DIR || path.join(ROOT, '.civ4-cache'), REF);

// GITHUB_TOKEN (or CIV4_TOKEN), else `gh auth token` — the C2C repo is public but the
// unauthenticated GitHub API allows only 60 req/hour, far too few for a full bake.
const TOKEN = (() => {
  const v = (process.env.GITHUB_TOKEN || process.env.CIV4_TOKEN || '').trim();
  if (v) return v;
  try { return execFileSync('gh', ['auth', 'token']).toString().trim(); } catch { return ''; }
})();

// committed-relative path (what the file was under data/civ4/) -> its path in the C2C repo.
// Mirrors com.civstudio.data.Civ4Files.FILE_MAP — keep the two in sync.
const FILE_MAP = {
  'CIV4TerrainInfos.xml': 'Assets/XML/Terrain/CIV4TerrainInfos.xml',
  'CIV4FeatureInfos.xml': 'Assets/XML/Terrain/CIV4FeatureInfos.xml',
  'CIV4ImprovementInfos.xml': 'Assets/XML/Terrain/CIV4ImprovementInfos.xml',
  'CIV4BonusInfos.xml': 'Assets/XML/Terrain/CIV4BonusInfos.xml',
  'CIV4BonusClassInfos.xml': 'Assets/XML/Terrain/CIV4BonusClassInfos.xml',
  'Manufactured_CIV4BonusInfos.xml': 'Assets/XML/Terrain/Manufactured_CIV4BonusInfos.xml',
  'SpecialBuildings_CIV4BuildingInfos.xml': 'Assets/XML/Buildings/SpecialBuildings_CIV4BuildingInfos.xml',
  'zProviders_CIV4BuildingInfos.xml': 'Assets/XML/Buildings/zProviders_CIV4BuildingInfos.xml',
  'Regular_CIV4BuildingInfos.xml': 'Assets/XML/Buildings/Regular_CIV4BuildingInfos.xml',
  'CIV4RouteInfos.xml': 'Assets/XML/Misc/CIV4RouteInfos.xml',
  'CIV4RouteModelInfos.xml': 'Assets/XML/Art/CIV4RouteModelInfos.xml',
  'CIV4ArtDefines_Terrain.xml': 'Assets/XML/Art/CIV4ArtDefines_Terrain.xml',
  'CIV4ArtDefines_Bonus.xml': 'Assets/XML/Art/CIV4ArtDefines_Bonus.xml',
  'C2C_CIV4TerrainSchema.xml': 'Assets/XML/Schema/C2C_CIV4TerrainSchema.xml',
  'Caveman2Cosmos.xsd': 'Assets/XML/Schema/Caveman2Cosmos.xsd',
  'C2C_Planet_Generator_0_68.py': 'PrivateMaps/C2C_Planet_Generator_0_68.py',
  'assets/XML/Technologies/CIV4TechInfos.xml': 'Assets/XML/Technologies/CIV4TechInfos.xml',
  'assets/XML/GameText/Tech_CIV4GameText.xml': 'Assets/XML/GameText/Tech_CIV4GameText.xml',
  'res/Fonts/GameFont.tga': 'Assets/res/Fonts/GameFont.tga',
  // C2C ships this atlas under an odd name; it was renamed on vendoring
  'res/Fonts/GameFont_120.tga': 'Assets/res/Fonts/GameFont_120_(unused prrof of concept).tga',
};

const norm = p => p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
// url-encode each path segment, preserving '/' (spaces/parens appear in one atlas name)
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

// committed-relative -> C2C repo path
function toC2C(rel) {
  rel = norm(rel);
  if (FILE_MAP[rel]) return FILE_MAP[rel];
  if (rel.startsWith('assets/terrain/')) return 'UnpackedArt/art/' + rel.slice('assets/'.length);
  throw new Error('no C2C mapping for civ4 path: ' + rel);
}
// canonical (lowercased, Art/-stripped) cache key for a terrain/tech-button art path, so a warmed
// art file is found by a later sync resolveArt() with no case-insensitive directory listing
const artKey = artPath => '_art/' + artPath.replace(/^Art\//i, '').replace(/\\/g, '/').toLowerCase();

function writeCache(local, buf) {
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const tmp = local + '.dl-' + process.pid + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, local);
}

// ---- sync (subprocess) fetchers — the cold-cache fallback path ----------------------------------
function ghRawSync(c2cPath) {
  return execFileSync('gh',
    ['api', `repos/${REPO}/contents/${encPath(c2cPath)}?ref=${REF}`, '-H', 'Accept: application/vnd.github.raw'],
    { maxBuffer: 1 << 30 });
}
const _list = new Map();   // c2cDir -> [names], shared by the sync and async resolvers
function ghListSync(c2cDir) {
  if (_list.has(c2cDir)) return _list.get(c2cDir);
  const out = execFileSync('gh',
    ['api', `repos/${REPO}/contents/${encPath(c2cDir)}?ref=${REF}&per_page=100`], { maxBuffer: 1 << 28 });
  const names = JSON.parse(out.toString('utf8')).map(e => e.name);
  _list.set(c2cDir, names);
  return names;
}

// ---- async (fetch) fetchers — the parallel prefetch path ----------------------------------------
function ghHeaders(accept) {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  return h;
}
async function ghRawAsync(c2cPath) {
  const r = await fetch(API + encPath(c2cPath) + '?ref=' + encodeURIComponent(REF),
    { headers: ghHeaders('application/vnd.github.raw') });
  if (r.status === 404) throw new Error('civ4 file not found at ' + REF + ': ' + c2cPath);
  if (!r.ok) throw new Error('fetch ' + r.status + ' for ' + c2cPath);
  return Buffer.from(await r.arrayBuffer());
}
async function ghListAsync(c2cDir) {
  if (_list.has(c2cDir)) return _list.get(c2cDir);
  const names = [];
  let url = API + encPath(c2cDir) + '?ref=' + encodeURIComponent(REF) + '&per_page=100';
  while (url) {                                    // follow the Link: rel="next" pages
    const r = await fetch(url, { headers: ghHeaders('application/vnd.github+json') });
    if (!r.ok) throw new Error('list ' + r.status + ' for ' + c2cDir);
    for (const e of await r.json()) names.push(e.name);
    const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '');
    url = next ? next[1] : null;
  }
  _list.set(c2cDir, names);
  return names;
}
// resolve an "Art/..." path to its real C2C path, matching each UnpackedArt/art segment
// case-insensitively; null if absent. `lister` is the sync or async directory lister.
async function resolveArtC2C(artPath, lister) {
  const rel = artPath.replace(/^Art\//i, '').split('/').filter(Boolean);
  let dir = 'UnpackedArt/art';
  for (const seg of rel) {
    const hit = (await lister(dir)).find(n => n.toLowerCase() === seg.toLowerCase());
    if (!hit) return null;
    dir += '/' + hit;
  }
  return dir;
}

// run async thunks with a bounded concurrency (keeps the GitHub API happy on a big bake)
async function pool(items, worker, concurrency = 16) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
  });
  await Promise.all(runners);
}

/**
 * Warm the disk cache in parallel so the synchronous get()/resolveArt() below hit it with no round
 * trip. `files` are committed-relative paths (get); `arts` are "Art/..." paths (resolveArt). Failed
 * fetches are swallowed (the sync call re-tries / degrades). Call once before a bake.
 */
export async function prefetch({ files = [], arts = [], concurrency = 16 } = {}) {
  await pool([...new Set(files)], async rel => {
    try {
      const local = path.join(CACHE, norm(toC2C(rel)));
      if (!fs.existsSync(local)) writeCache(local, await ghRawAsync(toC2C(rel)));
    } catch { /* leave to the sync path */ }
  }, concurrency);
  await pool([...new Set(arts)].filter(Boolean), async art => {
    try {
      const local = path.join(CACHE, artKey(art));
      if (fs.existsSync(local)) return;
      const resolved = await resolveArtC2C(art, ghListAsync);
      if (resolved) writeCache(local, await ghRawAsync(resolved));
    } catch { /* leave to the sync path */ }
  }, concurrency);
}

// ---- sync public API (what the bakers call) -----------------------------------------------------
function getC2CSync(c2cPath) {
  const local = path.join(CACHE, norm(c2cPath));
  if (fs.existsSync(local)) return local;
  writeCache(local, ghRawSync(c2cPath));
  return local;
}

/** The local file for a committed-relative path (what it was under data/civ4/); fetches if cold. */
export function get(committedRelativePath) {
  return getC2CSync(toC2C(committedRelativePath));
}

/** Like {@link get} but returns null on any failure — for the degrade-gracefully call sites. */
export function getOptional(committedRelativePath) {
  try { return get(committedRelativePath); } catch { return null; }
}

/**
 * Resolve an "Art/..." path to a local cached .dds file (case-insensitive on the C2C tree). Serves
 * from the warm cache (see prefetch); on a cold miss it resolves + fetches synchronously via `gh`.
 * Returns null if absent / unfetchable, so bakes degrade to their fallbacks.
 */
// Art extracted from the installed game's FPK archives by tools/fpk/unpack.mjs, if it is there. This is the
// ONLY source for anything the game ships packed rather than loose: C2C's UnpackedArt tree holds only what C2C
// itself overrides, so e.g. art/terrain/features/peak/* — Civ4's mountain and hill models — exists nowhere the
// GitHub fetch can see it (docs/terrain-3d.md §Relief is props).
//
// Checked FIRST, so a locally extracted file beats a fetch, and gitignored, so it is never committed: it is the
// publisher's art. A bake that depends on it must therefore commit its OUTPUT, because CI has no game install
// — which is already how the tree and flag atlases work.
const FPK = path.join(ROOT, '.civ4-fpk');
function resolveFpk(artPath) {
  const rel = artPath.replace(/^Art\//i, 'art/').replace(/\\/g, '/').toLowerCase();
  const p = path.join(FPK, rel);
  return fs.existsSync(p) ? p : null;
}

export function resolveArt(artPath) {
  if (!artPath) return null;
  const fromFpk = resolveFpk(artPath);
  if (fromFpk) return fromFpk;
  const local = path.join(CACHE, artKey(artPath));
  if (fs.existsSync(local)) return local;                       // warmed by prefetch
  try {
    let dir = 'UnpackedArt/art';
    for (const seg of artPath.replace(/^Art\//i, '').split('/').filter(Boolean)) {
      const hit = ghListSync(dir).find(n => n.toLowerCase() === seg.toLowerCase());
      if (!hit) return null;
      dir += '/' + hit;
    }
    writeCache(local, ghRawSync(dir));
    return local;
  } catch {
    return null;
  }
}
