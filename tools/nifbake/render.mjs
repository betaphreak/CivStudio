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

// The texture file a shape is skinned with: its NiTexturingProperty's base texture → that
// NiSourceTexture's file name. Null when the link is missing (an older parse where the property
// blocks were skipped as a gap, or a shape with no texturing property), which the caller reads as
// "use the single fallback texture" — the behaviour every bake had before multi-material support.
function shapeTexture(B, shape) {
  for (const p of shape.props || []) {
    const prop = B[p];
    if (!prop || prop.kind !== 'NiTexturingProperty' || !(prop.base >= 0)) continue;
    const src = B[prop.base];
    if (src && src.file) return src.file;
  }
  return null;
}

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
      // default drops any near-horizontal plane so an upright plant (cactus) stands alone.
      // 'keep' drops NOTHING — for GROUND improvements, where the near-horizontal plane is not a
      // base to discard but the entire subject: a farm is a field, and filtering it leaves the
      // gate and fence posts standing alone, which is what an_eu_farm01 baked to for as long as
      // this filter applied to it (docs/terrain-3d.md §P5a).
      const flat = opts.flat === 'keep' ? false
        : opts.flat === 'low' ? zext < 2 : zext < 0.28 * foot;
      const tex = shapeTexture(B, b);
      if (process.env.NIF_NOFILTER || !flat)
        for (const t of g.triangles)
          tris.push({ p: [wv[t[0]], wv[t[1]], wv[t[2]]], uv: [g.uvs[t[0]], g.uvs[t[1]], g.uvs[t[2]]], tex });
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
  // `tex` is either one decoded texture (single-material: trees, peaks — every bake before P5a) or a
  // {name -> decoded} map plus a `fallback`, for a model whose meshes name different skins. A farm is
  // barn.dds + farm_light.dds + farm_shadow.dds; skinning all three with one of them is what made the
  // committed imp-farm.webp a sheet of planks.
  const one = tex && tex.rgba ? tex : null;
  const pick = t => one || tex.byName[t.tex] || tex.fallback;
  const sample = (skin, u, v) => {
    const TW = skin.width, TH = skin.height, td = skin.rgba;
    let sx = Math.floor((u - Math.floor(u)) * TW), sy = Math.floor((v - Math.floor(v)) * TH);
    if (sx < 0) sx += TW; if (sy < 0) sy += TH; const o = (sy * TW + sx) * 4;
    return [td[o], td[o + 1], td[o + 2], td[o + 3]];
  };
  for (const t of tris) {                     // scanline-fill each triangle, depth = mean Y
    const skin = pick(t); if (!skin) continue;
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
      const [r, g, bl, a] = sample(skin, u, v); if (a < 40) continue;
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

// Rotate a triangle's world vertices about the X axis by `deg`, so the orthographic front view that
// follows becomes an OBLIQUE view — the camera's own angle rather than an elevation.
//
// This is what makes ground art renderable at all. The front view (X right, Z up, Y depth) sees a
// flat improvement edge-on: a farm's field has almost no Z extent, so it collapses to a line and the
// sprite is whatever happens to stand up around it. Pitching the model over by the angle the map
// camera actually reaches (band-math.TILT_MAX = 58°, Civ4's own CAMERA_LOWER_PITCH) shows the field
// in the same foreshortening the player sees it in. 0° leaves every existing bake byte-identical.
function pitchTriangles(tris, deg) {
  if (!deg) return tris;
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const rot = ([x, y, z]) => [x, y * c - z * s, y * s + z * c];
  return tris.map(t => ({ ...t, p: t.p.map(rot) }));   // ...t: keep `tex` — dropping it re-skins the model
}

/**
 * Decode every skin the gathered triangles name, resolving each against the model's own directory
 * (which is where Civ4 keeps them — `barn.dds` beside `an_eu_farm01.nif`). A name that will not
 * resolve or decode is dropped to the fallback rather than failing the bake: a missing skin should
 * cost one mesh its texture, not the whole model its render.
 */
function decodeSkins(nifPath, texPath, tris) {
  const fallback = texPath ? decodeDds(fs.readFileSync(texPath)) : null;
  const names = new Set(tris.map(t => t.tex).filter(Boolean));
  if (!names.size) return fallback;                     // single-material: the pre-P5a path, unchanged
  const dir = path.dirname(nifPath), byName = {};
  for (const n of names) {
    const file = path.join(dir, path.basename(n));
    try { byName[n] = decodeDds(fs.readFileSync(file)); }
    catch { if (process.env.NIF_DEBUG) console.error(`  skin not resolved: ${n}`); }
  }
  return { byName, fallback };
}

export function renderNif(nifPath, texPath, size = 128, opts = {}) {
  const nif = parseNif(fs.readFileSync(nifPath), false, true);   // lenient: tolerate tail desync
  const tris = pitchTriangles(gatherTriangles(nif, opts), opts.pitch || 0);
  return render(tris, decodeSkins(nifPath, texPath, tris), size);   // untrimmed: components stay separated
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
// THE TOP-DOWN PROJECTION IS GONE (2026-07-27). This renderer had a second path — renderRouteNif /
// renderRoute / routeGeomAt / findRouteGeom / routeHalfExtent, ~130 lines — that projected a road
// mesh from above (image X = world X, image Y = world Y) instead of viewing it with a camera, plus
// its own hand-rolled geometry locator to get around the resync. It existed for one consumer, the
// route atlas bake, and it was the one thing here that was not a view of a model. Routes are vector
// ribbons now (web/js/route-ribbon.mjs), which need no art and drape on the 3D terrain, so the path
// and its three committed WebP atlases went with it. See docs/terrain-3d.md §The top-down projector
// goes, and routes become ribbons.

// Debug CLI:  node render.mjs <nif> <tex> <out.png> [size]
if (process.argv[1] && /render\.mjs$/.test(process.argv[1])) {
  const [nifPath, texPath, out, size] = process.argv.slice(2);
  const img = renderNif(nifPath, texPath, +size || 128);
  fs.writeFileSync(out, encodePng(img.W, img.H, img.rgba));
  console.error(`rendered ${path.basename(nifPath)} -> ${out} (${img.W}x${img.H})`);
}
