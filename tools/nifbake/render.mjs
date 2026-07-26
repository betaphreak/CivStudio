// Render a Civ4 feature .nif to a 2D billboard sprite (RGBA PNG with alpha), by
// software-rasterizing its textured triangles in an orthographic front view. Used to
// give map features whose art is 3D-model-only (cactus, very-tall-grass) real sprites,
// the way the *_1024.dds billboards do for trees. See tools/nifbake/README.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseNif } from './nif.mjs';
import { decodeDds } from '../../web/dds.mjs';

// ---- scene assembly: compose world transforms, gather textured triangles ----
function apply(t, v) {                       // world = R*(s*v) + T, row-major R
  const [x, y, z] = [v[0] * t.s, v[1] * t.s, v[2] * t.s], R = t.R;
  return [
    R[0] * x + R[1] * y + R[2] * z + t.T[0],
    R[3] * x + R[4] * y + R[5] * z + t.T[1],
    R[6] * x + R[7] * y + R[8] * z + t.T[2],
  ];
}
function compose(p, l) {                      // parent ∘ local
  const R = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    R[i * 3 + j] = p.R[i * 3] * l.R[j] + p.R[i * 3 + 1] * l.R[3 + j] + p.R[i * 3 + 2] * l.R[6 + j];
  const Tl = apply(p, l.T);
  return { T: Tl, R, s: p.s * l.s };
}
const local = b => ({ T: b.translation, R: b.rotation, s: b.scale });
const ID = { T: [0, 0, 0], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], s: 1 };

function gatherTriangles(nif, opts = {}) {
  const B = nif.blocks;
  const referenced = new Set();
  B.forEach(b => (b && b.children || []).forEach(c => referenced.add(c)));
  const tris = [];
  function walk(idx, world) {
    const b = B[idx]; if (!b) return;
    const w = compose(world, local(b));
    if (b.kind === 'NiTriShape' && B[b.data] && B[b.data].kind === 'NiTriShapeData') {
      const g = B[b.data];
      const wv = g.vertices.map(v => apply(w, v));
      // skip a near-horizontal ground/pad plane (its vertical extent is small next to its
      // footprint) — we want the upright plant, not the base it sits on
      let xr = [1e9, -1e9], yr = [1e9, -1e9], zr = [1e9, -1e9];
      for (const p of wv) { xr = [Math.min(xr[0], p[0]), Math.max(xr[1], p[0])]; yr = [Math.min(yr[0], p[1]), Math.max(yr[1], p[1])]; zr = [Math.min(zr[0], p[2]), Math.max(zr[1], p[2])]; }
      const zext = zr[1] - zr[0], foot = Math.max(xr[1] - xr[0], yr[1] - yr[0]);
      if (process.env.NIF_DEBUG) console.error(`  trishape verts=${g.vertices.length} tris=${g.triangles.length} xext=${(xr[1]-xr[0]).toFixed(1)} yext=${(yr[1]-yr[0]).toFixed(1)} zext=${zext.toFixed(1)}`);
      // 'low' keeps spreading low plants (grass/wheat), dropping only flat ground quads;
      // default drops any near-horizontal plane so an upright plant (cactus) stands alone
      const flat = opts.flat === 'low' ? zext < 2 : zext < 0.28 * foot;
      if (process.env.NIF_NOFILTER || !flat)
        for (const t of g.triangles)
          tris.push({ p: [wv[t[0]], wv[t[1]], wv[t[2]]], uv: [g.uvs[t[0]], g.uvs[t[1]], g.uvs[t[2]]] });
    }
    (b.children || []).forEach(c => walk(c, w));
  }
  B.forEach((b, i) => { if (b && (b.kind === 'NiNode' || b.kind === 'NiTriShape') && !referenced.has(i)) walk(i, ID); });
  return tris;
}

