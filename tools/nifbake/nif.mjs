// Minimal NIF reader for Civ4 feature models — Gamebryo 20.0.0.4 (C2C's own art), Gamebryo 10.1.0.0 and
// NetImmerse 10.0.1.0 (the base game's, e.g. the peak mountain models out of Art0.FPK; docs/terrain-3d.md
// §Relief is props).
//
// THE VERSIONS DIFFER IN FIVE PLACES, and nowhere else that a billboard render touches:
//
//   header          20.0.0.4 carries an endian byte (>= 20.0.0.3) and a user version (>= 10.0.1.8);
//                   10.0.1.0 has neither, so its header is 5 bytes shorter.
//   block stream    versions in [10.0.1.0, 10.2.0.0) prefix EVERY block with a u32 object index — a
//                   short-lived NetImmerse/early-Gamebryo framing that 20.0.0.4 dropped. See readBlock.
//   NiGeometry      the named-material arrays (count + names + extra data + active material) arrived at
//                   20.2.0.5 — LATER THAN ANY VERSION CIV4 SHIPS — so in every file here the Has Shader
//                   flag follows the skin ref directly. Reading a phantom count was this file's most
//                   expensive single bug; see the note on niTriShape.
//   NiTriShapeData  the Has Triangles / Has Points flag arrived at 10.1.0.0; at 10.0.1.0 the indices follow
//                   the count with no flag between them.
//   NiGeometryData  Group ID and the Keep/Compress flag bytes arrived at 10.1.0.0, so 10.0.1.0 has none
//                   of the three; the Additional Data ref arrived at 20.0.0.4, so 10.0.1.0 lacks that too.
//   nothing else    NiObjectNET's extra-data LIST, NiAVObject's collision ref and NiGeometryData's vector
//                   and consistency flags all arrived at exactly 10.0.1.0, so every version here has them.
//
// EACH OF THOSE COSTS ONE BYTE-LEVEL INVESTIGATION, and they present far from where they are. The material
// arrays put a phantom count where the next block's string length was; the missing Has Triangles flag shifted
// a 1290-byte index array by one and put the footer one byte past EOF. Neither looks like what it is. The
// method that worked: hand-decode the region and check each field against what it OUGHT to be — a
// NiMaterialProperty whose diffuse reads (1,1,1) and glossiness 10.0 is aligned, one whose ambient is noise
// is not — rather than guessing at strides.
//
// `V` below is the packed version integer (0x0A000100 for 10.0.1.0, 0x14000004 for 20.0.0.4), which is why
// the guards read as plain comparisons. It is module state rather than a parameter because every block body
// would otherwise have to thread it, and one file is parsed at a time.
//
// The block stream is parsed SEQUENTIALLY — neither version carries a per-block size array — so every block
// type present must be parsed byte-exactly. What a 2D billboard render needs is NiNode transforms, NiTriShape
// geometry refs, and the vertex / UV / triangle arrays in NiTriShapeData.
//
// Correctness is validated by landing exactly on the file footer, which is what makes adding a version safe to
// attempt: a wrong guess desynchronises and fails loudly instead of yielding plausible-looking geometry.
//
// `NIF_FROM=<blockIndex>:<byteOffset>` prints each block's byte range, which is how to localise a desync.
import fs from 'node:fs';

// The packed version of the file being parsed, set by parseNif before any block body runs.
const V_10_0_1_0 = 0x0a000100, V_10_1_0_0 = 0x0a010000, V_10_2_0_0 = 0x0a020000,
      V_20_0_0_4 = 0x14000004, V_20_2_0_5 = 0x14020005;
let V = V_20_0_0_4;
const atLeast = v => V >= v;
// Every block in [10.0.1.0, 10.2.0.0) is preceded by a u32 object index (0 throughout Civ4's exports).
const hasBlockIndex = () => V >= V_10_0_1_0 && V < V_10_2_0_0;

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8() { return this.b[this.o++]; }
  bool() { return this.b[this.o++] !== 0; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  mat33() { const m = []; for (let i = 0; i < 9; i++) m.push(this.f32()); return m; }
  str() { const n = this.u32(); const s = this.b.toString('latin1', this.o, this.o + n); this.o += n; return s; }
  refs(n) { const a = []; for (let i = 0; i < n; i++) a.push(this.i32()); return a; }
}

