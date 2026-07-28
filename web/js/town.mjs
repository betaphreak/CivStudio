"use strict";
// The TOWN layer (docs/towngen-port.md T7, prototype): a settlement's real layout — the wall line
// its plots carry, the wards fitted one per plot, and the water it was built around — drawn over the
// city bands from the server's own answer rather than from anything the client invents.
//
// WHAT THIS IS NOT. It is not a footprint grid and not a chip per plot (js/districts.mjs): those
// said "something is built here", and this says WHAT. js/footprints.mjs' sqrt-grid of blocks is
// GONE — T6's lots are cut to a plot's real households and buildings, which is what that grid was
// standing in for. The district chips keep the bands below this one and fade out as it fades in
// (§8a's handover), and only on the province a town is actually drawn for.
//
// The layout is served in PLOT-RASTER space, so every point goes through the same projectOn the
// plot grid uses — which is what makes it survive realm crops, the homography projector and the 3D
// drape without a coordinate system of its own (§3 Coordinates).
import { P, ctx, projectOn, isPolitical, plotPxAt, provOnScreen } from "./core.mjs";
import { bandAlpha } from "./bands.mjs";
import { liveColony } from "./overlays/live.mjs";
import { townOf, ensureTown } from "./townfetch.mjs";
import { drawBuildIcon } from "./build-catalog.mjs";
import { patchFill, patchStroke, wallStyle, TOWN_ENV, WALL_CASING, CASING_EXTRA, MIN_WALL_PX,
  streetStyle, STREET_CASING, STREET_CASING_EXTRA, MIN_STREET_PX,
  lotStyle, ICON_ENV, ICON_PLOT_FRACTION, MIN_ICON_PX,
  BRIDGE_STROKE, BRIDGE_CASING, BRIDGE_LENGTH, BRIDGE_WIDTH, MIN_BRIDGE_PX }
  from "./town-style.mjs";