// ---- rasterize an orthographic front view (X right, Z up, Y = depth) ----
function render(tris, tex, size) {
  let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
  for (const t of tris) for (const p of t.p) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[2]); maxz = Math.max(maxz, p[2]); }
  const wspan = maxx - minx, hspan = maxz - minz, span = Math.max(wspan, hspan) || 1;
  const pad = size * 0.06, sc = (size - 2 * pad) / span;
  const W = Math.max(8, Math.round(wspan * sc + 2 * pad)), H = Math.max(8, Math.round(hspan * sc + 2 * pad));
  const px = x => pad + (x - minx) * sc, py = z => H - pad - (z - minz) * sc;   // Z up → image up
  const rgba = Buffer.alloc(W * H * 4), depth = new Float32Array(W * H).fill(1e9);
  const TW = tex.width, TH = tex.height, td = tex.rgba;
  const sample = (u, v) => {
    let sx = Math.floor((u - Math.floor(u)) * TW), sy = Math.floor((v - Math.floor(v)) * TH);
    if (sx < 0) sx += TW; if (sy < 0) sy += TH; const o = (sy * TW + sx) * 4;
    return [td[o], td[o + 1], td[o + 2], td[o + 3]];
  };
  for (const t of tris) {                     // scanline-fill each triangle, depth = mean Y
    const A = [px(t.p[0][0]), py(t.p[0][2])], Bp = [px(t.p[1][0]), py(t.p[1][2])], C = [px(t.p[2][0]), py(t.p[2][2])];
    const meanY = (t.p[0][1] + t.p[1][1] + t.p[2][1]) / 3;
    const x0 = Math.max(0, Math.floor(Math.min(A[0], Bp[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], Bp[0], C[0])));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], Bp[1], C[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(A[1], Bp[1], C[1])));
    const d = (Bp[1] - C[1]) * (A[0] - C[0]) + (C[0] - Bp[0]) * (A[1] - C[1]); if (Math.abs(d) < 1e-6) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l0 = ((Bp[1] - C[1]) * (x - C[0]) + (C[0] - Bp[0]) * (y - C[1])) / d;
      const l1 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d;
      const l2 = 1 - l0 - l1;
      if (l0 < -0.001 || l1 < -0.001 || l2 < -0.001) continue;
      const u = l0 * t.uv[0][0] + l1 * t.uv[1][0] + l2 * t.uv[2][0];
      const v = l0 * t.uv[0][1] + l1 * t.uv[1][1] + l2 * t.uv[2][1];
      const [r, g, bl, a] = sample(u, v); if (a < 40) continue;
      const idx = y * W + x; if (meanY >= depth[idx]) continue; depth[idx] = meanY;
      const o = idx * 4; rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl; rgba[o + 3] = a;
    }
  }
  return { W, H, rgba };
}

// trim to the alpha bounding box
function trim(img) {
  const { W, H, rgba } = img; let minx = W, maxx = 0, miny = H, maxy = 0, any = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rgba[(y * W + x) * 4 + 3] > 8) { any = true; minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  if (!any) return img;
  const w = maxx - minx + 1, h = maxy - miny + 1, out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) rgba.copy(out, y * w * 4, ((miny + y) * W + minx) * 4, ((miny + y) * W + minx) * 4 + w * 4);
  return { W: w, H: h, rgba: out };
}

// ---- PNG encode (RGBA) ----
function crc32(buf) { let c, t = crc32.t; if (!t) { t = crc32.t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } } let x = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) x = t[(x ^ buf[i]) & 0xFF] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
export function encodePng(W, H, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * H); for (let y = 0; y < H; y++) rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, y * W * 4 + W * 4);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function renderNif(nifPath, texPath, size = 128, opts = {}) {
  const nif = parseNif(fs.readFileSync(nifPath), false, true);   // lenient: tolerate tail desync
  const tris = gatherTriangles(nif, opts);
  const tex = decodeDds(fs.readFileSync(texPath));
  return render(tris, tex, size);   // untrimmed, so components stay spatially separated
}

