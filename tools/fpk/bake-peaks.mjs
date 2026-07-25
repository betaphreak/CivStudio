// Bake Civ4's mountain MODEL to the committed peak-prop atlas (docs/terrain-3d.md §P4b).
//
// This is the one bake whose output MUST be committed, and the reason is structural rather than a
// convenience: its input is `art/terrain/features/peak/*` out of the game's own `Assets/Art0.FPK`,
// extracted locally by tools/fpk/unpack.mjs into the gitignored `.civ4-fpk`. CI has no game install,
// so `web/build.mjs` cannot reproduce this — it falls back to the manifest written here (see
// bakeFeatureSprites → PEAK_MANIFEST). The tree and flag atlases already work this way.
//
//   node tools/fpk/unpack.mjs extract "<game>/Assets/Art0.FPK" .civ4-fpk art/terrain/features/peak
//   node tools/fpk/bake-peaks.mjs
//
// Writes web/assets/trees/trees-peak.webp + web/assets/trees/peaks.json. Both are committed; re-run
// and commit the pair whenever the model set or the render changes.
//
// WHAT IS DELIBERATELY NOT BAKED, because both were tried:
//
//   peak_hill{a,b,c}.nif   the SAME MESH as peak_mountain{a,b,c} — byte-identical vertices, verified by
//                          hashing them. The pair differs only in the skin it names (`Hill.dds` vs
//                          `Mountain.dds`, both in `features/hills/`, which are the game's per-base-terrain
//                          hill tints). Nothing places a hill prop either: HILL stays gentle vertex
//                          displacement (heightfield.HEIGHT.HILL), which is what Civ4 does — its real hill
//                          art, `features/hills/hills_grass*.nif`, is a near-horizontal ground patch that
//                          the billboard renderer's flat-plane filter drops, i.e. relief, not a prop.
//   peak_single{a,b,c}.nif a genuinely different, lone-cone mesh (101 verts) — but its skin
//                          `peak_single.dds` is an unwrapped sheet with violet-blue snow that reads wrong
//                          out of the game's own lighting. Faithfully decoded; simply not usable art here.
//
// So `peak_all.dds` over peak_mountain{a,b,c} is the whole bake: rock-and-snow, three variants so a range
// of mountains is not one stencil.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bakeNifGroup } from '../nifbake/render.mjs';
import { resolveArt } from '../../web/civ4.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ASSETS = path.join(ROOT, 'web/assets');
// sharp is web/'s dependency (see the note on WebP in web/build.mjs) and this tool lives outside web/,
// so resolve it from there rather than adding a second copy under tools/. Loaded lazily because
// build.mjs IMPORTS this module for PEAK_GROUP/peakVariants and must not need the encoder to do so.
const loadSharp = () => createRequire(path.join(ROOT, 'web/package.json'))('sharp');

/** The peak group, shared with web/build.mjs so the two cannot drift. */
export const PEAK_GROUP = {
  name: 'peak', size: 320, tex: 'peak/peak_all.dds',
  nifs: ['peak/peak_mountaina.nif', 'peak/peak_mountainb.nif', 'peak/peak_mountainc.nif'],
};

/** Where build.mjs reads the committed record from when the FPK extract is absent (i.e. in CI). */
export const PEAK_MANIFEST = path.join(ASSETS, 'trees/peaks.json');

/** Resolve a group's art through resolveArt (which checks .civ4-fpk first). Empty if not extracted. */
export function peakVariants(g = PEAK_GROUP) {
  const tex = resolveArt('Art/Terrain/features/' + g.tex);
  return g.nifs.map(n => ({ nif: resolveArt('Art/Terrain/features/' + n), tex }))
    .filter(v => v.nif && v.tex);
}

if (process.argv[1] && /bake-peaks\.mjs$/.test(process.argv[1])) {
  const variants = peakVariants();
  if (!variants.length) {
    console.error('no peak art resolved — extract Art0.FPK first (see the header of this file)');
    process.exit(1);
  }
  // Same renderer and the same arguments build.mjs uses, so what lands here is what the bundle gets.
  const pending = [];
  const emit = (n, w, h, rgba) => {
    pending.push({ file: `trees/trees-${n}.webp`, w, h, rgba });
    return `assets/trees/trees-${n}.webp`;
  };
  const rec = bakeNifGroup(variants, PEAK_GROUP.name, ASSETS, PEAK_GROUP.size, { size: PEAK_GROUP.size, emit });
  if (!rec) { console.error('bake produced no sprites'); process.exit(1); }

  const sharp = loadSharp();
  for (const im of pending) {
    const out = path.join(ASSETS, im.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // same encoder settings as build.mjs's sprite queue, so the committed file matches a CI-baked one
    const buf = await sharp(im.rgba, { raw: { width: im.w, height: im.h, channels: 4 } })
      .webp({ quality: 90, alphaQuality: 100, effort: 5 })
      .toBuffer();
    fs.writeFileSync(out, buf);
    console.log(`${im.file}: ${im.w}x${im.h}, ${(buf.length / 1024).toFixed(1)} kB`);
  }
  fs.mkdirSync(path.dirname(PEAK_MANIFEST), { recursive: true });
  fs.writeFileSync(PEAK_MANIFEST, JSON.stringify(rec, null, 2) + '\n');
  console.log(`${path.relative(ROOT, PEAK_MANIFEST)}: ${rec.sprites.length} sprites`);
  console.log('commit both — CI has no game install and cannot reproduce them');
}
