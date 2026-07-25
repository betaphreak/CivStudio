// SPIKE viewer: is a heightmapped mesh, textured with eos's own baked province canvas and shaped by
// eos's own per-plot plotType/elevation, the look in tools/samples/test2.png?
//
// Deliberately answers ONE question and nothing else. No chunking, no LOD, no props, no streaming, one
// province, static data from extract.mjs. Nothing here is meant to be reused; it exists so the
// renderer decision is made against a picture instead of an argument.
//
// THE THING BEING TESTED. The province texture is baked WITHOUT shading — the elevation-normal
// hillshade was removed from plots.mjs because on the gentle continental heightmap it read as a
// per-plot checker. So all relief here comes from real geometry lit by a real light, which is exactly
// what a 3D renderer buys over a 2D shear. Two independent height sources, separately adjustable:
//
//   plotType   FLAT/HILL/PEAK — discrete, and how Civ4 gets its mountains
//   elevation  the real imported heightmap — but Ardumu spans only 99..145 of 255, so on its own it is
//              nearly flat. The sliders exist to find out which source actually carries the look.
import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";

const $ = id => document.getElementById(id);
const fail = m => { $("err").textContent = String(m); throw new Error(m); };

const [meta, tex] = await Promise.all([
  fetch("./data/plots.json").then(r => r.ok ? r.json() : fail("data/plots.json missing — run `node extract.mjs` first")),
  new THREE.TextureLoader().loadAsync("./data/terrain.png").catch(() => fail("data/terrain.png missing — run `node extract.mjs` first")),
]);
tex.colorSpace = THREE.SRGBColorSpace;
tex.minFilter = THREE.LinearMipmapLinearFilter;
tex.magFilter = THREE.LinearFilter;
tex.anisotropy = 8;

const BOX = meta.box, W = BOX.w, H = BOX.h;
// plot lookup by grid cell, and the elevation floor so heights start at 0 rather than at sea level
const cell = new Map();
let eMin = Infinity;
for (const q of meta.plots) { cell.set((q.x - BOX.x0) + "," + (q.y - BOX.y0), q); if (q.e < eMin) eMin = q.e; }

// ---- renderer / scene ----
const canvas = $("cv");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e15);
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 4000);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight(0xfff3e0, 2.1);
scene.add(sun);
const ambient = new THREE.AmbientLight(0x8fa8c8, 0.55);
scene.add(ambient);

const material = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
let mesh = null;

// ---- height model ----
// A plot's height is the sum of its two independent contributions. Vertices sit on plot CORNERS, so a
// corner's height is the mean of the (up to 4) plots touching it — that interpolates instead of
// stamping a square per plot, which is what made the old 2D hillshade read as a checkerboard.
function plotHeight(q, P) {
  if (!q) return null;
  const fromType = q.pt === "PEAK" ? P.peak : q.pt === "HILL" ? P.hill : 0;
  const fromElev = ((q.e - eMin) / 255) * P.elev;
  return P.flat ? 0 : fromType + fromElev;
}

function build(P) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh = null; }

  // corner heights over a (W+1) x (H+1) lattice; null where no plot touches (outside the province)
  const vh = new Float32Array((W + 1) * (H + 1));
  const has = new Uint8Array((W + 1) * (H + 1));
  for (let gy = 0; gy <= H; gy++) for (let gx = 0; gx <= W; gx++) {
    let sum = 0, n = 0;
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const h = plotHeight(cell.get((gx + dx) + "," + (gy + dy)), P);
      if (h !== null) { sum += h; n++; }
    }
    const i = gy * (W + 1) + gx;
    if (n) { vh[i] = sum / n; has[i] = 1; }
  }
  // smoothing passes over the lattice (only across vertices that exist, so the silhouette is kept)
  for (let s = 0; s < P.smooth; s++) {
    const cp = vh.slice();
    for (let gy = 0; gy <= H; gy++) for (let gx = 0; gx <= W; gx++) {
      const i = gy * (W + 1) + gx;
      if (!has[i]) continue;
      let sum = cp[i], n = 1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x > W || y > H) continue;
        const j = y * (W + 1) + x;
        if (has[j]) { sum += cp[j]; n++; }
      }
      vh[i] = sum / n;
    }
  }

  // one quad per plot that exists — so the mesh has the province's real silhouette, holes and all
  const pos = [], uv = [], idx = [];
  const vidx = new Int32Array((W + 1) * (H + 1)).fill(-1);
  const need = (gx, gy) => {
    const i = gy * (W + 1) + gx;
    if (vidx[i] >= 0) return vidx[i];
    const v = pos.length / 3;
    // centre the mesh on the origin; X east, Z south, Y up
    pos.push(gx - W / 2, vh[i], gy - H / 2);
    uv.push(gx / W, 1 - gy / H);          // the PNG's row 0 is the box's y0 → flip V
    vidx[i] = v;
    return v;
  };
  let quads = 0;
  for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) {
    if (!cell.get(gx + "," + gy)) continue;
    const a = need(gx, gy), b = need(gx + 1, gy), c = need(gx + 1, gy + 1), d = need(gx, gy + 1);
    idx.push(a, d, c, a, c, b);
    quads++;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  mesh = new THREE.Mesh(g, material);
  scene.add(mesh);

  const hs = [];
  for (let i = 0; i < vh.length; i++) if (has[i]) hs.push(vh[i]);
  hs.sort((a, b) => a - b);
  $("stats").textContent =
    `${meta.province.name} · ${meta.province.type} · ${meta.province.plots} plots\n` +
    `box ${W}x${H} · texture ${meta.canvas.join("x")} (tpp ${meta.tpp})\n` +
    `PEAK ${meta.stats.plotType.PEAK || 0} · HILL ${meta.stats.plotType.HILL || 0} · FLAT ${meta.stats.plotType.FLAT || 0}\n` +
    `elevation ${meta.stats.elevation.min}..${meta.stats.elevation.max} of 255 (span ${meta.stats.elevation.max - meta.stats.elevation.min})\n` +
    `mesh ${quads} quads / ${quads * 2} triangles · ${pos.length / 3} verts\n` +
    `height range ${hs[0].toFixed(2)}..${hs[hs.length - 1].toFixed(2)} plot-widths`;
}

