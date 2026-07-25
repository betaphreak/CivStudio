// Unpack Civ4 / C2C .FPK archives — the packed art the on-demand C2C fetch cannot reach.
//
// WHY THIS EXISTS. `docs/terrain-3d.md` needs Civ4's mountain model, and `web/civ4.mjs` resolves art out of the
// C2C repo's `UnpackedArt/art` tree, which has no `Peaks` or `Hills` directory — it holds only what C2C itself
// ships unpacked. The rest lives in FPK archives that ship with the game:
//
//   Assets/Art0.FPK                              317 MB  — base Civ4 / Beyond the Sword art
//   Mods/Caveman2Cosmos/Assets/C2C{0..3}.FPK      880 MB  — C2C's own art, packed
//   Mods/Caveman2Cosmos/Assets/C2CPatch0.FPK       18 MB
//
// So most of C2C's art was never in `UnpackedArt` either, which is worth knowing beyond terrain: the building
// and unit models P5 wants are in there too.
//
// THE FORMAT, worked out from the bytes (there is no spec to hand):
//
//   int32   4                     version
//   char[4] "FPK_"               magic
//   uint8   1
//   int32   count                 number of entries
//   count × entry:
//     int32   nameLen
//     byte[]  name                the path, EVERY BYTE INCREMENTED BY ONE, '\' separators
//     byte[]  pad                 (4 - nameLen % 4) % 4 bytes, NOT zeroed — leftover memory
//     int32   ?                   varies per entry — looks like a hash of the name
//     int32   ?                   identical across every entry in an archive — looks like a pack timestamp
//     int32   size                bytes of payload
//     int32   offset              absolute position of the payload
//
// The filename obfuscation is the only "encryption": `bsu]joufsgbdf` is `art\interface`. Payloads are stored
// raw — a .dds entry begins with "DDS " at its offset — so extraction is a copy with no decompression.
//
// THE NAME PADDING IS THE WHOLE DIFFICULTY, and it cost two debugging rounds. A fixed stride walks two entries
// and then desynchronises. Worse, the pad bytes are not zeroed, so the first of them looks like a plausible
// length or flag field — reading it as one produced a stride that was right for about ten entries and then
// wandered off, which is far more dangerous than failing outright. `nameLen` is padded up to a multiple of four
// and nothing else varies.
//
// So the walk is checked rather than trusted, three ways: every entry must lie inside the file; payloads are
// stored broadly in table order, so offsets must not go backwards; and a sample of extracted payloads must carry
// the magic bytes their extension implies. (Payloads are ALMOST contiguous — offset[i+1] usually equals
// offset[i] + size[i] — but not exactly, so contiguity is reported and not enforced.)
//
// Usage:
//   node unpack.mjs list   <archive.fpk> [substring]      list matching entries (no writes)
//   node unpack.mjs extract <archive.fpk> <outDir> [substring]
//
// `substring` is matched case-insensitively against the path, so a targeted pull is one command:
//   node unpack.mjs extract .../Art0.FPK ../../.civ4-unpacked art/terrain/peaks
import fs from 'node:fs';
import path from 'node:path';

const [, , mode, archive, ...rest] = process.argv;
if (!mode || !archive || !['list', 'extract'].includes(mode)) {
  console.error('usage: node unpack.mjs list <archive.fpk> [substring]\n' +
                '       node unpack.mjs extract <archive.fpk> <outDir> [substring]');
  process.exit(2);
}
const outDir = mode === 'extract' ? rest.shift() : null;
const filter = (rest.shift() || '').toLowerCase();

/** Undo the byte+1 obfuscation on a stored path, and normalise separators for the host. */
const decodePath = b => {
  let s = '';
  for (const v of b) s += String.fromCharCode((v - 1) & 0xff);
  return s.replace(/\\/g, '/');
};

const fd = fs.openSync(archive, 'r');
const { size: fileSize } = fs.fstatSync(fd);
const readAt = (len, pos) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };

const head = readAt(17, 0);
if (head.toString('latin1', 4, 8) !== 'FPK_') { console.error('not an FPK archive (magic missing)'); process.exit(1); }
const count = head.readInt32LE(9);