// 4-connected components on the alpha channel — each spatially-separate plant becomes one
// sprite (the render leaves transparent gaps between the models' plants)
function components(img, minSide = 12, minArea = 60) {
  const { W, H, rgba } = img, lab = new Uint8Array(W * H), comps = [], stack = [];
  const A = 40;
  for (let y0 = 0; y0 < H; y0++) for (let x0 = 0; x0 < W; x0++) {
    const s = y0 * W + x0; if (lab[s] || rgba[s * 4 + 3] < A) continue;
    let minx = x0, maxx = x0, miny = y0, maxy = y0, area = 0; lab[s] = 1; stack.length = 0; stack.push(s);
    while (stack.length) {
      const p = stack.pop(), px = p % W, py = (p / W) | 0; area++;
      if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
      if (px > 0 && !lab[p - 1] && rgba[(p - 1) * 4 + 3] >= A) { lab[p - 1] = 1; stack.push(p - 1); }
      if (px < W - 1 && !lab[p + 1] && rgba[(p + 1) * 4 + 3] >= A) { lab[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && !lab[p - W] && rgba[(p - W) * 4 + 3] >= A) { lab[p - W] = 1; stack.push(p - W); }
      if (py < H - 1 && !lab[p + W] && rgba[(p + W) * 4 + 3] >= A) { lab[p + W] = 1; stack.push(p + W); }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (bw >= minSide && bh >= minSide && area >= minArea) comps.push({ minx, miny, bw, bh });
  }
  return comps;
}

// render one or more model variants, extract their plants as sprites, and pack them into a
// single horizontal strip PNG (the TREES atlas format: {src, w, h, sprites:[[x,y,w,h]]})
//
// `opts.baseFade` (a fraction of each sprite's height, 0 = off) ramps the ALPHA out over the sprite's
// bottom rows, so the model dissolves into the ground instead of ending at the quad's edge.
//
// WHY THIS BELONGS AT BAKE TIME, and why only some groups want it. A billboard is a front elevation
// with a hard bottom row, and for a MOUNTAIN — 320px tall, wider than the contact shadow under it —
// that row is a visible straight cut where rock meets grass, which no shadow blob reaches. Fading the
// alpha here costs nothing at runtime and cannot desynchronise from the renderer, because both the
// committed bake (tools/fpk/bake-peaks.mjs) and web/build.mjs go through this one function.
//
// A TREE must NOT have it: its bottom rows are the trunk, and a trunk that fades out is a shrub
// hovering over the ground. So the fraction lives on the GROUP record (PEAK_GROUP.baseFade) rather
// than being a global of this module — it is a property of the art, not of the baker.
export function bakeNifGroup(variants, name, webAssets, size = 220, opts = {}) {
  const sheets = variants.map(v => ({ img: renderNif(v.nif, v.tex, size, opts) }));
  const all = [];
  for (const s of sheets) for (const c of components(s.img)) all.push({ img: s.img, c });
  all.sort((a, b) => b.c.bw * b.c.bh - a.c.bw * a.c.bh);
  const chosen = all.slice(0, 12);
  if (!chosen.length) return null;
  const GAP = 1, maxH = Math.max(...chosen.map(x => x.c.bh));
  let totW = 0; for (const x of chosen) totW += x.c.bw + GAP;
  const rgba = Buffer.alloc(totW * maxH * 4); const sprites = []; let ox = 0;
  for (const { img, c } of chosen) {
    // rows over which the alpha ramps to nothing, measured from this sprite's own base
    const fadeRows = Math.max(0, Math.round((opts.baseFade || 0) * c.bh));
    for (let y = 0; y < c.bh; y++) {
      // Smoothstep, not linear: a linear ramp starts with a slope discontinuity, which on a 320px
      // sprite is itself a faint horizontal line — the artefact this exists to remove, moved upward.
      let a = 1;
      if (fadeRows && y >= c.bh - fadeRows) {
        const t = (c.bh - 1 - y) / fadeRows;         // 1 at the top of the ramp, 0 on the last row
        a = t * t * (3 - 2 * t);
      }
      for (let x = 0; x < c.bw; x++) {
        const so = ((c.miny + y) * img.W + (c.minx + x)) * 4, d = (y * totW + ox + x) * 4;
        // RGB is copied through unfaded. It is what bleeds under a lossy WebP's transparent pixels,
        // and rock bleeding into rock is invisible; zeroing it would put a dark rim on the base.
        rgba[d] = img.rgba[so]; rgba[d + 1] = img.rgba[so + 1]; rgba[d + 2] = img.rgba[so + 2];
        rgba[d + 3] = a === 1 ? img.rgba[so + 3] : Math.round(img.rgba[so + 3] * a);
      }
    }
    sprites.push([ox, 0, c.bw, c.bh]); ox += c.bw + GAP;
  }
  // let the caller encode the atlas (build.mjs routes it to WebP via opts.emit(name, w, h, rgba));
  // absent one, fall back to writing the PNG directly (the standalone/debug path).
  if (opts.emit) return { src: opts.emit(name, totW, maxH, rgba), w: totW, h: maxH, sprites };
  const file = `trees-${name}.png`;
  fs.writeFileSync(path.join(webAssets, file), encodePng(totW, maxH, rgba));
  return { src: `assets/${file}`, w: totW, h: maxH, sprites };
}

// ================================ road / route mode =================================
// Roads differ from the tree/cactus billboards in two ways the front-view renderNif can't
// handle, so they get their own path (see docs/route-rendering.md):
//   1. They lie FLAT on the ground (the mesh spans X-Y at Z≈0), so we project TOP-DOWN —
//      image X = world X, image Y = world Y, higher Z wins — not the X-Z front view.
//   2. The stock parseNif resync rejects them: a road's NiTriShape and its NiTriShapeData
//      are separated by a 7-block run (texturing/material/alpha + an animated-alpha
//      NiAlphaController→NiFloatInterpolator→NiFloatData chain with no parser), and the
//      resync's sane() UV bound (0..3, tuned for 0..1 billboards) rejects the road's
//      TILING UVs (V repeats down a segment). So we locate the geometry directly, by
//      scanning for the NiTriShapeData whose parse consumes EXACTLY to EOF — a strong,
//      self-contained lock that needs no resync heuristic.

// Read a length-prefixed vec/scalar stream as a NiTriShapeData starting at byte `off`; return
// the geometry (verts/uvs/tris) iff it parses and consumes to EOF, else null. Mirrors
// niGeometryData/niTriShapeData in nif.mjs for the 20.0.0.4, no-normals road layout.
function routeGeomAt(buf, off) {
  let o = off;
  const u16 = () => { const v = buf.readUInt16LE(o); o += 2; return v; };
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const i32 = () => { const v = buf.readInt32LE(o); o += 4; return v; };
  const u8 = () => buf[o++];
  const f32 = () => { const v = buf.readFloatLE(o); o += 4; return v; };
  const bool = () => u8() !== 0;
  const vec3 = () => [f32(), f32(), f32()];
  try {
    i32();                                             // Group ID
    const nv = u16(); if (nv < 3 || nv > 5000) return null;
    u8(); u8();                                        // Keep / Compress flags
    if (!bool()) return null;                          // Has Vertices
    const verts = []; for (let i = 0; i < nv; i++) verts.push(vec3());
    const vflags = u16(); const hasN = bool();
    if (hasN) for (let i = 0; i < nv; i++) vec3();
    if (hasN && (vflags & 4096)) for (let i = 0; i < nv * 2; i++) vec3();
    vec3(); f32();                                     // Center, Radius
    if (bool()) for (let i = 0; i < nv; i++) { f32(); f32(); f32(); f32(); }  // Colors
    const numUV = vflags & 63; const uvs = [];
    for (let s = 0; s < numUV; s++) { const set = []; for (let i = 0; i < nv; i++) set.push([f32(), f32()]); if (s === 0) uvs.push(...set); }
    u16(); i32();                                      // Consistency, Additional Data ref
    const ntri = u16(); u32(); const hasT = bool();
    const tris = []; if (hasT) for (let i = 0; i < ntri; i++) tris.push([u16(), u16(), u16()]);
    if (!tris.length || !tris.every(t => t[0] < nv && t[1] < nv && t[2] < nv)) return null;
    if (uvs.length !== nv) return null;
    const numMatch = u16(); for (let i = 0; i < numMatch; i++) { const n = u16(); for (let j = 0; j < n; j++) u16(); }
    const numRoots = u32(); if (numRoots > 1000) return null; for (let i = 0; i < numRoots; i++) i32();
    if (o !== buf.length) return null;                 // consumed exactly to EOF → the real block
    return { nv, verts, uvs, tris };
  } catch { return null; }
}
function findRouteGeom(buf) {
  for (let o = 100; o < buf.length - 20; o++) { const g = routeGeomAt(buf, o); if (g) return g; }
  return null;
}

// top-down raster of a flat route quad; the texture WRAPS (roads tile their surface down
// the segment). Two placements:
//  • `square` given (a world half-extent): render into a fixed `size`×`size` cell mapping world
//    [-square,square]² → the cell, CENTERED and UNTRIMMED. This registers every piece of a tier
//    to one plot cell so connections reach the same edges and a 90°-rotation stays aligned — the
//    form the per-plot grid renderer needs (docs/route-rendering.md).
//  • otherwise: fit the piece's own bbox and trim to alpha (compact, for standalone/debug).
function renderRoute(g, tex, size, square) {
  const { verts, uvs, tris } = g;
  let W, H, px, py;
  if (square) {
    W = H = size;
    const sc = (size - 2) / (2 * square), cx = size / 2, cy = size / 2;
    px = x => cx + x * sc; py = y => cy - y * sc;                 // world origin → cell centre; +Y up
  } else {
    let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
    for (const p of verts) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1]); }
    const wspan = mxx - mnx, hspan = mxy - mny, span = Math.max(wspan, hspan) || 1;
    const pad = 1, sc = (size - 2 * pad) / span;
    W = Math.max(4, Math.round(wspan * sc + 2 * pad)); H = Math.max(4, Math.round(hspan * sc + 2 * pad));
    px = x => pad + (x - mnx) * sc; py = y => H - pad - (y - mny) * sc;   // world +Y (North) → image up
  }
  const rgba = Buffer.alloc(W * H * 4), depth = new Float32Array(W * H).fill(-1e9);
  const TW = tex.width, TH = tex.height, td = tex.rgba;
  const sample = (u, v) => {
    let sx = Math.floor((u - Math.floor(u)) * TW), sy = Math.floor((v - Math.floor(v)) * TH);
    if (sx < 0) sx += TW; if (sy < 0) sy += TH; const q = (sy * TW + sx) * 4;
    return [td[q], td[q + 1], td[q + 2], td[q + 3]];
  };
  for (const t of tris) {
    const A = [px(verts[t[0]][0]), py(verts[t[0]][1])], B = [px(verts[t[1]][0]), py(verts[t[1]][1])], C = [px(verts[t[2]][0]), py(verts[t[2]][1])];
    const meanZ = (verts[t[0]][2] + verts[t[1]][2] + verts[t[2]][2]) / 3;
    const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]); if (Math.abs(d) < 1e-6) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l0 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / d;
      const l1 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d;
      const l2 = 1 - l0 - l1;
      if (l0 < -0.001 || l1 < -0.001 || l2 < -0.001) continue;
      const u = l0 * uvs[t[0]][0] + l1 * uvs[t[1]][0] + l2 * uvs[t[2]][0];
      const v = l0 * uvs[t[0]][1] + l1 * uvs[t[1]][1] + l2 * uvs[t[2]][1];
      const [r, gg, bl, a] = sample(u, v); if (a < 8) continue;
      const idx = y * W + x; if (meanZ <= depth[idx]) continue; depth[idx] = meanZ;
      const q = idx * 4; rgba[q] = r; rgba[q + 1] = gg; rgba[q + 2] = bl; rgba[q + 3] = a;
    }
  }
  return square ? { W, H, rgba } : trim({ W, H, rgba });   // fixed cells keep their registration
}