// ---- controls ----
const P = { peak: 2.6, hill: 0.85, elev: 8, smooth: 1, flat: false };
// slider id → [P key, readout id, formatter]
const SLIDERS = {
  peak:   ["peak", "vPeak", v => v.toFixed(2)],
  hill:   ["hill", "vHill", v => v.toFixed(2)],
  elev:   ["elev", "vElev", v => v.toFixed(1)],
  smooth: ["smooth", "vSmooth", v => String(v | 0)],
};
const syncUI = () => {
  for (const [id, [key, out, fmt]] of Object.entries(SLIDERS)) { $(id).value = P[key]; $(out).textContent = fmt(P[key]); }
};
/** Set parameters, push them to the sliders, rebuild. The UI sync matters because the screenshots are
 *  the deliverable: a shot whose panel still shows the defaults while the mesh shows something else is
 *  actively misleading to anyone reading it later. */
function setParams(cfg) { Object.assign(P, cfg); syncUI(); build(P); }
for (const [id, [key, out, fmt]] of Object.entries(SLIDERS)) {
  $(id).addEventListener("input", () => { P[key] = +$(id).value; $(out).textContent = fmt(P[key]); build(P); });
}
syncUI();

const L = { az: 315, alt: 38, amb: 0.55 };
function relight() {
  const a = L.az * Math.PI / 180, e = L.alt * Math.PI / 180, R = Math.max(W, H) * 2;
  sun.position.set(Math.cos(a) * Math.cos(e) * R, Math.sin(e) * R, Math.sin(a) * Math.cos(e) * R);
  ambient.intensity = L.amb;
  $("vAz").textContent = L.az + "°"; $("vAlt").textContent = L.alt + "°"; $("vAmb").textContent = L.amb.toFixed(2);
}
for (const [id, key] of [["az", "az"], ["alt", "alt"], ["amb", "amb"]]) {
  const el = $(id); el.value = L[key];
  el.addEventListener("input", () => { L[key] = +el.value; relight(); });
}
relight();

const toggle = (id, fn) => $(id).addEventListener("click", () => {
  const on = $(id).getAttribute("aria-pressed") !== "true";
  $(id).setAttribute("aria-pressed", String(on)); fn(on);
});
toggle("bFlat", on => { P.flat = on; build(P); });
toggle("bWire", on => { material.wireframe = on; });
toggle("bTex", on => { material.map = on ? tex : null; material.color.set(on ? 0xffffff : 0x9aa79a); material.needsUpdate = true; });

const view = (tilt, dist) => {
  const a = -Math.PI / 2, e = tilt * Math.PI / 180;
  camera.position.set(Math.cos(a) * Math.cos(e) * dist, Math.sin(e) * dist, Math.sin(a) * Math.cos(e) * dist);
  controls.target.set(0, 0, 0); controls.update();
};
$("bTop").addEventListener("click", () => view(89, Math.max(W, H) * 1.25));
$("bObl").addEventListener("click", () => view(30, Math.max(W, H) * 1.45));
// the two hypotheses, as one click each
$("bCiv").addEventListener("click", () => {
  setParams({ peak: 3.4, hill: 1.0, elev: 6, smooth: 1, flat: false });
  view(30, Math.max(W, H) * 1.45);
});
$("bHeight").addEventListener("click", () => {
  setParams({ peak: 0, hill: 0, elev: 30, smooth: 1, flat: false });
  view(30, Math.max(W, H) * 1.45);
});

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
build(P);
view(30, Math.max(W, H) * 1.45);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
window.__spike = { P, L, build, setParams, view, camera, renderer, scene, meta };
