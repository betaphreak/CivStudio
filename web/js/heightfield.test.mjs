"use strict";
// Unit tests for the pure terrain height field (heightfield.mjs). Run: npm test --prefix web
//
// The properties asserted here are the ones docs/terrain-3d.md P1 depends on and that a rendered frame
// would hide: corner averaging (not per-plot stamping — the failure that killed the 2D hillshade), and
// ORDER INDEPENDENCE across asynchronously-arriving provinces (the cross-province seam the spike
// punted on). Neither is visible in a screenshot until it is wrong in a way you cannot unsee.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HEIGHT, pkey, plotHeight, indexPlots, cornerAt, smoothCornerAt } from "./heightfield.mjs";

const plot = (x, y, plotType = "FLAT", elevation = 0) => ({ x, y, plotType, elevation });
const idx = (...plots) => { const m = new Map(); indexPlots(m, plots); return m; };

test("plotHeight takes its relief from plotType, elevation only modulating", () => {
  assert.equal(plotHeight(plot(0, 0, "FLAT", 0)), 0);
  assert.equal(plotHeight(plot(0, 0, "HILL", 0)), HEIGHT.HILL);
  assert.equal(plotHeight(plot(0, 0, "PEAK", 0)), HEIGHT.PEAK);
  assert.equal(plotHeight(plot(0, 0, "FLAT", 255)), HEIGHT.ELEV);
  // RELIEF IS A RISE, NOT A MOUNTAIN — the P4b correction (docs/terrain-3d.md §Relief is props, not
  // displacement). A peak must lift its plot enough to read as high ground...
  assert.ok(HEIGHT.PEAK > HEIGHT.HILL && HEIGHT.HILL > 0, "PEAK above HILL above flat");
  // ...and must NOT dominate the continental heightmap, which is the assertion that inverted. When PEAK
  // was 3.4 against ELEV 6, one plot boundary could out-rise half the world's altitude range, and every
  // peak-beside-flat edge was a cliff by construction. The mountain is a prop now (foliage.RELIEF), so
  // the mesh only has to carry gentle ground.
  assert.ok(HEIGHT.PEAK < HEIGHT.ELEV / 4,
    "a PEAK must stay small against the continental range, or the mesh terraces at every peak boundary");
});

test("plotHeight distinguishes an absent plot from flat ground", () => {
  assert.equal(plotHeight(undefined), null, "a hole in the mesh");
  assert.equal(plotHeight(plot(0, 0, "FLAT", 0)), 0, "flat ground");
});

test("an unknown plotType is treated as flat, not as a crash", () => {
  // the plot JSON is server data; a new C2C plotType must degrade, not throw
  assert.equal(plotHeight(plot(0, 0, "LAGOON_OF_MYSTERY", 0)), 0);
  assert.equal(plotHeight({ x: 0, y: 0, elevation: 0 }), 0, "no plotType at all");
});

test("cornerAt averages the four plots touching a corner", () => {
  // corner (1,1) is touched by plots (0,0) (1,0) (0,1) (1,1)
  const m = idx(plot(0, 0, "PEAK"), plot(1, 0, "FLAT"), plot(0, 1, "FLAT"), plot(1, 1, "FLAT"));
  assert.equal(cornerAt(m, 1, 1), HEIGHT.PEAK / 4, "one peak of four plots → a quarter of the step");
  // ...which is the point: a lone PEAK raises a small pyramid over four corners rather than stamping a
  // flat-topped square. Stamping is what made the 2D hillshade read as a checkerboard.
  for (const [lx, ly] of [[0, 0], [1, 0], [0, 1], [1, 1]])
    assert.ok(cornerAt(m, lx, ly) > 0, `corner ${lx},${ly} should be lifted by the peak`);
  assert.equal(cornerAt(m, 3, 3), null, "a corner no plot touches has no height");
});

test("cornerAt uses only the plots that exist at a province edge", () => {
  const m = idx(plot(0, 0, "PEAK"));                    // a single plot: its 4 corners each touch 1 plot
  assert.equal(cornerAt(m, 0, 0), HEIGHT.PEAK, "corner touched by exactly one plot takes its height");
  assert.equal(cornerAt(m, 1, 1), HEIGHT.PEAK);
  assert.equal(cornerAt(m, 2, 2), null, "beyond it, nothing");
});

test("smoothCornerAt averages a corner with its lattice neighbours", () => {
  // a lone PEAK in flat ground: its corners sit at PEAK/4, and their outward neighbours at 0, so
  // smoothing pulls the summit down — a rounded rise rather than a spike on four stilts
  const plots = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) plots.push(plot(x, y, x === 1 && y === 1 ? "PEAK" : "FLAT"));
  const m = idx(...plots);
  assert.ok(smoothCornerAt(m, 1, 1) < cornerAt(m, 1, 1), "the raised corner is pulled down");
  assert.ok(smoothCornerAt(m, 1, 1) > 0, "but not flattened away");
  assert.equal(smoothCornerAt(m, 9, 9), null, "no corner, no smoothed corner");
});