// --- common bases (20.0.0.4, userVer 0) ---
function niObjectNET(r) {
  const name = r.str();
  const numExtra = r.u32(); r.refs(numExtra);   // Extra Data List
  r.i32();                                       // Controller ref
  return { name };
}
function niAVObject(r) {
  const base = niObjectNET(r);
  const flags = r.u16();
  const translation = r.vec3();
  const rotation = r.mat33();
  const scale = r.f32();
  const numProps = r.u32(); const props = r.refs(numProps);
  const collision = r.i32();                      // >= 10.0.1.0
  return { ...base, flags, translation, rotation, scale, props, collision };
}

// --- block bodies ---
function niNode(r) {
  const av = niAVObject(r);
  const numChildren = r.u32(); const children = r.refs(numChildren);
  const numEffects = r.u32(); r.refs(numEffects);
  return { kind: 'NiNode', ...av, children };
}
function niTriShape(r) {
  const av = niAVObject(r);
  const data = r.i32();                           // NiGeometryData ref
  r.i32();                                         // Skin Instance ref
  // MaterialData. The named-material arrays arrived at 20.2.0.5 — LATER THAN EVERY VERSION CIV4
  // SHIPS — so at 10.0.1.0 AND at 20.0.0.4 the Has Shader flag follows the skin ref directly.
  //
  // Reading a phantom material count here is the single most expensive bug this file has had. It
  // desynchronised the base-game peaks, where the count landed on the next block's string length;
  // and on the C2C BUILDING models it read 3072 materials and threw, which the gap-resync then
  // reported as "resync failed" hundreds of bytes away. It looked survivable for a long time
  // because on the two models that were actually in use the 8-byte over-read fell inside a gap run
  // that the brute-force resync silently re-found. 252 of 638 20.0.0.4 building models did not
  // survive it. Guarded rather than deleted so the version it really arrives at is recorded.
  if (atLeast(V_20_2_0_5)) {
    const numMaterials = r.u32();
    for (let i = 0; i < numMaterials; i++) r.str();  // Material Names
    for (let i = 0; i < numMaterials; i++) r.i32();  // Material Extra Data
    r.i32();                                          // Active Material
  }
  const hasShader = r.bool();
  if (hasShader) { r.str(); r.i32(); }             // Shader Name + Unknown Integer
  return { kind: 'NiTriShape', ...av, data };
}
// NiGeometryData — vertices / normals / UVs, shared by NiTriShapeData and NiTriStripsData
function niGeometryData(r) {
  if (atLeast(V_10_1_0_0)) r.i32();                // Group ID (>=10.1.0.0)
  const numVertices = r.u16();
  if (atLeast(V_10_1_0_0)) { r.u8(); r.u8(); }     // Keep Flags, Compress Flags (>=10.1.0.0)
  const hasVertices = r.bool();
  const vertices = [];
  if (hasVertices) for (let i = 0; i < numVertices; i++) vertices.push(r.vec3());
  const vectorFlags = r.u16();                     // BS Vector Flags (>=10.0.1.0): bits 0-5 = #UV sets, bit 12 = tangents
  const hasNormals = r.bool();
  if (hasNormals) for (let i = 0; i < numVertices; i++) r.vec3();
  if (hasNormals && (vectorFlags & 4096))          // tangents + bitangents
    for (let i = 0; i < numVertices * 2; i++) r.vec3();
  r.vec3(); r.f32();                               // Center, Radius
  const hasColors = r.bool();
  if (hasColors) for (let i = 0; i < numVertices; i++) { r.f32(); r.f32(); r.f32(); r.f32(); }
  const numUV = vectorFlags & 63;                  // UV set count (no separate Has UV field at 20.0.0.4)
  const uvs = [];
  for (let s = 0; s < numUV; s++) {
    const set = [];
    for (let i = 0; i < numVertices; i++) set.push([r.f32(), r.f32()]);
    if (s === 0) uvs.push(...set);
  }
  r.u16();                                          // Consistency Flags (>=10.0.1.0, so both versions)
  if (atLeast(V_20_0_0_4)) r.i32();                // Additional Data ref (>=20.0.0.4)
  return { numVertices, vertices, uvs };
}
// The index array's presence flag (Has Triangles / Has Points) arrived at 10.1.0.0; at 10.0.1.0 the
// indices follow the count directly. Reading a phantom flag byte there shifts the whole index array
// by one and lands the footer one byte past EOF — the last of the base-game peaks' three desyncs.
const hasIndexFlag = () => atLeast(V_10_1_0_0);

