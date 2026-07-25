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
import { P, MAP, VIEW, cam, affineUnproject, setProjector, latAtSourceY, isUnderground, provSrcBox,
         SEA_BANDS, TREES } from "./core.mjs";
import { ground3D, props3D, set3DAvailable, band } from "./bands.mjs";
import { tiltAt, heightScaleAt, TILT_MAX } from "./band-math.mjs";
import { draw } from "./repaint.mjs";
import { seaColorAt } from "./sea.mjs";
import { HEIGHT, indexPlots, smoothCornerAt, groundAt } from "./heightfield.mjs";
import { placeFoliage, foliageGroup } from "./foliage.mjs";
import { loadArt } from "./plotcanvas.mjs";
import { groundHomography, applyH, invertH, unapplyH } from "./project-math.mjs";

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

const SEA_Y = 0;                  // sea level. plotHeight puts all land above it (no floor subtraction)
// How far the sea plane reaches BEYOND the imported map, in source pixels. At tilt 0 clampPan guarantees the
// map fills the viewport, so this is dead margin; once the camera pitches over it is looking toward a horizon
// that lies past the map's edge, and without it the world would end in a hard line against the void a few
// hundred pixels up the screen. The gradient texture clamps at its edges, so the overhang carries the polar
// deep-ocean colour and fog swallows it.
const SEA_OVERHANG = 6000;
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
  // A PERSPECTIVE camera even at tilt 0, where it reduces to P1's orthographic view on the ground — see
  // syncCamera, which does all the placing. Fog hides the finite map's far edge as the camera pitches over
  // toward the horizon; its colour is the polar deep-ocean end of the sea gradient, so open water fades into
  // haze rather than into a hard line against the void.
  camera = new THREE.PerspectiveCamera(FOV_FLAT, 1, 1, 1e5);
  camera.up.set(0, 0, -1);
  scene.fog = new THREE.Fog(0x0c121c, 1, 2);   // range is set per frame in syncFog

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
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;           // the overhang keeps the polar colours
  // The plane runs SEA_OVERHANG past the map on every side, with UVs that go correspondingly outside 0..1 so
  // the clamped gradient extends rather than repeating. `fog: true` is what dissolves the far edge.
  const O = SEA_OVERHANG, w = MAP.x1 - MAP.x0, h = MAP.y1 - MAP.y0;
  const geo = quadXZ(MAP.x0 - O, MAP.y0 - O, MAP.x1 + O, MAP.y1 + O, SEA_Y);
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([
    -O / w, -O / h,   1 + O / w, -O / h,   1 + O / w, 1 + O / h,   -O / w, 1 + O / h,
  ], 2));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, fog: true })));
}