// draw a ring of [x, y] plot-space points as a path. The layout is served in the same source
// coordinates the plot grid uses, so projectOn — which carries the homography and the 3D ground
// height — is the only transform needed.
function ringPath(pts) {
  if (!pts || pts.length < 2) return false;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = projectOn(pts[i][0], pts[i][1]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  return true;
}

// the screen centre of a lot, for standing its icon on. The mean of the corners rather than the
// area centroid: a lot is a convex block from the cutter, so the two barely differ, and this one
// costs no cross products per frame.
function lotCentre(pts) {
  let sx = 0, sy = 0;
  for (const [px, py] of pts) {
    const [x, y] = projectOn(px, py);
    sx += x;
    sy += y;
  }
  return [sx / pts.length, sy / pts.length];
}

/**
 * Draw the town layer: for every on-screen province that has a live colony, the layout the server
 * computed for it. Fetching is bounded to the viewport AND the band, so a world view never asks for
 * a single layout.
 */
export function drawTown() {
  if (isPolitical()) return;
  const colony = liveColony();
  if (!colony) return;                       // WorldMap mode: no session, no towns
  // ONE envelope, read the way every other layer reads one — bandAlpha takes an ENVELOPE
  // ([in, full]), not a band position. Passing it a band silently yields nothing, which is exactly
  // how this layer first drew a perfect, invisible town.
  const a = bandAlpha(TOWN_ENV);
  if (a <= 0) return;

  for (const p of P) {
    if (!provOnScreen(p)) continue;          // fetching is bounded to the viewport, and so is drawing
    const town = townOf(p.id);
    if (!town) { ensureTown(p.id); continue; }
    if (!town.patches || !town.patches.length) continue;

    // ONE PLOT IN SCREEN PX, SAMPLED AT THIS TOWN — not the argument-less plotPxAt(), which probes
    // source (0, 0). Under the tilted camera the scale is a function of position, and the origin of
    // a realm crop can be thousands of plots away: the no-argument probe came back at 0.24 px for a
    // plot that was actually 330 px across, so every width here collapsed onto its MIN_*_PX floor
    // and the wall drew hairline at every zoom. improvements.mjs carries the same warning.
    const px = plotPxAt(town.patches[0].x, town.patches[0].y);
    if (!(px > 0)) continue;

    // 1. the wards, as ground — tinted by what each patch IS (T6). The tint is the plot's own
    // DistrictType, so this is the same axis the district chips and the city screen speak.
    ctx.save();
    ctx.lineWidth = Math.max(0.4, px * 0.02);
    ctx.strokeStyle = patchStroke(a);
    for (const patch of town.patches) {
      if (!ringPath(patch.poly)) continue;
      ctx.fillStyle = patchFill(patch.walled, a, patch.ward);
      ctx.fill();
      ctx.stroke();
    }

    // 1b. the lots — what actually stands on the ground (T6 §4a). Buildings draw as coloured
    // masses sized by the block they took, which is the reference art's own treatment (§2c) and
    // the reason the biggest building gets the biggest block server-side.
    ctx.lineWidth = Math.max(0.3, px * 0.012);
    const icons = [];                          // deferred: icons stand ON the masses, above them all
    for (const patch of town.patches) {
      for (const lot of patch.lots || []) {
        if (!ringPath(lot.poly)) continue;
        const style = lotStyle(lot.kind, a);
        ctx.fillStyle = style.fill;
        ctx.fill();
        ctx.strokeStyle = style.edge;
        ctx.stroke();
        if (lot.building) icons.push(lot);
      }
    }

    // 1c. a building's icon, standing on its mass — placed the way bonus icons are placed, which
    // is the one piece of machinery for this the client already had. Held back to its own band:
    // below it there is no room, and a town of overlapping buttons says less than the masses do.
    const iconAlpha = bandAlpha(ICON_ENV);
    const iconPx = px * ICON_PLOT_FRACTION;
    if (iconAlpha > 0 && iconPx >= MIN_ICON_PX) {
      ctx.globalAlpha = iconAlpha;
      for (const lot of icons) {
        const [cx, cy] = lotCentre(lot.poly);
        drawBuildIcon(ctx, lot.building, cx, cy, iconPx);
      }
      ctx.globalAlpha = 1;
    }

    // 2. the water the town was built around — drawn as absence, so a bay reads as a bay
    if (town.holes && town.holes.length) {
      ctx.fillStyle = `rgba(40, 78, 104, ${0.30 * a})`;
      for (const hole of town.holes) {
        if (ringPath(hole)) ctx.fill();
      }
    }

    // 3. the streets, before the wall — the network runs up to the gates and the gate marks should
    // sit on top of where its road arrives, not under it
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = a;
    if (town.streets && town.streets.length) {
      // same two passes, same reason: casings first, then colours. Streets meet at junctions, and a
      // later casing would cut a dark notch through the artery its branch just joined.
      const stroke = (st, style, width) => {
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (let i = 0; i < st.line.length; i++) {
          const [x, y] = projectOn(st.line[i][0], st.line[i][1]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      for (const st of town.streets)
        stroke(st, STREET_CASING,
               Math.max(MIN_STREET_PX + 1, px * (streetStyle(st.kind).width + STREET_CASING_EXTRA)));
      for (const st of town.streets)
        stroke(st, streetStyle(st.kind).stroke,
               Math.max(MIN_STREET_PX, px * streetStyle(st.kind).width));
    }

    // 4. the fortification, one piece per plot edge, coloured by what lies beyond it.
    // TWO PASSES, and the order is the point: every casing first, then every colour on top. Per
    // segment it would work too, but neighbouring segments overlap at the corners and a later
    // casing would cut a dark notch through the colour its neighbour already laid.
    const line = (seg, style, width) => {
      const [fx, fy] = projectOn(seg.line[0][0], seg.line[0][1]);
      const [tx, ty] = projectOn(seg.line[1][0], seg.line[1][1]);
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    };
    for (const seg of town.wall || [])
      line(seg, WALL_CASING,
           Math.max(MIN_WALL_PX + 1.5, px * (wallStyle(seg.kind).width + CASING_EXTRA)));
    for (const seg of town.wall || [])
      line(seg, wallStyle(seg.kind).stroke,
           Math.max(MIN_WALL_PX, px * wallStyle(seg.kind).width));

    // 4b. the bridges — where a street gets across the water (T4b). A mark on the road, not a span:
    // the channel is the river ribbon's to draw, and a second one here could only disagree with it.
    // The stroke runs across the street, so it reads as a crossing rather than as a widening.
    if (town.bridges && town.bridges.length) {
      const w = Math.max(MIN_BRIDGE_PX, px * BRIDGE_WIDTH);
      const half = Math.max(MIN_BRIDGE_PX * 2, px * BRIDGE_LENGTH) / 2;
      for (const [bx, by] of town.bridges) {
        // the crossing is a plot-edge midpoint, so the channel runs along one axis and the road the
        // other: probe a plot-space step to find which way is "across" once projected
        const [cx, cy] = projectOn(bx, by);
        const [ax, ay] = projectOn(bx + 0.25, by);
        let dx = ax - cx, dy = ay - cy;
        const len = Math.hypot(dx, dy) || 1;
        dx = dx / len * half;
        dy = dy / len * half;
        for (const [style, width] of [[BRIDGE_CASING, w + 2], [BRIDGE_STROKE, w]]) {
          ctx.strokeStyle = style;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(cx - dx, cy - dy);
          ctx.lineTo(cx + dx, cy + dy);
          ctx.stroke();
        }
      }
    }

    // 5. the gates, as a mark on the line — the roads that actually leave town (§6)
    for (const gate of town.gates || []) {
      const [ax, ay] = projectOn(gate.at[0], gate.at[1]);
      const r = Math.max(MIN_WALL_PX + 1, px * 0.13);
      ctx.fillStyle = WALL_CASING;
      ctx.beginPath();
      ctx.arc(ax, ay, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = wallStyle("ROAD_GATE").stroke;
      ctx.beginPath();
      ctx.arc(ax, ay, r * 0.62, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
