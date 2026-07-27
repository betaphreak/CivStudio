"use strict";
// Improvement draw layer — Civ4's own improvement MODELS on the plots the sim has actually developed
// (docs/terrain-3d.md §P5a). A farm, a hunting camp, a mine: the third leg of a plot's yield after
// terrain and feature, and the ground art that makes a worked landscape read as worked.
//
// WHY THIS IS A LAYER AND NOT A TEXTURE STAMP. The sprites have been baked and committed since the
// Civ4 art port (web/build.mjs bakeImprovementOverlays → assets/improvements/imp-*.webp) and drew
// NOTHING, because plots.mjs stamped them into each province's cached offscreen from `q.improvement`
// — a field the baked world plot data does not carry and correctly never will. An improvement is
// LIVE state: the sim raises it (a necessity firm raises IMPROVEMENT_FARM on the plot it works), so
// it can only arrive on the session feed, and baking live state into a texture cached per province
// buys an invalidation problem for nothing. So this reads the feed each frame, exactly as routes.mjs
// does, and the dead stamp in plots.mjs is gone.
//
// Source: DistrictView.improvement (server render projection) → districtAt(x, y). Off Live, or on a
// colony whose plots are all undeveloped, this layer draws nothing at all — there is no world-data
// stand-in, because an improvement someone has not built does not exist.
import { ctx, IMPROVEMENT_OVERLAYS, plotPxAt, projectOn, isPolitical } from "./core.mjs";
import { loadArt } from "./plotcanvas.mjs";
import { bandAlpha, band } from "./bands.mjs";
import { tiltAt } from "./band-math.mjs";
import { improvementCell } from "./improvement-cell.mjs";
import { liveColony } from "./overlays/live.mjs";

// one Image per improvement type, loaded once; ready[] gates drawing (loadArt repaints on arrival)
const img = {}, ready = {};
if (IMPROVEMENT_OVERLAYS) for (const type of Object.keys(IMPROVEMENT_OVERLAYS))
  img[type] = loadArt(IMPROVEMENT_OVERLAYS[type], () => { ready[type] = true; });

// A prop's FOOTPRINT as a fraction of the plot's width. Measured rather than guessed: a barn cell
// comes out of the bake at roughly 1:1.9 (a building seen at 32° is much taller than it is wide), so
// the footprint fraction is also, near enough, HALF the height in plots. At 0.62 a farm stood 1.2
// plots tall and the colony read as a forest of towers overlapping the plots behind it; at 0.38 it
// stands about three quarters of a plot and reads as a building on its ground.
//
// Note this is a fraction of the plot, NOT of the screen: plotPxAt is per-position under the tilted
// camera, so a prop on a far plot is drawn smaller by the same perspective that shrinks its ground.
const FOOTPRINT = 0.38;

// Degrees of camera pitch over which the props come in — the same short ramp, and the same argument,
// as terrain3d.RELIEF_FADE_DEG.
const TILT_FADE_DEG = 10;

/**
 * Blit one improvement sprite for the plot at (sx, sy), whose CENTRE is at (cx, cy) on screen.
 * The sprite is sized off the plot's width and stands with its BASE on that centre — a building
 * grows upward out of its ground, exactly as the P3/P4b billboards pivot about their base rather
 * than sinking half of themselves into the hillside.
 */
export function stampImprovement(o, type, sx, sy, cx, cy, plotPx) {
  const sheet = IMPROVEMENT_OVERLAYS && IMPROVEMENT_OVERLAYS[type];
  if (!sheet || !img[type] || !ready[type]) return;
  const { rect: r, flip } = improvementCell(sheet, sx, sy);
  const sw = r ? r[2] : sheet.w, sh = r ? r[3] : sheet.h;
  const w = plotPx * FOOTPRINT, h = w * (sh / sw);      // keep the model's aspect
  o.save();
  o.translate(cx, cy);
  if (flip) o.scale(-1, 1);
  if (r) o.drawImage(img[type], r[0], r[1], r[2], r[3], -w / 2, -h, w, h);
  else o.drawImage(img[type], -w / 2, -h, w, h);
  o.restore();
}

/** Draw the live colony's improvements, each on the plot it was raised on. */
export function drawImprovements() {
  if (!IMPROVEMENT_OVERLAYS || isPolitical()) return;
  // FADE IN WITH THE TILT, exactly as the relief props do (terrain3d.RELIEF_FADE_DEG), and for the
  // same reason: these are buildings rendered at 32° above the horizon, and a 32° elevation of a barn
  // laid on a straight-down camera is the wrong drawing — the lesson P4b learned by trying to stamp a
  // mountain's front elevation into the flat 2D bake. Below the ramp there is simply no prop, which
  // is the state the map has always been in.
  const a = bandAlpha([3.5, 4.5]) * Math.min(1, Math.max(0, tiltAt(band()) / TILT_FADE_DEG));
  if (a <= 0.01) return;
  const colony = liveColony();
  if (!colony || !Array.isArray(colony.districts)) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.imageSmoothingEnabled = true;
  for (const d of colony.districts) {
    if (!d.improvement || !Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
    // plot size AT THIS PLOT, not the argument-less plotPxAt(). Under the tilted camera the scale is
    // a function of position (core.plotPxAt / project-math.scaleAt), and the no-argument form samples
    // source (0,0) — the far corner of the map. It reads ~0.2 px there while a plot under the cursor
    // is tens of px, so a `plotPx > 0.5` guard silently skipped the whole layer at exactly the zooms
    // it exists for. Cheap under the 2D camera, where the projector is separable and position-free.
    const plotPx = plotPxAt(d.x, d.y);
    if (!(plotPx > 0.5)) continue;
    // the plot's CENTRE, at its own terrain height — projectOn drapes on the mesh (P4), so a farm on
    // a slope stands on the slope rather than on its sea-level shadow
    const [x, y] = projectOn(d.x + 0.5, d.y + 0.5);
    stampImprovement(ctx, d.improvement, d.x, d.y, x, y, plotPx);
  }
  ctx.restore();
}