test("smoothing does not erode a silhouette: nulls are skipped, not counted as zero", () => {
  // A single plot's four corners EACH touch only that plot, so all four are at its full height and
  // smoothing leaves them there. That is the intended behaviour, not a gap in the test above: treating
  // absent neighbours as 0 would sag every province edge and coastline downward into the sea.
  // Compared with a tolerance, not exactly: the corner is a mean of means, so whether it lands on the
  // constant bit-for-bit depends on the constant's binary representation (3.4 did, 0.8 does not). The
  // property is "no sag", not "no rounding".
  const m = idx(plot(0, 0, "PEAK"));
  for (const [lx, ly] of [[0, 0], [1, 0], [0, 1], [1, 1]])
    assert.ok(Math.abs(smoothCornerAt(m, lx, ly) - HEIGHT.PEAK) < 1e-12, `corner ${lx},${ly} holds its height`);
});

test("smoothing leaves uniform ground exactly flat", () => {
  // a plateau must not sag: every corner and neighbour is equal, so the mean is that value
  const plots = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) plots.push(plot(x, y, "HILL", 100));
  const m = idx(...plots);
  const h = smoothCornerAt(m, 2, 2);
  assert.equal(h, cornerAt(m, 2, 2));
  assert.equal(h, plotHeight(plot(0, 0, "HILL", 100)), "interior of a uniform field keeps its height");
});

// ---- the cross-province seam: the hazard the spike left open ----
test("a boundary corner is the same whichever province is indexed first", () => {
  // two provinces meeting at x=2: corner (2,0) is touched by plots (1,-1),(2,-1),(1,0),(2,0)
  const west = [plot(1, 0, "PEAK", 120), plot(1, 1, "FLAT", 110)];
  const east = [plot(2, 0, "FLAT", 130), plot(2, 1, "HILL", 140)];
  const a = new Map(); indexPlots(a, west); indexPlots(a, east);
  const b = new Map(); indexPlots(b, east); indexPlots(b, west);
  for (const [lx, ly] of [[2, 0], [2, 1], [2, 2], [1, 1]])
    assert.equal(cornerAt(a, lx, ly), cornerAt(b, lx, ly), `corner ${lx},${ly}`);
});

test("smoothing is order-independent too — it reads raw values, never smoothed ones", () => {
  // The stateful alternative (smooth a lattice in place, per province) fails this: the west province's
  // smoothed edge would feed the east province's smoothing, so the result would depend on arrival
  // order and no rebuild could converge. This is why the pass is defined over cornerAt.
  const west = [], east = [];
  for (let y = 0; y < 4; y++) { west.push(plot(0, y, "PEAK", 100), plot(1, y, "FLAT", 100)); east.push(plot(2, y, "HILL", 200), plot(3, y, "FLAT", 200)); }
  const a = new Map(); indexPlots(a, west); indexPlots(a, east);
  const b = new Map(); indexPlots(b, east); indexPlots(b, west);
  for (let ly = 0; ly <= 4; ly++) for (let lx = 0; lx <= 4; lx++)
    assert.equal(smoothCornerAt(a, lx, ly), smoothCornerAt(b, lx, ly), `smoothed corner ${lx},${ly}`);
});

test("a boundary corner RISES once the neighbour arrives, and lands on the joint answer", () => {
  // the transient the design accepts: before the neighbour loads, the corner averages fewer plots.
  const west = [plot(1, 0, "FLAT", 0), plot(1, 1, "FLAT", 0)];
  const east = [plot(2, 0, "PEAK", 0), plot(2, 1, "PEAK", 0)];
  const m = new Map(); indexPlots(m, west);
  const alone = cornerAt(m, 2, 1);
  indexPlots(m, east);
  const joint = cornerAt(m, 2, 1);
  assert.equal(alone, 0, "west-only: the corner sees flat ground");
  assert.equal(joint, HEIGHT.PEAK / 2, "with both: half a peak — the seam closes");
  assert.ok(joint > alone, "which is why a mesh must rebuild when its neighbour lands");
});

test("water plots index FLAT, so the shore ramps down instead of ending in a cliff", () => {
  // land at x=0..1, a sea province's shelf at x=2..3 carrying a high `elevation` that means DEPTH.
  const land = [plot(0, 0, "FLAT", 120), plot(1, 0, "FLAT", 120)];
  const shelf = [plot(2, 0, "FLAT", 200), plot(3, 0, "FLAT", 200)];
  const m = new Map();
  indexPlots(m, land);
  indexPlots(m, shelf, { flat: true });
  const landH = plotHeight(plot(0, 0, "FLAT", 120));
  assert.equal(cornerAt(m, 0, 0), landH, "inland corner sits at land height");
  assert.equal(cornerAt(m, 2, 0), landH / 2, "the shoreline corner is half way down to sea level");
  assert.equal(cornerAt(m, 3, 0), 0, "out over the water, sea level");
  // and the depth value must not have become altitude — the bug this option exists to prevent
  assert.ok(cornerAt(m, 3, 0) < plotHeight(plot(0, 0, "FLAT", 200)),
    "a deep shelf plot must not tower over the land next to it");
});

test("indexPlots reports new plots only, so a re-fetch does not look like a change", () => {
  const m = new Map();
  assert.equal(indexPlots(m, [plot(0, 0), plot(1, 0)]), 2);
  assert.equal(indexPlots(m, [plot(0, 0), plot(1, 0)]), 0, "same plots again → nothing new");
  assert.equal(indexPlots(m, [plot(0, 0), plot(2, 0)]), 1, "only the unseen one counts");
});

test("pkey separates neighbouring plots and matches plots.mjs's grid encoding", () => {
  assert.equal(pkey(3, 7), 3 * 1e5 + 7);
  const seen = new Set();
  for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) seen.add(pkey(x, y));
  assert.equal(seen.size, 1600, "no collisions over a plausible plot neighbourhood");
});