// Fog range, per frame: it must scale with the camera's standoff, or a distance that veils the horizon when
// zoomed in would swallow the whole scene when zoomed out. Anchored to the camera height so the near edge sits
// comfortably past the focus and the far edge lands around the map's own scale. Disabled at tilt 0, where
// nothing distant is visible and any fog at all would be a change to a frame P1 proved correct.
function syncFog() {
  const r = camera.position.y || 1;
  scene.fog.near = tiltNow ? r * 2 : 1e9;
  scene.fog.far = tiltNow ? r * 2 + 1200 + r * 22 : 1e9 + 1;
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

// ---- 4) upright props: the foliage, standing up ----
// The piece the spike named as the largest single job. Baked into the province canvas, a tree is a top-down
// stamp lying on the ground, so on a lit slope under an oblique camera a forest reads as symbols painted on
// the hillside. Here each tree becomes a QUAD that stands up as the camera pitches over.
//
// THE BILLBOARD PITCHES WITH THE CAMERA, which is the detail that makes one code path enough. Civ4-style
// foliage is world-VERTICAL and rotates about Y to face the camera — but this camera goes fully overhead at
// band 5, where a world-vertical quad is edge-on and vanishes. Instead the quad's plane stays perpendicular to
// the view axis at every tilt: at tilt 0 it lies flat on the ground and covers exactly the screen rect the 2D
// bake drew, so the seam is invisible; by full tilt it has risen to stand. No second bake, no cross-fade.
//
// It pivots about its BASE, not its centre, so a tree stays planted as it rises rather than sinking half of
// itself into the hillside. `up` below is the camera's own up vector — (0, sin, −cos) — which at tilt 0 is due
// north, i.e. screen-up, exactly where the 2D sprite extended to.
const propMeshes = new Map();     // province id → THREE.Mesh[] (one per atlas group present)
const propAtlas = {};             // group key → {img, tex, ready}
let propTilt = null, propExag = null;   // the tilt/exaggeration the current prop geometry was built at

if (TREES) for (const k of Object.keys(TREES)) {
  const meta = TREES[k];
  const img = loadArt(meta, () => { propAtlas[k].ready = true; dropAllProps(); draw(); });
  propAtlas[k] = { img, meta, ready: false, tex: null };
}

/**
 * A province's props as flat instance records — chosen once, from the SAME placement the 2D bake uses
 * (js/foliage.mjs), so the trees do not move when the ground changes hands at band 5.
 *
 * Cached on the province because the choosing is deterministic and the geometry is not: geometry has to be
 * rebuilt whenever the tilt or the exaggeration changes, and re-running the scatter each time would be waste.
 */
function propsOf(p) {
  if (p._props && p._propsFor === p._plots) return p._props;
  const byGroup = new Map();
  for (const q of p._plots) {
    if (!q.feature) continue;
    const g = foliageGroup(q.feature);
    const a = g && propAtlas[g.key];
    if (!a || !a.ready) continue;
    const pl = placeFoliage(q.feature, q.x, q.y, a.meta.sprites);
    if (!pl) continue;
    let list = byGroup.get(pl.key);
    if (!list) byGroup.set(pl.key, list = []);
    for (const it of pl.items)
      // the sprite's BASE: its 2D rect ran from y−h/2 to y+h/2, so the bottom edge is at y + h/2. Anchoring
      // there makes the tilt-0 quad cover that rect exactly, and gives the pivot for standing up.
      list.push({ sp: it.sp, w: it.w, h: it.h, bx: q.x + it.x, bz: q.y + it.y + it.h / 2 });
  }
  p._props = byGroup;
  p._propsFor = p._plots;
  return byGroup;
}

/** Build one group's quads at the current tilt. Positions are absolute source px; UVs index the atlas. */
function propGeometry(items, key) {
  const { meta } = propAtlas[key];
  const th = tiltNow * Math.PI / 180;
  const uy = Math.sin(th), uz = -Math.cos(th);          // the camera's up vector, in world terms
  const n = items.length;
  const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8);
  const idx = new (n * 4 > 65535 ? Uint32Array : Uint16Array)(n * 6);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    const gh = groundAt(heights, it.bx, it.bz);
    const by = (gh === null ? 0 : gh) * exagNow;
    const hw = it.w / 2, hh = it.h;
    const o = i * 12;
    // base left/right, then top left/right — the top displaced along the camera's up by the sprite's height
    pos[o]      = it.bx - hw; pos[o + 1]  = by;           pos[o + 2]  = it.bz;
    pos[o + 3]  = it.bx + hw; pos[o + 4]  = by;           pos[o + 5]  = it.bz;
    pos[o + 6]  = it.bx + hw; pos[o + 7]  = by + uy * hh; pos[o + 8]  = it.bz + uz * hh;
    pos[o + 9]  = it.bx - hw; pos[o + 10] = by + uy * hh; pos[o + 11] = it.bz + uz * hh;
    // flipY is off on the atlas, so v runs with the image's rows: the sprite's BOTTOM row goes on the base
    const u0 = it.sp[0] / meta.w, u1 = (it.sp[0] + it.sp[2]) / meta.w;
    const v0 = it.sp[1] / meta.h, v1 = (it.sp[1] + it.sp[3]) / meta.h;
    const t = i * 8;
    uv[t] = u0; uv[t + 1] = v1;  uv[t + 2] = u1; uv[t + 3] = v1;
    uv[t + 4] = u1; uv[t + 5] = v0;  uv[t + 6] = u0; uv[t + 7] = v0;
    const b = i * 4, e = i * 6;
    idx[e] = b; idx[e + 1] = b + 1; idx[e + 2] = b + 2;
    idx[e + 3] = b; idx[e + 4] = b + 2; idx[e + 5] = b + 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(Array.from(idx));
  return g;
}

