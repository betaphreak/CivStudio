"use strict";
// THE 3D GROUND — docs/terrain-3d.md §The plan → P1.
//
// From band 5 up, the back of the frame — the sea base, the baked raster, the plot layer — is drawn here
// as real geometry under a real light instead of three canvas-2D blits. Everything else in the scene is
// untouched and still paints on #map, above this canvas.
//
// WHY THE GROUND, AND ONLY THE GROUND. The PixiJS attempt died because #gl sat beneath #map behind a
// wall of opaque full-area fills, which forced a strictly back-to-front migration; the plot layer was
// entry 3 of ~20 and could never ship unflagged (docs/pixi-migration-plan.md §The two structural
// findings). The cut here is different in kind: 3D takes the three backmost layers WHOLESALE, so nothing
// opaque is left above it and there is no ordering to negotiate. Those three, in their existing order,
// are the three things in the scene below — sea plane, raster plane, province meshes.
//
// AT TILT 0 THIS MUST BE THE SAME PICTURE. The camera is an OrthographicCamera whose frustum is read off
// core.unproject, so it reproduces baseXr/baseYr exactly rather than approximately; the province meshes
// are textured with the very canvases plots.mjs already bakes; and the sea samples the same seaColorAt
// down the same Mercator latitudes. That is what makes P1's acceptance test a frame diff instead of a
// judgement call, leaving the geometry — the entire point — as the only thing that changed.
//
// THREE IS LOADED LAZILY. The vendored build is 751 KB (188 KB gzipped) and `web/` has no bundler, so a
// static import would put it on every page load's critical path to serve a band most sessions never
// reach. It is fetched by dynamic import the first time the camera crosses into band 5.
import { P, MAP, VIEW, unproject, latAtSourceY, isUnderground, provSrcBox, SEA_BANDS } from "./core.mjs";
import { ground3D, set3DAvailable } from "./bands.mjs";
import { draw } from "./repaint.mjs";
import { seaColorAt } from "./sea.mjs";
import { HEIGHT, indexPlots, smoothCornerAt } from "./heightfield.mjs";

let THREE = null;                 // the vendored module namespace, once loaded
let loading = false, failed = false;
let renderer = null, scene = null, camera = null, sun = null, ambient = null;
const canvas = document.getElementById("gl");

// The global plot-height index (heightfield.mjs): source pixel → height, fed by each province as its
// plots land. Corner heights are derived from it on demand, so a mesh built before its neighbour arrives
// simply has fewer contributions at the shared border, and is rebuilt when the neighbour lands.
const heights = new Map();
const indexed = new Set();        // province ids already folded into `heights`
const meshes = new Map();         // province id → THREE.Mesh
const dirty = new Set();          // province ids whose geometry must be rebuilt (a neighbour landed)

