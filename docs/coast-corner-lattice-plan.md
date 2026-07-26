# The coast corner rule, and what the lattice was for

**Status: 2026-07-26. The coast gap is CLOSED, and it needed no lattice. The land-blend half of the
idea survives, unbuilt.**

Cross-refs: [`civ4-texture-inventory.md`](civ4-texture-inventory.md) §4 P3 + §6 (what the art is),
[`coastlines.md`](coastlines.md) (the phase history), [`terrain-3d.md`](terrain-3d.md),
[`river-rendering.md`](river-rendering.md) §5 (why rivers are **not** part of this).

---

## 1. What was wrong, measured properly

The previous draft of this document measured one symptom: a water plot touching land **only
orthogonally** got no shoreline art at all, because all four of its diagonal neighbours are water →
`TextureBlend` config 15 → the flat interior cell. **9 of 417 sampled shoreline plots, 2.2%.**

That number was real and far too small. Measured over the whole v13 plot cache — 370 provinces,
607,629 plots, 3,000 shoreline plots with a complete 8-neighbourhood — the fault was:

| | old rule (`coast >> 4`) | corner rule |
|---|---:|---:|
| agrees with corner occupancy | **48.87%** | **100.00%** |
| takes cell 29 → no shoreline drawn | 69 (2.30%) | 0 |

The silent 2.3% was the part that *looked* broken. The other ~49% drew a real painted cell with its
shore in the wrong corner, which reads as shoreline and is therefore invisible as a bug. The largest
single class (126 plots) is `14 → 4`: a cove with land on three sides drew as mostly **water** with a
land wedge, where the art has a mostly-**land** cell with a water wedge in the SE.

## 2. The fix: a corner is not its diagonal

Civ4 blends terrain on a mesh whose vertices are plot corners, so a corner belongs to land the moment
**any** of the four plots touching it is land. `coastConfig` asked only whether the *diagonal* plot was
water. The two agree on a straight coast and on a diagonal-only contact, and part company exactly
where an orthogonal neighbour is land.

Everything needed is already in the 8-bit `coast` byte, which carries edges in the low nibble and
diagonals in the high one:

```js
NW corner is water  ⟺  bit 16 (NW) ∧ bit 8 (N) ∧ bit 2 (W)
```

Verified before it was written: over the same 3,000 plots, the corner rule computed **from the byte**
matches corner occupancy computed independently **from the plots** 3000/3000. The byte is sufficient.
Bit semantics were checked rather than assumed — "set = that neighbour is water" holds on 568,122
plots across all eight slots with zero disagreements.

**So the lattice was never needed for the coast.** §2 of the previous draft argued that the mismatch
was representational and that the ground had to move to a corner lattice for the art to index
correctly. The index was already computable; what was wrong was three lines of arithmetic.

Shipped in `js/water-terrain.mjs coastConfig`, with the measurement in its docstring and the cases in
`water-terrain.test.mjs`.

### The one thing the fix introduces

Config 0 — every corner touching land, i.e. a one-plot lake or a one-plot-wide channel — rises from 5
to 78 plots (2.6%). Config 0 has no table entry, so those draw no coast tile and show plain water
beneath. That is a smaller error than the wrong-corner shoreline they used to get, and it is recorded
rather than hidden, but it is open.

## 3. What the lattice was actually for, and what replaced part of it

The other half of the proposal — replace `BLEND_NOISE`, the procedural land-edge feather, with the
authored 16-way table for **land** terrains — is untouched and still worth doing. Two things about it
are now known that were not:

- **The authored table is per-terrain and complete.** Each of the 16 land terrains carries cells 1–14
  for the blend configurations and **17 interior variants** (cells 15,16,18–32) for flat ground; all
  eight water terrains carry the single cell 29. This is in `terrain-art.json` today.
- **The atlases are 256×512, 4×8 sheets of 64px cells** — small, and already fetched by the bake.

The bake now reads those sheets for the first time: a ground tile is the terrain's own interior cell
modulated by its detail grain at Civ4's modulate2x, replacing a tile that was the detail texture
rescaled to a computed display colour and a ×2.35 lift (`web/build.mjs`, `authoredGroundTile`). That
removes both invented numbers from the ground and, incidentally, puts the machinery for reading blend
cells 1–14 in place. The land blend itself is still `BLEND_NOISE`.

Whether that work still wants a corner lattice is now an open question rather than a settled one. The
coast case proved the index can come from per-plot adjacency data; the land case may too.

**That half is now written up on its own**, with the land table, the per-quadrant alpha measurements
and the resolution survey: [`land-blend-plan.md`](land-blend-plan.md). Start there.

## 4. Traps — all of these still cost time

- **Two nibbles, and they mean different things.** Low = orthogonal EDGES (`1=E 2=W 4=S 8=N`), high =
  diagonal CORNERS (`16=NW 32=NE 64=SE 128=SW`). The table wants the corners — but as *inputs*, not as
  the index: the index needs both nibbles. Feeding the edge nibble straight in shipped once and was
  reverted (`ae4f592`); feeding the corner nibble straight in was what this document fixed.
- **Measure coverage per quadrant, never direction.** A cell's water direction is diagonal; reducing
  it to a compass point with `abs(dx) > abs(dy)` produces a confident wrong answer.
- **`landDist` is Chebyshev**, so a plot touching land only diagonally still has `landDist === 1`.
- **Measure against ground truth, not against the byte you are testing.** The v13 plot cache under
  `.map/v13` is 370 provinces of real plots and needs no server: index every plot by source pixel,
  keep only those with all 8 neighbours present, and the byte becomes falsifiable.
- **Nothing invented.** See `use-authored-art-not-substitutes`.
- **`web/` auto-deploys on push; the server is manual.** Deploy the server first.

## 5. Explicitly not in scope

- **Rivers.** Pixel/centre-line by data; `river-rendering.md` §5 rejected Civ4's edge decals. Decision
  reaffirmed 2026-07-26.
- **The sixteen `coastscalemask` files.** Same shape as the cell alpha at 1/8 resolution.
- **`beach` / `foam`.** Baked, shipped, unread, superseded by the painted tiles.

## 6. Loose ends

- The polar sea roughly doubled in brightness when `SEA_ANCHOR` was removed (`13801f07`) and still has
  not been eyeballed on the map.
- Prod studio holds 25 `terrain-art` rows against the fixture's 33; a Seed Studio run syncs them.
  Nothing reads the dataset at runtime.