/**
 * The material for a foliage group.
 *
 * BLENDED, with only a token alphaTest, and it matters more than it sounds. A tree is drawn from a ~60px
 * sprite at ~8px across at band 5 — minified 7× — so its antialiased edge becomes a wide partially-transparent
 * fringe, and that fringe is most of the tree. A firm alphaTest (0.35 was the first attempt) turns it into a
 * hard boundary and visibly shrinks every tree in the world: the seam frame diff went from mean 5.1 to 9.2 on
 * that alone, which is the 2D bake's soft-composited foliage disagreeing with a cutout. Keeping the blend, and
 * cutting only the all-but-invisible tail, matches what the canvas does.
 *
 * depthWrite stays ON so trees still occlude against terrain and each other rather than showing through hills
 * — the cost being that overlapping blended quads depend on draw order, which placeFoliage's back-to-front
 * sort already provides within a province, and which is stable across tilts because the camera never yaws.
 *
 * UNLIT, because a camera-facing quad's normal always points at the camera, so lighting it would only wash it
 * flat; the sprites carry their own shading and the 2D path does not light them either.
 */
function propMaterial(key) {
  const a = propAtlas[key];
  if (!a.tex) { a.tex = groundTexture(a.img); a.tex.anisotropy = 4; }
  return new THREE.MeshBasicMaterial({
    map: a.tex, transparent: true, alphaTest: 0.02, depthWrite: true, side: THREE.DoubleSide,
  });
}

function dropProps(id) {
  const list = propMeshes.get(id);
  if (!list) return;
  for (const m of list) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  propMeshes.delete(id);
}
function dropAllProps() { for (const id of [...propMeshes.keys()]) dropProps(id); propTilt = null; }