const CAM_Y = 20000;              // ortho: the height only has to clear the terrain and stay in near/far
const SEA_Y = 0;                  // sea level. plotHeight puts all land above it (no floor subtraction)
const RASTER_Y = 0.02;            // the blurred fallback raster, a hair above the water
// ---- lighting, from the spike's tuning (tools/spike-iso3d → shot-civ-oblique.png) ----
//
// GAIN is the one number the spike could not supply. Its values were judged on a single province floating
// in a dark void, where "is this too dim?" has no reference; here the terrain has to sit at the SAME
// brightness as the texture the 2D path blits, or switching bands reads as the sun going down. Measured
// with tools/webverify/terrain3d-verify.mjs (which reports lit ÷ unlit mean luminance), the spike's
// intensities render the ground at 0.66 of its texture — three's lights are in physically-correct units
// and a Lambert BRDF carries a 1/π, so plausible-looking numbers come out dark.
//
// One scalar corrects it, and the RATIO between sun and ambient — which is what the spike actually
// established, and what decides how strongly relief reads — is preserved.
//
// Mind the exponent when recalibrating. Lighting is computed in LINEAR space and converted to sRGB on
// output, so a gain of g moves the measured (sRGB) brightness by g^(1/2.2), not by g. A first attempt at
// GAIN = 1/0.66 = 1.52 duly landed at 0.80 rather than 1.00, which is exactly what the exponent predicts.
// The correction is GAIN /= ratio^2.2 — so from 0.66 the answer is (1/0.66)^2.2 ≈ 2.5.
const GAIN = 2.5;
const SUN = { az: 315, alt: 38, colour: 0xfff3e0, intensity: 2.1 * GAIN };
const AMBIENT = { colour: 0x8fa8c8, intensity: 0.55 * GAIN };
// Flat lighting is P1's ACCEPTANCE MODE, not a debug toy: it renders each mesh UNLIT, so the surface emits
// its texture and nothing else — which is exactly what the 2D path's blit does. The frame diff then
// isolates the projection and the texturing from the shading, and only once that passes is the sun worth
// judging.
//
// UNLIT MEANS MeshBasicMaterial, not "a Lambert surface under a white ambient light". Two attempts at the
// latter cost a round each: the ambient's own blue-grey scene colour (0x8fa8c8 ≈ 0.56, 0.66, 0.78)
// multiplies the texture down and tints it, and even a pure-white ambient at intensity 1 leaves a uniform
// factor from three's physically-correct light units and Lambert's 1/π BRDF. Both read on a screenshot as
// "the 3D ground is too dark" and on the diff as a large near-uniform delta — a lighting artifact wearing
// the costume of a projection bug. Taking the lighting model out of the comparison entirely is the only
// version of this gate that measures what it claims to.
let flatLit = false;
export function setFlatLighting(on) {
  const was = flatLit;
  flatLit = !!on;
  if (was === flatLit) return;
  for (const m of meshes.values()) {                       // reclothe whatever is already built
    const old = m.material;
    m.material = materialFor(old.map);
    old.dispose();
  }
}
/** The ground material: unlit in the acceptance mode, Lambert (so relief reads under the sun) otherwise.
 *  Sampling (nearest vs mipmapped-linear) is a property of the TEXTURE, set once in groundTexture, so it
 *  survives a material swap untouched. */
function materialFor(tex) {
  return flatLit
    ? new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
    : new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
}

/** Load three (once) and build the scene. Returns true when the renderer is ready to draw. */
function ensureRenderer() {
  if (renderer) return true;
  if (failed || loading || !canvas) return false;
  // WebGL absent → fall back for good. There is no separate degraded mode to write: ground3D() goes
  // false, so the canvas-2D ground that serves bands 0-4 serves every band.
  if (!(canvas.getContext("webgl2") || canvas.getContext("webgl"))) {
    failed = true; set3DAvailable(false); return false;
  }
  loading = true;
  import("./vendor/three.module.min.js").then(mod => {
    THREE = mod;
    build();
    loading = false;
    draw();                       // the band that asked for this is still on screen — paint it now
  }).catch(e => {
    console.error("terrain3d: three failed to load", e);
    failed = true; loading = false; set3DAvailable(false);
    draw();                       // repaint with the 2D ground restored, rather than leaving a hole
  });
  return false;
}

function build() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  // Both are three's defaults, set explicitly because the whole phase rests on this canvas reproducing
  // the 2D one's colours: any tone mapping, or an output space that disagreed with the textures' declared
  // SRGBColorSpace, would shift every pixel of the ground and there would be no way to tell that from a
  // texturing error. Pinning them means a future three upgrade changing a default cannot quietly do it.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  // Looking straight down -Y with up = -Z, so world +X is screen-right and world +Z is screen-DOWN,
  // matching source-pixel space where y grows southward. syncCamera then only sets the frustum.
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, CAM_Y + 1000);
  camera.position.set(0, CAM_Y, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);

  sun = new THREE.DirectionalLight(SUN.colour, SUN.intensity);
  ambient = new THREE.AmbientLight(AMBIENT.colour, AMBIENT.intensity);
  const a = SUN.az * Math.PI / 180, e = SUN.alt * Math.PI / 180, R = 1e5;
  sun.position.set(Math.cos(a) * Math.cos(e) * R, Math.sin(e) * R, Math.sin(a) * Math.cos(e) * R);
  scene.add(sun, ambient);
  setFlatLighting(flatLit);

  buildSeaPlane();
  buildRasterPlane();
  resize();
}

