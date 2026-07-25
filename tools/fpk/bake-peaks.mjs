// Render Civ4's peak/hill MODELS to sprite atlases, standalone.
//
// web/build.mjs already wires these into the `trees` bundle group (see bakeFeatureSprites), but a full bake
// needs the generated map data, which is produced in CI — so this exists to render just the sprites and look at
// them. Same renderer (tools/nifbake), same arguments, so what it produces is what the bake will produce.
//
//   node tools/fpk/unpack.mjs extract "<game>/Assets/Art0.FPK" .civ4-fpk art/terrain/features/peak
//   node tools/fpk/bake-peaks.mjs
//
// BLOCKED, and the reason is exact. tools/nifbake/nif.mjs reads Gamebryo 20.0.0.4 — the version C2C's own models
// use, which is why the cactus and city sprites bake fine. The base game's peak models are the older
// NetImmerse 10.0.1.0:
//
//   peak_mountaina.nif   "NetImmerse File Format, Version 10.0.1.0"
//   kaktus2.nif          "Gamebryo File Format, Version 20.0.0.4"
//
// 10.0.1.0 lays its block stream out differently, so the reader walks off into nonsense and reports an absurd
// offset. Supporting it is a real extension to nif.mjs, not a tweak. The textures alongside the models are no
// substitute: peak_all.dds is a UV-mapped model SKIN (a rock-and-snow sheet with a soft alpha edge), not a
// billboard atlas of mountain cutouts, so the connected-component extractor that handles trees_1024.dds has
// nothing to cut out of it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeNifGroup } from '../nifbake/render.mjs';
import { resolveArt } from '../../web/civ4.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tools/fpk/out');

const GROUPS = [
  { name: 'peak', size: 320, tex: 'peak/peak_all.dds',
    nifs: ['peak/peak_mountaina.nif', 'peak/peak_mountainb.nif', 'peak/peak_mountainc.nif'] },
  { name: 'hill', size: 260, tex: 'peak/peak_all.dds',
    nifs: ['peak/peak_hilla.nif', 'peak/peak_hillb.nif', 'peak/peak_hillc.nif'] },
  { name: 'peaksingle', size: 320, tex: 'peak/peak_single.dds',
    nifs: ['peak/peak_singlea.nif', 'peak/peak_singleb.nif', 'peak/peak_singlec.nif'] },
];

for (const g of GROUPS) {
  const tex = resolveArt('Art/Terrain/features/' + g.tex);
  const variants = g.nifs.map(n => ({ nif: resolveArt('Art/Terrain/features/' + n), tex })).filter(v => v.nif && v.tex);
  if (!variants.length) { console.log(`${g.name}: no art resolved (extract the FPK first)`); continue; }
  try {
    const out = bakeNifGroup(variants, g.name, OUT, g.size, { size: g.size });
    console.log(`${g.name}: ${variants.length} variants ->`, out && { w: out.w, h: out.h, sprites: out.sprites && out.sprites.length });
  } catch (e) {
    console.log(`${g.name}: FAILED — ${e.message}`);
  }
}
console.log('output in tools/fpk/out');