/** Rebuild the prop meshes for a province at the current tilt/exaggeration. */
function syncProps(p) {
  dropProps(p.id);
  if (!props3D()) return;          // ?props=0 — the trees are baked back into the ground texture instead
  const byGroup = propsOf(p);
  if (!byGroup.size) return;
  const list = [];
  for (const [key, items] of byGroup) {
    if (!items.length || !propAtlas[key] || !propAtlas[key].ready) continue;
    const m = new THREE.Mesh(propGeometry(items, key), propMaterial(key));
    m.renderOrder = 1;                    // after the ground, so the depth buffer is already populated
    scene.add(m);
    list.push(m);
  }
  if (list.length) propMeshes.set(p.id, list);
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
// ONE PerspectiveCamera at every tilt, INCLUDING zero — which is the trick that makes the handover from the
// canvas-2D ground invisible.
//
// A perspective camera looking straight down at a plane perpendicular to its axis projects that plane as a
// pure uniform SCALE: every ground point is the same distance along the axis, so there is no foreshortening
// to distinguish it from an orthographic camera. So at tilt 0 this reproduces P1's ortho exactly on the
// ground, and no ortho→perspective blend is needed (there is no continuous family between the two, which
// would have been the alternative and a bad one). Only geometry ABOVE the ground gains parallax, growing
// with tilt, which is the whole point.
//
// The camera is placed by working BACKWARDS from the 2D camera, so the two agree by construction rather than
// by tuning:
//   focus   the source-space point under the viewport centre, via the AFFINE inverse — not core.unproject,
//           which by then is this camera's own inverse and would be circular.
//   scale   m = screen px per source px, straight off cam.k. The distance r that makes a perspective camera
//           of vertical FOV f show that scale is r = H / (2 m tan(f/2)).
//   pitch   tiltAt(band), rotating the camera back over +Z (south) so the top of the screen looks north
//           toward the horizon, matching the map's north-up convention.
// Horizontal magnification at the focus therefore stays continuous with the 2D map across the seam; the
// vertical compresses by cos(tilt), which is simply what tilting looks like and what Civ4 does too.
//
// up = (0, 0, -1) throughout, as in P1: with a view direction of (0, -cos, -sin) it stays non-parallel for
// every tilt below 90°, and yields screen-up = (0, sin, -cos) — north, tipping toward vertical as the camera
// pitches over. The obvious alternative, up = +Y, is degenerate at tilt 0.
// The LENS LENGTHENS AS THE CAMERA FLATTENS, and this is not a nicety — it is what keeps the seam exact.
//
// A perspective camera projects the ground plane as a pure scale (see above), but geometry ABOVE the ground
// gets parallax of r/(r−h), and r falls out of the scale requirement: at band 5, r ≈ 164 source px against
// terrain 6.4 px tall, i.e. 4% magnification on peaks — tens of pixels near the frame edge. That is invisible
// in isolation and glaring at the seam, where the 2D ground hands over: mountains would pop sideways the
// instant the 3D ground took the frame. It is exactly what the P1 frame diff caught (mean 0.7 → 24.8) when
// this file swapped its orthographic camera for a perspective one.
//
// So the FOV rides the tilt. At tilt 0 it is a 1° long lens — r ≈ 3.7k source px, parallax under 0.2%, which
// IS the orthographic camera P1 verified, to within a fifth of a pixel. By full tilt it has opened to 22° and
// the perspective is real. Both ends are what they need to be and the middle is continuous, which no
// ortho→perspective switch could have given.
const FOV_FLAT = 1;           // vertical FOV at tilt 0 — effectively orthographic
const FOV_TILTED = 22;        // at full tilt — how strongly relief parallax reads
let tiltNow = 0;              // the pitch used for the current frame, degrees (0 = straight down)

function syncCamera() {
  const span = MAP.x1 - MAP.x0;
  const m = cam.k * VIEW.dw / span;                       // screen px per source px (isotropic; see fitView)
  const [fx, fz] = affineUnproject(VIEW.w / 2, VIEW.h / 2);
  tiltNow = tiltAt(band());
  const th = tiltNow * Math.PI / 180;
  const fov = FOV_FLAT + (FOV_TILTED - FOV_FLAT) * (tiltNow / TILT_MAX);
  const r = VIEW.h / (2 * m * Math.tan(fov * Math.PI / 360));

  camera.fov = fov;
  camera.aspect = VIEW.w / VIEW.h;
  camera.near = Math.max(0.01, r * 0.02);
  // far has to reach the map's far corner once the camera looks toward the horizon, or the ground is clipped
  // away mid-frame; the diagonal plus the standoff is generous and costs nothing on an empty scene.
  camera.far = r + Math.hypot(span, MAP.y1 - MAP.y0) + 1000;
  camera.position.set(fx, r * Math.cos(th), fz + r * Math.sin(th));
  camera.up.set(0, 0, -1);
  camera.lookAt(fx, 0, fz);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  syncProjector();
}

// GUARDED, because it is called every frame: setSize reallocates the drawing buffer, so doing it
// unconditionally at 30 fps would be a real cost for no change. Driven off VIEW rather than off a resize
// event, so the canvas cannot drift out of step with the 2D one whatever caused the size to change (the
// rail opening, a panel drag, a devicePixelRatio change on monitor switch).
let sizedW = 0, sizedH = 0, sizedDpr = 0;
// ---- handing the tilt to the 2D layers ----
// Everything still drawn on #map — labels, resource and trade-good icons, city plates, districts, caravans,
// province outlines, the hover ring — is anchored to the GROUND. Install a projector (P0's seam) built from
// this camera and all of it follows the tilt without being touched; project-math explains why the ground
// projection is a 3×3 homography and therefore cheap enough for the ~50k culling calls a frame that
// provOnScreen makes.
//
// Installed ONLY while the tilt is non-zero. At tilt 0 the homography is algebraically the affine map but
// not bit-identical to it, so leaving the affine projector in place there keeps the 2D↔3D seam exact — which
// is what P1's frame diff measures — and means the separable fast path stays live for the whole of bands 0-5.
// tiltAt eases in with zero derivative, so the first frames past the seam are sub-pixel and the swap cannot
// be seen.
let H = null, Hinv = null, installed = false;
const PV = new Float64Array(16);

function syncProjector() {
  if (!tiltNow) {
    if (installed) { installed = false; H = Hinv = null; setProjector(); }
    return;
  }
  // projection × view, as one column-major 4×4
  const p = camera.projectionMatrix.elements, v = camera.matrixWorldInverse.elements;
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += p[k * 4 + r] * v[c * 4 + k];
    PV[c * 4 + r] = s;
  }
  H = groundHomography(PV);
  Hinv = invertH(H);
  if (!Hinv) return;                       // degenerate camera — keep whatever was installed rather than
                                           // handing every layer a NaN and blanking the frame
  if (!installed) { installed = true; setProjector(projector3d); }
}