function niTriShapeData(r) {
  const g = niGeometryData(r);
  const numTriangles = r.u16();
  r.u32();                                          // Num Triangle Points
  const hasTriangles = hasIndexFlag() ? r.bool() : true;
  const triangles = [];
  if (hasTriangles) for (let i = 0; i < numTriangles; i++) triangles.push([r.u16(), r.u16(), r.u16()]);
  const numMatch = r.u16();
  for (let i = 0; i < numMatch; i++) { const n = r.u16(); for (let j = 0; j < n; j++) r.u16(); }
  return { kind: 'NiTriShapeData', ...g, triangles };
}
function niTriStripsData(r) {
  const g = niGeometryData(r);
  r.u16();                                          // Num Triangles
  const numStrips = r.u16();
  const lengths = []; for (let i = 0; i < numStrips; i++) lengths.push(r.u16());
  const hasPoints = hasIndexFlag() ? r.bool() : true;   // same 10.1.0.0 arrival as Has Triangles
  const triangles = [];
  if (hasPoints) for (let s = 0; s < numStrips; s++) {
    const strip = []; for (let i = 0; i < lengths[s]; i++) strip.push(r.u16());
    for (let i = 0; i < strip.length - 2; i++) {          // strip → triangle list
      const a = strip[i], b = strip[i + 1], c = strip[i + 2];
      if (a === b || b === c || a === c) continue;         // degenerate
      triangles.push(i & 1 ? [a, c, b] : [a, b, c]);       // flip winding on odd
    }
  }
  return { kind: 'NiTriShapeData', ...g, triangles };       // report as data with a triangle list
}
function niTexturingProperty(r) {
  niObjectNET(r);
  r.u16();                                          // Flags
  r.u32();                                          // Apply Mode
  const texCount = r.u32();                         // Texture Count
  // parse each texture desc; we only need to advance. Base Texture is index 0.
  for (let i = 0; i < texCount; i++) {
    const hasTex = r.bool();
    if (hasTex) {
      r.i32();                                       // Source ref (NiSourceTexture)
      r.u32();                                       // Clamp Mode
      r.u32();                                       // Filter Mode
      r.u32();                                       // UV Set
      // (has texture transform) bool + transform — present >=10.1.0.0
      const hasTransform = r.bool();
      if (hasTransform) { r.f32(); r.f32(); r.f32(); r.f32(); r.f32(); r.u32(); r.f32(); r.f32(); }
    }
    // Shader textures (index >= base set) may carry a Shader map index; Civ4 base props
    // usually have small texCount (<=7). If desync appears, refine here.
  }
  return { kind: 'NiTexturingProperty' };
}
function niSourceTexture(r) {
  niObjectNET(r);
  const useExternal = r.u8();
  let file = null;
  if (useExternal === 1) { file = r.str(); r.i32(); }  // File Name + Unknown Ref
  else { r.bool(); r.i32(); }                           // (internal) — rare for Civ4
  r.u32();                                               // Pixel Layout
  r.u32();                                               // Use Mipmaps
  r.u32();                                               // Alpha Format
  r.bool();                                              // Is Static
  r.bool();                                              // Direct Render (>=20.0.0.4)
  return { kind: 'NiSourceTexture', file };
}
function niMaterialProperty(r) {
  niObjectNET(r);
  r.u16();                                          // Flags
  r.vec3(); r.vec3(); r.vec3(); r.vec3();           // Ambient, Diffuse, Specular, Emissive
  r.f32(); r.f32();                                 // Glossiness, Alpha
  return { kind: 'NiMaterialProperty' };
}
function niAlphaProperty(r) { niObjectNET(r); r.u16(); r.u8(); return { kind: 'NiAlphaProperty' }; }
function niSpecularProperty(r) { niObjectNET(r); r.u16(); return { kind: 'NiSpecularProperty' }; }
function niStencilProperty(r) { niObjectNET(r); r.u16(); r.u8(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); return { kind: 'NiStencilProperty' }; }
function niCollisionData(r) {
  niAVObject(r);
  r.u32(); r.u32(); const hasBV = r.bool();        // Propagation Mode, Collision Mode, Has Bounding Volume
  if (hasBV) { const t = r.u32(); skipBoundingVolume(r, t); }
  return { kind: 'NiCollisionData' };
}
function skipBoundingVolume(r, t) {
  if (t === 0) { r.vec3(); r.f32(); }                          // sphere
  else if (t === 1) { r.vec3(); r.mat33(); r.f32(); r.f32(); r.f32(); } // box
  else if (t === 5) { r.vec3(); r.vec3(); r.f32(); }           // half-space
  // other types unlikely for Civ4 features
}

