/**
 * The town generator's <b>geometry core</b> — {@code docs/towngen-port.md} phase T1.
 * <p>
 * Pure computational geometry with <b>no engine and no Spring dependency</b>: points, polygon
 * algebra, a bounded Voronoi with clamped Lloyd relaxation, a weighted graph with A*, and the block
 * cutters the ward subdivision is built from. Everything here is a pure function of its arguments
 * and an explicitly passed {@link java.util.random.RandomGenerator} — there is no global RNG, by
 * design ({@code towngen-port.md} §10: a new feature never draws from the economic stream, and the
 * reference generator's process-global LCG is exactly what makes it untestable).
 * <p>
 * <b>Units.</b> One plot is <b>1.0</b>, everywhere in this package ({@link
 * com.civstudio.server.town.geom.TownScale}). Nothing here knows about pixels, provinces or the
 * camera; the layout is computed in plot-raster space and projected by the client.
 * <p>
 * <b>Provenance.</b> Written from {@code docs/towngen-port.md} §1–§8 rather than translated from
 * Watabou's Haxe generator: the pipeline inverts (the town's shape is given by sim state, not
 * generated — §4), the retry loop is restructured (§5.1), subdivision is fitted to real household
 * and building counts rather than random (§4a), and the constants are re-tuned at our unit scale
 * (§3). Licence position and its reasoning are recorded in {@code towngen-port.md} T0.
 */
package com.civstudio.server.town.geom;