const projector3d = {
  separable: false,
  project: (sx, sy, h) => {
    if (!h) return applyH(H, sx, sy, VIEW.w, VIEW.h);
    // off the ground plane the homography no longer applies, so pay the full 4×4 — written out rather than
    // via a Vector3 so a per-plot caller does not allocate
    const W = PV[3] * sx + PV[7] * h + PV[11] * sy + PV[15];
    if (W <= 1e-9) return [-1e7, -1e7];
    const X = (PV[0] * sx + PV[4] * h + PV[8] * sy + PV[12]) / W;
    const Y = (PV[1] * sx + PV[5] * h + PV[9] * sy + PV[13]) / W;
    return [(X + 1) * 0.5 * VIEW.w, (1 - Y) * 0.5 * VIEW.h];
  },
  unproject: (mx, my) => unapplyH(Hinv, mx, my, VIEW.w, VIEW.h),
};

/**
 * The plot under the cursor, by RAYCAST against the terrain — what hittest.plotAt delegates to once the
 * ground is tilted.
 *
 * The ground-plane inverse is not good enough here, and the error is not subtle: a point on a PEAK 3.4
 * plot-widths high, seen at 34°, sits 3.4·tan(34°) ≈ 2.3 plots away from where its sea-level position
 * projects. Hovering a mountain would report a plot two cells downhill. Returns [sx, sy] as fractional
 * source pixels, or null when the ray misses the terrain (open sea, or off the map).
 */
export function pickGround(mx, my) {
  if (!renderer || !tiltNow) return null;
  if (!raycaster) raycaster = new THREE.Raycaster();
  ndc.set(mx / VIEW.w * 2 - 1, 1 - my / VIEW.h * 2);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects([...meshes.values()], false)[0];
  return hit ? [hit.point.x, hit.point.z] : null;
}
let raycaster = null;
const ndc = { x: 0, y: 0, set(a, b) { this.x = a; this.y = b; } };

/**
 * The RENDERED ground height at a source-space point — the height model's answer times the current vertical
 * exaggeration, i.e. the world y a thing standing on that plot must sit at.
 *
 * Exported because `project(sx, sy, h)` takes a WORLD height, and the exaggeration lives in a mesh transform,
 * so a caller that reads the model directly would place content at the terrain's un-exaggerated height and
 * watch it sink into the ground as you zoom. P3's billboards are the reason this exists; today it is also what
 * makes the exaggeration a single source of truth rather than a renderer-local trick.
 */
export function groundHeightAt(sx, sy) {
  const h = smoothCornerAt(heights, Math.round(sx), Math.round(sy));
  return h === null ? 0 : h * exagNow;
}
let exagNow = 1;

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
  // Vertical exaggeration first, because the prop geometry below is built at it — see
  // band-math.heightScaleAt for why relief has to be judged against the frame rather than against a plot. The
  // TERRAIN applies it as a per-mesh scale (a transform, no rebuild); the props cannot, because each quad
  // stands from its own base and a scale would stretch the sprites too.
  exagNow = heightScaleAt(band());
  // The props' quads are shaped by the tilt, so they are rebuilt when it moves — and ONLY then. Both tilt and
  // exaggeration are functions of the band, so this is really "the zoom changed by a noticeable amount": free
  // while panning at a fixed zoom, one rebuild per zoom step otherwise. The epsilons are what keep a slow
  // continuous zoom from rebuilding 15k quads on every single frame.
  const propsStale = propTilt === null
    || Math.abs(tiltNow - propTilt) > 0.2 || Math.abs(exagNow - propExag) > 0.004;
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
    if (m) { if (propsStale || !propMeshes.has(p.id)) syncProps(p); continue; }
    const g = buildGeometry(p._plots, box);
    m = new THREE.Mesh(g, materialFor(textureFor(cvs, !textured)));
    m.userData = { cvs };
    meshes.set(p.id, m);
    scene.add(m);
    syncProps(p);                          // fresh terrain → fresh props on it
  }
  for (const m of meshes.values()) if (m.scale.y !== exagNow) m.scale.y = exagNow;
  propTilt = tiltNow; propExag = exagNow;
  // ids queued for provinces already passed this frame: one more paint picks them up, and the pass after
  // that finds the set empty, so this terminates rather than spinning.
  if (dirty.size) draw();
}
function drop(id) {
  dropProps(id);
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
  if (!ground3D()) {
    if (canvas) canvas.classList.add("off");
    // Hand the camera back. Leaving a 3D projector installed after the 2D ground resumes would have every
    // label and icon on the map projected through a camera that is no longer drawing anything.
    if (installed) { installed = false; tiltNow = 0; H = Hinv = null; setProjector(); }
    return;
  }
  if (!ensureRenderer()) return;
  canvas.classList.remove("off");
  resize();
  syncCamera();
  syncFog();
  syncMeshes();
  renderer.render(scene, camera);
}