/**
 * Render one flat Civ4 route segment .nif to a top-down 2D sprite. Returns {W,H,rgba}, or null if
 * the geometry can't be located / the texture is unreadable. With `opts.square` (a world
 * half-extent, e.g. from {@link routeHalfExtent}) it renders a registered, untrimmed `size`×`size`
 * plot cell (for the grid renderer); otherwise a compact alpha-trimmed sprite. See
 * docs/route-rendering.md; build.mjs `bakeRoutes` packs these into per-tier atlases.
 */
export function renderRouteNif(nifPath, texPath, size = 96, opts = {}) {
  const g = findRouteGeom(fs.readFileSync(nifPath));
  if (!g) return null;
  const tex = decodeDds(fs.readFileSync(texPath));
  return renderRoute(g, tex, size, opts.square);
}

/**
 * The plot half-extent of a route segment mesh — max(|x|,|y|) over its vertices, i.e. how far the
 * road reaches toward the plot edge. Measured on a tier's straight piece, it's the common `square`
 * every piece of that tier is rendered at so they share one registered cell. Null if no geometry.
 */
export function routeHalfExtent(nifPath) {
  const g = findRouteGeom(fs.readFileSync(nifPath));
  if (!g) return null;
  let e = 0;
  for (const [x, y] of g.verts) e = Math.max(e, Math.abs(x), Math.abs(y));
  return e;
}

// Debug CLI:  node render.mjs <nif> <tex> <out.png> [size]           (front-view feature)
//             node render.mjs --route <nif> <tex> <out.png> [size]   (top-down route)
if (process.argv[1] && /render\.mjs$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const route = args[0] === '--route';
  const [nifPath, texPath, out, size] = route ? args.slice(1) : args;
  const img = route ? renderRouteNif(nifPath, texPath, +size || 96) : renderNif(nifPath, texPath, +size || 128);
  fs.writeFileSync(out, encodePng(img.W, img.H, img.rgba));
  console.error(`rendered ${route ? 'route ' : ''}${path.basename(nifPath)} -> ${out} (${img.W}x${img.H})`);
}