function niStringExtraData(r) { const name = r.str(); r.str(); return { kind: 'NiStringExtraData', name }; }
function niVertexColorProperty(r) { niObjectNET(r); r.u16(); r.u32(); r.u32(); return { kind: 'NiVertexColorProperty' }; }

// One block, from its true start: the [10.0.1.0, 10.2.0.0) object-index prefix (if any) then the body.
// The resync scan below probes with this same function, so a "found" offset is always a block start
// rather than a body start, and the prefix is never counted twice or skipped.
function readBlock(r, type) {
  if (hasBlockIndex()) r.u32();
  return PARSERS[type](r);
}

const PARSERS = {
  NiNode: niNode, NiTriShape: niTriShape, NiTriShapeData: niTriShapeData,
  NiTriStrips: niTriShape, NiTriStripsData: niTriStripsData,
  NiTexturingProperty: niTexturingProperty, NiSourceTexture: niSourceTexture,
  NiMaterialProperty: niMaterialProperty, NiAlphaProperty: niAlphaProperty,
  NiSpecularProperty: niSpecularProperty, NiStencilProperty: niStencilProperty,
  NiCollisionData: niCollisionData, NiStringExtraData: niStringExtraData,
  NiVertexColorProperty: niVertexColorProperty,
};

export function parseNif(buf, debug = false, lenient = false) {
  const r = new Reader(buf);
  while (r.b[r.o] !== 0x0A) r.o++;
  const header = r.b.toString('latin1', 0, r.o); r.o++;
  const version = r.u32();
  V = version;                                      // every block body reads this (see the note at the top)
  const endian = atLeast(0x14000003) ? r.u8() : 1;  // Endian Type (>=20.0.0.3)
  const userVer = atLeast(0x0a000108) ? r.u32() : 0;   // User Version (>=10.0.1.8)
  const numBlocks = r.u32();
  const numTypes = r.u16();
  const types = []; for (let i = 0; i < numTypes; i++) types.push(r.str());
  const typeIdx = []; for (let i = 0; i < numBlocks; i++) typeIdx.push(r.u16() & 0x7fff);
  const numGroups = r.u32(); r.refs(numGroups);   // Num Groups / Groups (0 in every Civ4 export)

  // Only the scene graph + geometry need exact parsing; every other block type
  // (materials, textures, collision, extra data — whose Gamebryo 20.0.0.4 layouts are
  // fiddly and irrelevant to a billboard) is a "gap". A run of consecutive gap blocks is
  // skipped in one brute-force resync: find the byte offset at which the next must-parse
  // block — and thus the whole tail to EOF — parses cleanly. The full-tail check makes a
  // wrong offset astronomically unlikely, so the first hit is the real boundary.
  const MUSTPARSE = new Set(['NiNode', 'NiTriShape', 'NiTriShapeData', 'NiTriStrips', 'NiTriStripsData']);

  // strong per-block sanity — a wrong resync offset almost never yields a block whose
  // counts, indices and refs are all in range, so this locates real boundaries without
  // the exponential cost of validating the whole tail.
  function sane(type, b) {
    if (!b) return false;
    if (type === 'NiTriShapeData' || type === 'NiTriStripsData')
      return b.numVertices >= 3 && b.numVertices < 20000 && b.vertices.length === b.numVertices
        && b.triangles.length > 0 && b.uvs.length === b.numVertices
        && b.triangles.every(t => t[0] < b.numVertices && t[1] < b.numVertices && t[2] < b.numVertices)
        && b.uvs.every(u => u[0] > -2 && u[0] < 3 && u[1] > -2 && u[1] < 3);
    // NiNode / NiTriShape: printable name, refs & transform in range
    const printable = [...(b.name || '')].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127);
    const refsOk = (b.props || []).concat(b.children || []).every(x => x >= -1 && x < numBlocks);
    const scaleOk = b.scale > 0.0001 && b.scale < 100000;
    const dataOk = (type !== 'NiTriShape' && type !== 'NiTriStrips') || (b.data >= 0 && b.data < numBlocks);
    return printable && refsOk && scaleOk && dataOk;
  }

  function parseFrom(reader, from, sink) {
    for (let i = from; i < numBlocks;) {
      const type = types[typeIdx[i]];
      if (!MUSTPARSE.has(type)) {
        let j = i; while (j < numBlocks && !MUSTPARSE.has(types[typeIdx[j]])) j++;  // end of gap run
        const start = reader.o;
        let found = -1;
        for (let n = start + 4; n <= start + 8192 && n <= buf.length; n++) {
          const probe = new Reader(buf); probe.o = n;
          try {
            if (j >= numBlocks) { if (footer(probe)) { found = n; break; } }
            else { const b = readBlock(probe, types[typeIdx[j]]); if (sane(types[typeIdx[j]], b)) { found = n; break; } }
          } catch { /* keep scanning */ }
        }
        if (found < 0) throw new Error(`resync failed skipping gap blocks ${i}..${j - 1} at ${start}`);
        if (sink) for (let k = i; k < j; k++) sink[k] = { kind: types[typeIdx[k]], gap: true };
        reader.o = found;
        i = j;
        continue;
      }
      const start = reader.o;
      const blk = readBlock(reader, type);
      if (sink && debug) console.error(`  #${i} ${type} [${start}..${reader.o}] name=${JSON.stringify(blk.name || '')}${blk.numVertices ? ` verts=${blk.numVertices} tris=${blk.triangles ? blk.triangles.length : '?'}` : ''}`);
      if (sink) sink[i] = blk;
      i++;
    }
    return footer(reader);
  }
  function footer(reader) {
    const numRoots = reader.u32();
    if (numRoots > 1000) throw new Error('bad footer');
    for (let i = 0; i < numRoots; i++) reader.i32();
    return reader.o === buf.length;
  }

  const blocks = [];
  try {
    if (!parseFrom(r, 0, blocks) && !lenient)
      throw new Error(`parse desync: did not land on EOF (${buf.length})`);
  } catch (e) {
    // lenient: a tail block (often an animated/rarely-used mesh) can desync; keep the
    // geometry parsed so far, which is all the renderer needs
    if (!lenient || !blocks.some(b => b && b.kind === 'NiTriShapeData')) throw e;
  }
  if (debug) blocks.forEach((b, i) => console.error(`#${i} ${types[typeIdx[i]]} name=${JSON.stringify(b && b.name || '')}${b && b.resyncTo ? ` (resync ${b.resyncFrom}->${b.resyncTo})` : ''}`));
  return { header, version, userVer, blocks, roots: [] };
}