/**
 * Where each prop quad ACTUALLY is, versus where its plot fraction says it should be — the check that P3 put
 * the same trees in the same places, independent of how either side rasterises them.
 *
 * Needed because the seam frame diff can no longer settle it: P3 deliberately changes foliage from a
 * soft-composited stamp into a blended quad, so a slice of pixels differs by design and a pixel comparison can
 * no longer tell "drawn differently" from "drawn somewhere else". This compares GEOMETRY in source-pixel space.
 * Returns the worst discrepancy found, in source px (= plots), and how many quads were checked.
 */
export function propPlacementError() {
  let worst = 0, checked = 0;
  for (const p of P) {
    if (!p._props) continue;
    const list = propMeshes.get(p.id);
    if (!list) continue;
    for (const [key, items] of p._props) {
      const tex = propAtlas[key] && propAtlas[key].tex;
      const mesh = list.find(m => m.material.map === tex);
      if (!mesh) continue;
      const pos = mesh.geometry.attributes.position.array;
      for (let i = 0; i < items.length; i++) {
        const it = items[i], o = i * 12;
        // corner 0 is base-left, corner 2 is top-right. The x span must always be bx ± w/2; at tilt 0 the quad
        // also lies flat, so its source-y span must be exactly the 2D sprite's rect: bz − h to bz.
        worst = Math.max(worst, Math.abs(pos[o] - (it.bx - it.w / 2)), Math.abs(pos[o + 6] - (it.bx + it.w / 2)));
        if (!tiltNow) worst = Math.max(worst, Math.abs(pos[o + 2] - it.bz), Math.abs(pos[o + 8] - (it.bz - it.h)));
        checked++;
      }
    }
  }
  return { worst: +worst.toFixed(6), checked };
}

/** What the renderer actually put on screen this frame — read by tools/webverify/terrain3d-verify.mjs. */
export function terrain3dStats() {
  let triangles = 0, yMin = Infinity, yMax = -Infinity;
  for (const m of meshes.values()) {
    triangles += m.geometry.index.count / 3;
    // The vertex heights AS BUILT. Worth reporting rather than trusting: everything upstream of this can
    // look right — the index populated, the model returning sane numbers, the projection exact — while the
    // mesh is still flat, and from a screenshot a flat mesh under a correct camera is hard to tell from a
    // shallow one. This is the number that says whether there is any relief in the scene at all.
    const pos = m.geometry.attributes.position.array;
    for (let i = 1; i < pos.length; i += 3) { if (pos[i] < yMin) yMin = pos[i]; if (pos[i] > yMax) yMax = pos[i]; }
  }
  let props = 0, propGroups = 0;
  for (const list of propMeshes.values())
    for (const m of list) { propGroups++; props += m.geometry.index.count / 6; }
  return { ready: !!renderer, failed, loading, flatLit, triangles, tilt: tiltNow, installed, exag: +exagNow.toFixed(3),
           props, propGroups, atlases: Object.keys(propAtlas).filter(k => propAtlas[k].ready),
           meshes: meshes.size, indexedProvinces: indexed.size, indexedPlots: heights.size,
           vertexY: Number.isFinite(yMin) ? [+yMin.toFixed(3), +yMax.toFixed(3)] : null,
           height: { ...HEIGHT } };
}
