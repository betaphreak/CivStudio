import { cam, VIEW, MAP, centerOn, S, stage } from "./core.mjs";
import { band, BAND } from "./bands.mjs";

// Minimap — a small world-raster thumbnail docked bottom-left of the stage, with a rectangle
// marking the slice of the world the main camera currently frames. Click or drag it to recentre
// the main view on that spot. It is REDUNDANT at the world view (1×, where the rectangle would
// enclose the whole map), so it stays hidden there and fades in the instant either axis is zoomed
// in. Self-contained: it loads its own copy of the map raster (MAP.src, already cached by main.mjs)
// and only reads the shared camera/VIEW — it never touches the main canvas.

// size from the raster's aspect (MAP.dw:MAP.dh, the same crop main.mjs draws), capped both ways
const MAXW = 208, MAXH = 150;
let mmW = MAXW, mmH = Math.round(MAXW * MAP.dh / MAP.dw);
if (mmH > MAXH) { mmH = MAXH; mmW = Math.round(MAXH * MAP.dw / MAP.dh); }

let canvas = null, mctx = null, requestDraw = () => {}, ready = false;
const img = new Image();
img.onload = () => { ready = true; drawMinimap(); };

// build the DOM canvas, wire pointer navigation, and start loading the raster. `reqDraw` is the
// main app's redraw request (main.draw), called after a click/drag pans the camera.
export function initMinimap(reqDraw) {
  if (canvas) return;
  requestDraw = reqDraw || (() => {});
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas = document.createElement("canvas");
  canvas.className = "minimap";
  canvas.setAttribute("aria-hidden", "true");
  canvas.width = Math.round(mmW * dpr);
  canvas.height = Math.round(mmH * dpr);
  canvas.style.width = mmW + "px";
  canvas.style.height = mmH + "px";
  mctx = canvas.getContext("2d");
  stage.style.setProperty("--mm-h", mmH + "px");   // so .stage.mm-on .legend can clear it exactly
  stage.appendChild(canvas);
  wireNav();
  img.src = MAP.src;
}

// recentre the main camera so the world fraction (fx,fy) under the pointer sits at the viewport
// centre — the inverse of the base→screen projection in core (pxr/pyr).
function navTo(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const fx = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  const fy = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
  centerOn(VIEW.dx + fx * VIEW.dw, VIEW.dy + fy * VIEW.dh);   // same k — the minimap pans, never zooms
  requestDraw();
}
function wireNav() {
  let down = false;
  canvas.addEventListener("pointerdown", e => {
    e.preventDefault(); e.stopPropagation();          // don't also start a stage pan / province pick
    down = true; try { canvas.setPointerCapture(e.pointerId); } catch {}
    navTo(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointermove", e => {
    if (!down) return; e.preventDefault(); e.stopPropagation(); navTo(e.clientX, e.clientY);
  });
  const up = e => { if (down) { down = false; try { canvas.releasePointerCapture(e.pointerId); } catch {} } };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("click", e => e.stopPropagation());                 // no fall-through to the map
  canvas.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
}

// Repaint the thumbnail + the viewport rectangle. Called from main.paint() every frame (cheap: one
// scaled drawImage + a couple of strokes), so it tracks pan/zoom for free.
export function drawMinimap() {
  if (!canvas || !mctx) return;

  // the visible screen box as fractions of the world raster (0..1), both axes clamped to the map
  // edges — no east-west wrap now the map is a finite sheet (docs/realms.md §Delete the wrap), so
  // horizontal is computed exactly like vertical (no mod, no seam).
  let fx0 = ((-cam.x / cam.k) - VIEW.dx) / VIEW.dw;
  let fx1 = ((VIEW.w - cam.x) / cam.k - VIEW.dx) / VIEW.dw;
  fx0 = Math.max(0, Math.min(1, fx0)); fx1 = Math.max(0, Math.min(1, fx1));
  const fw = fx1 - fx0;
  let fy0 = ((-cam.y / cam.k) - VIEW.dy) / VIEW.dh;
  let fy1 = ((VIEW.h - cam.y) / cam.k - VIEW.dy) / VIEW.dh;
  fy0 = Math.max(0, Math.min(1, fy0)); fy1 = Math.max(0, Math.min(1, fy1));
  const fh = fy1 - fy0;

  // at the world view the rectangle ≈ the whole map → hide; show as soon as either axis zooms in.
  // Also hidden in the Ground regime (band ≥ PLOT): at city-micro zoom the world thumbnail is noise
  // and the deep view is the subject (docs/zoom-bands.md §chrome).
  const visible = ready && (fw < 0.985 || fh < 0.985) && band() < BAND.PLOT;
  canvas.classList.toggle("on", visible);
  stage.classList.toggle("mm-on", visible);
  if (!visible) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, mmW, mmH);
  mctx.imageSmoothingEnabled = true;
  mctx.drawImage(img, 0, 0, mmW, mmH);
  mctx.fillStyle = "rgba(6,9,14,0.22)"; mctx.fillRect(0, 0, mmW, mmH);   // dim the whole thumbnail…

  const ry = fy0 * mmH, rh = Math.max(2, fh * mmH), rw = fw * mmW, rx = fx0 * mmW;
  // one piece — the map is a finite sheet, so the framed rect never straddles a seam (there is none)
  const pieces = [[rx, rw]];
  for (const [x, w] of pieces) {                       // re-light the framed slice (undo the dim)
    mctx.save();
    mctx.beginPath(); mctx.rect(x, ry, w, rh); mctx.clip();
    mctx.drawImage(img, 0, 0, mmW, mmH);
    mctx.restore();
  }
  for (const [x, w] of pieces) {                       // dark halo + bright/amber outline so it pops
    mctx.lineWidth = 3; mctx.strokeStyle = "rgba(10,14,20,0.9)";
    mctx.strokeRect(x + 0.5, ry + 0.5, Math.max(1, w - 1), Math.max(1, rh - 1));
    mctx.lineWidth = 1.4; mctx.strokeStyle = "rgba(240,244,250,0.95)";
    mctx.strokeRect(x + 0.5, ry + 0.5, Math.max(1, w - 1), Math.max(1, rh - 1));
  }
}