// ---- geometry helper ----
// Every flat quad in this module is built by hand rather than with PlaneGeometry. PlaneGeometry lies in
// XY facing +Z and carries OpenGL-convention UVs, so laying it into the XZ ground plane means reasoning
// about a rotation, three's flipY, and offset/repeat all at once — three chances to end up with a map
// that is silently mirrored north-south, which is exactly the kind of error a map viewer hides. Writing
// four vertices in source-pixel space with explicit UVs means ONE convention across this whole file:
// flipY = false, so v runs with the canvas's rows, southward. Same winding as the province quads.
function quadXZ(x0, y0, x1, y1, h, u1 = 1, v1 = 1) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([
    x0, h, y0,   x1, h, y0,   x1, h, y1,   x0, h, y1,      // NW, NE, SE, SW
  ], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([
    0, 0,   u1, 0,   u1, v1,   0, v1,                      // (0,0) at NW = the image's top-left
  ], 2));
  g.setIndex([0, 3, 2, 0, 2, 1]);
  g.computeVertexNormals();
  return g;
}
function groundTexture(src, nearest = false) {
  const t = src instanceof HTMLImageElement ? new THREE.Texture(src) : new THREE.CanvasTexture(src);
  t.flipY = false;                 // the one convention: texture row 0 is the north/top row
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = !nearest;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// ---- 1) the sea: the climate gradient ----
// drawSeaBase fills the viewport with a latitude gradient and multiplies a ripple over it — but the
// RIPPLE FADES OUT BY K_TEX (band 4) and 3D starts at band 5, so at every zoom this renderer is active
// the 2D sea is the bare gradient. Nothing is approximated away here.
//
// Baked in MAP space (one texel per source row, by latitude) rather than screen space, so it needs no
// camera term and is built once. At tilt 0 it samples identically to the 2D version — same seaColorAt,
// same Mercator inverse — at 512 rows against its 17 gradient stops.
function buildSeaPlane() {
  const H = 512;
  const c = document.createElement("canvas"); c.width = 1; c.height = H;
  const x = c.getContext("2d");
  if (SEA_BANDS) {
    for (let i = 0; i < H; i++) {
      x.fillStyle = seaColorAt(latAtSourceY(MAP.y0 + (i + 0.5) / H * (MAP.y1 - MAP.y0)));
      x.fillRect(0, i, 1, 1);
    }
  } else { x.fillStyle = "#090d14"; x.fillRect(0, 0, 1, H); }   // the same fallback the 2D path uses
  const tex = groundTexture(c);
  tex.minFilter = THREE.LinearFilter;                          // no mips on a 1×512 strip
  tex.generateMipmaps = false;
  const m = new THREE.Mesh(quadXZ(MAP.x0, MAP.y0, MAP.x1, MAP.y1, SEA_Y),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  scene.add(m);
}

// ---- 2) the baked raster ----
// This is drawRaster, moved, and it matters more than it looks: it is the FALLBACK for every province
// whose plots have not arrived. Without it, panning at band 5 would show open sea where the 2D path
// shows blurred terrain — a regression, not a rendering difference.
function buildRasterPlane() {
  const img = new Image();
  img.onload = () => {
    if (!scene) return;
    // drawRaster blits the source rect (0, 0, MAP.dw, MAP.dh), which may be a sub-rect of the asset, so
    // window the UVs the same way instead of assuming the image is exactly the used extent.
    const geo = quadXZ(MAP.x0, MAP.y0, MAP.x1, MAP.y1, RASTER_Y,
      MAP.dw / img.width, MAP.dh / img.height);
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: groundTexture(img), transparent: true, side: THREE.DoubleSide,
    })));
    draw();
  };
  img.src = MAP.src;
}