// Read the table in one go rather than seeking per entry: it is well under a megabyte even for 20k files, and
// the entries are variable-length so a streaming walk would be a long sequence of tiny reads. The first entry's
// payload offset marks where the table ends, so read up to that and no further.
const pad = n => (4 - (n % 4)) % 4;
const firstPayload = (() => {
  const probe = readAt(512, 13);
  const nameLen = probe.readInt32LE(0);
  return probe.readInt32LE(4 + nameLen + pad(nameLen) + 12);
})();
const table = readAt(firstPayload - 13, 13);   // from the first entry's nameLen up to the first payload
let o = 0;
const entries = [];
for (let i = 0; i < count; i++) {
  if (o + 4 > table.length) break;
  const nameLen = table.readInt32LE(o);
  const m = o + 4 + nameLen + pad(nameLen);
  if (nameLen < 1 || nameLen > 4096 || m + 16 > table.length) break;
  entries.push({
    name: decodePath(table.subarray(o + 4, o + 4 + nameLen)),
    size: table.readInt32LE(m + 8),
    offset: table.readInt32LE(m + 12),
  });
  o = m + 16;
}

// ---- validate the walk rather than trust it (see the format note) ----
const problems = [];
if (entries.length !== count) problems.push(`header says ${count} entries, walked ${entries.length}`);
const outside = entries.filter(e => e.offset < 0 || e.size < 0 || e.offset + e.size > fileSize);
if (outside.length) problems.push(`${outside.length} entries point outside the file (first: ${outside[0].name})`);
let backwards = 0, gaps = 0;
for (let i = 1; i < entries.length; i++) {
  if (entries[i].offset < entries[i - 1].offset) backwards++;
  else if (entries[i].offset !== entries[i - 1].offset + entries[i - 1].size) gaps++;
}
if (backwards) problems.push(`${backwards} offsets go backwards`);
// Magic-byte spot check: each extension's payload must START with one of its known signatures.
//
// A .nif may say EITHER "Gamebryo File Format" or "NetImmerse File Format" — the engine was renamed
// mid-life and Civ4 ships both eras (docs/terrain-3d.md §P4b covers the version differences that
// matter to the reader). Accepting only "Gamebryo" made C2C0.FPK refuse to extract over
// art/structures/buildings/herbalist/apothecary.nif, a perfectly good NetImmerse 4.2.2.0 file — a
// false alarm on a check whose whole job is to be trustworthy, which is the worst kind.
//
// Matched as a PREFIX rather than "contains the first four characters", which is both stricter than
// what it replaced and says what it means.
const MAGIC = {
  dds: ['DDS '],
  nif: ['Gamebryo File Format', 'NetImmerse File Format'],
  kf:  ['Gamebryo File Format', 'NetImmerse File Format'],
  kfm: [';Gamebryo KFM File Version', ';Gamebryo'],
};
let checked = 0, wrong = [];
for (const e of entries) {
  if (checked >= 40) break;
  const ext = (e.name.split('.').pop() || '').toLowerCase();
  const want = MAGIC[ext];
  if (!want || e.size < 32) continue;
  checked++;
  const head = readAt(Math.min(32, e.size), e.offset).toString('latin1');
  if (!want.some(w => head.startsWith(w)))
    wrong.push(`${e.name} (expected one of ${want.map(w => JSON.stringify(w)).join(', ')}, got ${JSON.stringify(head.slice(0, 24))})`);
}
if (wrong.length) problems.push(`${wrong.length}/${checked} sampled payloads have the wrong magic bytes: ${wrong[0]}`);

if (problems.length) {
  console.error('REFUSING TO EXTRACT — the table walk is not trustworthy:');
  for (const p of problems) console.error('  · ' + p);
  console.error('Extracting now would write subtly corrupt files, which is worse than failing.');
  process.exit(1);
}
console.log(`table OK: ${entries.length} entries, ${checked} payload magics verified` +
  (gaps ? `, ${gaps} non-contiguous (expected)` : ''));

const sel = filter ? entries.filter(e => e.name.toLowerCase().includes(filter)) : entries;

console.log(`${path.basename(archive)}: ${entries.length} entries` + (filter ? `, ${sel.length} match "${filter}"` : ''));

if (mode === 'list') {
  for (const e of sel.slice(0, 400)) console.log(`  ${String(e.size).padStart(9)}  ${e.name}`);
  if (sel.length > 400) console.log(`  ... and ${sel.length - 400} more`);
} else {
  let written = 0, bytes = 0;
  for (const e of sel) {
    if (e.offset + e.size > fileSize || e.size < 0) continue;
    const dest = path.join(outDir, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readAt(e.size, e.offset));
    written++; bytes += e.size;
  }
  console.log(`extracted ${written} files (${(bytes / 1048576).toFixed(1)} MB) to ${outDir}`);
}
fs.closeSync(fd);