// debug helpers below parse block bodies straight out of the middle of a file, so they must set
// the module version themselves — otherwise they read a 10.0.1.0 file with 20.0.0.4 field guards.
function setVersionFrom(buf) {
  let o = 0; while (buf[o] !== 0x0A) o++;
  return (V = buf.readUInt32LE(o + 1));
}

// debug: NIF_SCANDATA="from:to" scans for a plausible NiTriShapeData start (sane vertex
// and triangle counts, in-range indices, UVs in [-1,2]) and prints its parsed extent
if (process.env.NIF_SCANDATA && process.argv[1] && /nif\.mjs$/.test(process.argv[1])) {
  const [from, to] = process.env.NIF_SCANDATA.split(':').map(Number);
  const buf = fs.readFileSync(process.argv[2]);
  setVersionFrom(buf);
  for (let n = from; n < to; n++) {
    try {
      const r = new Reader(buf); r.o = n;
      const d = niTriShapeData(r);
      if (d.numVertices < 3 || d.numVertices > 20000) continue;
      if (!d.vertices.length || !d.triangles.length) continue;
      if (d.uvs.length !== d.numVertices) continue;
      if (!d.triangles.every(t => t[0] < d.numVertices && t[1] < d.numVertices && t[2] < d.numVertices)) continue;
      const uvok = d.uvs.every(u => u[0] > -2 && u[0] < 3 && u[1] > -2 && u[1] < 3);
      if (!uvok) continue;
      console.error(`data @${n}: verts=${d.numVertices} tris=${d.triangles.length} end=${r.o}`);
    } catch { /* keep scanning */ }
  }
  process.exit(0);
}