// ---- 3) the province meshes ----
// One geometry per province: a quad per plot that EXISTS, so the mesh carries the province's real
// silhouette (holes and all), with vertices on plot CORNERS at heights from the global index.
function buildGeometry(plots, box) {
  const pos = [], uv = [], idx = [];
  const vid = new Map();                    // lattice key → vertex index, so corners are shared
  const need = (lx, ly) => {
    const k = lx * 1e5 + ly;
    let v = vid.get(k);
    if (v !== undefined) return v;
    v = pos.length / 3;
    const h = smoothCornerAt(heights, lx, ly);
    pos.push(lx, h === null ? 0 : h, ly);   // X east, Z south, Y up — source-pixel units, no scaling
    // The texture spans source pixels [box.x0, box.x0 + box.w]. `box` is _tbox, which already includes
    // buildPlotTexCanvas's PAD of 2 cells of transparent margin — using plotBounds here instead would
    // shift every province's art by two plots.
    uv.push((lx - box.x0) / box.w, (ly - box.y0) / box.h);
    vid.set(k, v);
    return v;
  };
  for (const q of plots) {
    const a = need(q.x, q.y), b = need(q.x + 1, q.y), c = need(q.x + 1, q.y + 1), d = need(q.x, q.y + 1);
    idx.push(a, d, c, a, c, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();                 // the whole reason relief reads: real normals, real light
  return g;
}

/** Texture a province from the canvas plots.mjs already baked, keyed on the canvas OBJECT so
 *  invalidation is free: every rebuild allocates a fresh canvas, so the existing `p._tcanvas = null`
 *  hooks are all the cache invalidation this needs. (The one reusable lesson from the Pixi effort.) */
const texCache = new WeakMap();
function textureFor(cvs, nearest) {
  let t = texCache.get(cvs);
  if (!t) texCache.set(cvs, t = groundTexture(cvs, nearest));
  return t;
}

/** Fold a province's plots into the global height index, and mark its NEIGHBOURS for rebuild — their
 *  border corners can now average these plots too, which is what closes the cross-province seam. */
function indexProvince(p) {
  if (indexed.has(p.id) || !p._plots || !p._plots.length) return;
  indexed.add(p.id);
  // SEA/LAKE shelf plots carry elevation that means DEPTH, so they index flat — the shore then ramps
  // down to sea level instead of ending in a cliff the height of the continental heightmap.
  const water = p.type === "SEA" || p.type === "LAKE";
  if (!indexPlots(heights, p._plots, { flat: water })) return;
  const bb = provSrcBox(p);
  if (!bb) return;
  for (const o of P) {                      // anything whose bbox touches this one's, grown by a plot
    if (o === p || !meshes.has(o.id)) continue;
    const ob = provSrcBox(o);
    if (!ob) continue;
    if (ob.x1 + 1 < bb.x0 || ob.x0 - 1 > bb.x1 || ob.y1 + 1 < bb.y0 || ob.y0 - 1 > bb.y1) continue;
    dirty.add(o.id);
  }
}

// ---- the camera ----
// EXACT, not approximate. The 2D camera maps a source pixel to screen affinely and isotropically, so the
// visible world is a RECTANGLE in source space: read it off with core.unproject — the projector's own
// inverse from P0 — and make it the ortho frustum. With up = -Z, screen-right is +X and screen-DOWN is
// +Z, so the top of the viewport is the SMALLER source y and the frustum's `top` is its negation. Get
// that sign wrong and the world is mirrored north-south, which on a fictional map is easy to miss.
function syncCamera() {
  const [sx0, sy0] = unproject(0, 0);
  const [sx1, sy1] = unproject(VIEW.w, VIEW.h);
  camera.left = sx0; camera.right = sx1;
  camera.top = -sy0; camera.bottom = -sy1;
  camera.updateProjectionMatrix();
}

// GUARDED, because it is called every frame: setSize reallocates the drawing buffer, so doing it
// unconditionally at 30 fps would be a real cost for no change. Driven off VIEW rather than off a resize
// event, so the canvas cannot drift out of step with the 2D one whatever caused the size to change (the
// rail opening, a panel drag, a devicePixelRatio change on monitor switch).
let sizedW = 0, sizedH = 0, sizedDpr = 0;
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (!renderer || (VIEW.w === sizedW && VIEW.h === sizedH && dpr === sizedDpr)) return;
  sizedW = VIEW.w; sizedH = VIEW.h; sizedDpr = dpr;
  renderer.setPixelRatio(dpr);
  renderer.setSize(VIEW.w, VIEW.h, false);
}

/**
 * Bring the mesh set in line with what is loaded. Deliberately driven by the SAME state drawPlots
 * maintains — `p._plots`, `p._tcanvas`/`_tbox` — rather than by its own fetching and building:
 * drawPlots still runs every frame and only skips its blits (see plots.drawPlots), so the viewport cull,
 * the lazy loadPlots, the per-frame build budget and MAX_TEX_PLOTS all keep working untouched.
 */
function syncMeshes() {
  for (const p of P) {
    if (isUnderground(p)) continue;           // z=-1 is its own plane — P2 territory
    // A rebuild queued by a neighbour's arrival. Cleared on VISIT rather than in bulk at the end: this
    // loop walks all of P, so every queued id is reached, and clearing the set wholesale would silently
    // drop ids queued for provinces the loop had already passed.
    const stale = dirty.delete(p.id);
    const textured = !!p._tcanvas;
    const cvs = p._tcanvas || p._pcanvas;
    const box = textured ? p._tbox : p._pbox;
    if (!cvs || !box) { drop(p.id); continue; }
    indexProvince(p);
    let m = meshes.get(p.id);
    if (m && (stale || m.userData.cvs !== cvs)) { drop(p.id); m = null; }
    if (m) continue;
    const g = buildGeometry(p._plots, box);
    m = new THREE.Mesh(g, materialFor(textureFor(cvs, !textured)));
    m.userData = { cvs };
    meshes.set(p.id, m);
    scene.add(m);
  }
  // ids queued for provinces already passed this frame: one more paint picks them up, and the pass after
  // that finds the set empty, so this terminates rather than spinning.
  if (dirty.size) draw();
}
function drop(id) {
  const m = meshes.get(id);
  if (!m) return;
  scene.remove(m);
  m.geometry.dispose();
  m.material.dispose();   // the TEXTURE is WeakMap-cached against its canvas, so it is NOT disposed here
  meshes.delete(id);
}

/**
 * Render the 3D ground for this frame, or hide the canvas when 2D owns it. Called by main.paintScene
 * before the 2D layers, which paint on #map above this.
 */
export function renderTerrain3D() {
  if (!ground3D()) { if (canvas) canvas.classList.add("off"); return; }
  if (!ensureRenderer()) return;
  canvas.classList.remove("off");
  resize();
  syncCamera();
  syncMeshes();
  renderer.render(scene, camera);
}

/** What the renderer actually put on screen this frame — read by tools/webverify/terrain3d-verify.mjs. */
export function terrain3dStats() {
  let triangles = 0;
  for (const m of meshes.values()) triangles += m.geometry.index.count / 3;
  return { ready: !!renderer, failed, loading, flatLit, triangles,
           meshes: meshes.size, indexedProvinces: indexed.size, indexedPlots: heights.size,
           height: { ...HEIGHT } };
}