// debug: NIF_SCAN="from:to" scans that offset range for a plausible NiTriShape start
// (printable name, small property count, valid data ref) to locate a real block boundary
if (process.env.NIF_SCAN && process.argv[1] && /nif\.mjs$/.test(process.argv[1])) {
  const [from, to] = process.env.NIF_SCAN.split(':').map(Number);
  const buf = fs.readFileSync(process.argv[2]);
  setVersionFrom(buf);
  for (let n = from; n < to; n++) {
    try {
      const r = new Reader(buf); r.o = n;
      const nameLen = r.u32(); if (nameLen > 40) continue;
      const name = buf.toString('latin1', r.o, r.o + nameLen); r.o += nameLen;
      if (![...name].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127)) continue;
      const numExtra = r.u32(); if (numExtra > 8) continue; r.refs(numExtra);
      const ctrl = r.i32(); if (ctrl < -1 || ctrl > 100) continue;
      const flags = r.u16();
      const tr = r.vec3(), rot = r.mat33(), sc = r.f32();
      if (!(sc > 0.001 && sc < 1000)) continue;
      const numProps = r.u32(); if (numProps > 16) continue; r.refs(numProps);
      const coll = r.i32(); if (coll < -1 || coll > 100) continue;
      const data = r.i32(); if (data < 0 || data > 100) continue;
      console.error(`candidate @${n}: name=${JSON.stringify(name)} numProps=${numProps} dataRef=${data} scale=${sc.toFixed(3)} tr=[${tr.map(x=>x.toFixed(1))}]`);
    } catch { /* keep scanning */ }
  }
  process.exit(0);
}

// debug: NIF_FROM="index:offset" parses only the tail from a known block start with no
// error-catching, so a downstream parser bug shows exactly where it desyncs
if (process.env.NIF_FROM && process.argv[1] && /nif\.mjs$/.test(process.argv[1])) {
  const [idx, off] = process.env.NIF_FROM.split(':').map(Number);
  const buf = fs.readFileSync(process.argv[2]);
  // rebuild header context minimally
  let o = 0; while (buf[o] !== 0x0A) o++; o++;
  const ver = buf.readUInt32LE(o); V = ver; o += 4;
  if (ver >= 0x14000003) o += 1;                    // endian byte
  if (ver >= 0x0a000108) o += 4;                    // user version
  const numBlocks = buf.readUInt32LE(o); o += 4;
  const numTypes = buf.readUInt16LE(o); o += 2; const types = [];
  for (let i = 0; i < numTypes; i++) { const n = buf.readUInt32LE(o); o += 4; types.push(buf.toString('latin1', o, o + n)); o += n; }
  const typeIdx = []; for (let i = 0; i < numBlocks; i++) { typeIdx.push(buf.readUInt16LE(o) & 0x7fff); o += 2; }
  const r = new Reader(buf); r.o = off;
  for (let i = idx; i < numBlocks; i++) {
    const t = types[typeIdx[i]]; const start = r.o;
    const b = readBlock(r, t);
    console.error(`#${i} ${t} [${start}..${r.o}] name=${JSON.stringify(b && b.name || '')}`);
  }
  const nr = r.u32(); for (let i = 0; i < nr; i++) r.i32();
  console.error(`footer end=${r.o} len=${buf.length} clean=${r.o === buf.length}`);
  process.exit(0);
}

if (process.argv[1] && /nif\.mjs$/.test(process.argv[1]) && process.argv[2]) {
  const res = parseNif(fs.readFileSync(process.argv[2]), true);
  const shapes = res.blocks.filter(b => b.kind === 'NiTriShapeData');
  console.error(`OK: ${res.blocks.length} blocks; ${shapes.length} trishape-data; verts ${shapes.map(s => s.numVertices)}`);
}
