package com.civstudio.server.town.geom;

import java.util.ArrayList;
import java.util.List;

/**
 * A bounded Voronoi diagram — one convex cell per seed, clipped to a bounding polygon.
 * <p>
 * <b>By half-plane intersection, not Fortune's sweep.</b> A cell is the bounding polygon clipped by
 * the perpendicular bisector against every other seed, which is O(n²) rather than O(n log n) — and
 * is the right trade here by a wide margin. A town has tens of plots, not thousands ({@code
 * docs/towngen-port.md} §2b caps the walled core at ~32 and the whole footprint is bounded by the
 * province plot cap), so n² is microseconds; in exchange the implementation is twenty lines that
 * cannot produce a malformed diagram, against a sweep-line's degenerate-input edge cases. Given
 * §5's whole subject is a generator that escaped bad geometry by regenerating — an escape our
 * fixed footprint denies us — "cannot go wrong" is worth more than an asymptote we never reach.
 */
public final class Voronoi {

	private Voronoi() {
	}

	/**
	 * The Voronoi cells of {@code seeds}, clipped to {@code bounds}, in seed order.
	 * <p>
	 * Coincident seeds cannot be separated by a bisector (there isn't one), so the <b>first</b> of
	 * a coincident group keeps the cell and the rest come back {@link Poly#EMPTY} — deterministic,
	 * and never two overlapping cells claiming the same ground, which is the failure that would
	 * quietly break the bijection downstream. In our mesh it cannot arise anyway: seeds are
	 * anchored one per plot centre and clamped to well within their own plot.
	 *
	 * @param seeds  the seed points
	 * @param bounds the convex polygon every cell is clipped to
	 * @return one cell per seed, in the same order; a cell may be {@link Poly#EMPTY}
	 */
	public static List<Poly> cells(List<Pt> seeds, Poly bounds) {
		List<Poly> out = new ArrayList<>(seeds.size());
		for (int i = 0; i < seeds.size(); i++) {
			out.add(cell(seeds, i, bounds));
		}
		return out;
	}

	/**
	 * The Voronoi cell of seed {@code i} alone — the bounding polygon clipped by the bisector
	 * against each other seed. Useful on its own when only one cell is wanted (a single plot's
	 * patch, after a growth step) instead of the whole diagram.
	 *
	 * @param seeds  the seed points
	 * @param i      which seed's cell to build
	 * @param bounds the convex polygon the cell is clipped to
	 * @return the cell, possibly {@link Poly#EMPTY}
	 */
	public static Poly cell(List<Pt> seeds, int i, Poly bounds) {
		Pt si = seeds.get(i);
		Poly cell = bounds.canonical();
		for (int j = 0; j < seeds.size() && !cell.isEmpty(); j++) {
			if (j == i) {
				continue;
			}
			Pt sj = seeds.get(j);
			if (si.dist2(sj) < 1e-18) {
				// coincident: there is no bisector to clip by, so the earlier seed takes the cell
				// rather than both keeping the whole bounds
				if (j < i) {
					return Poly.EMPTY;
				}
				continue;
			}
			// keep the side closer to si: the bisector runs through the midpoint, and si - sj
			// points at the half we want
			cell = cell.clipHalfPlane(si.mid(sj), si.minus(sj));
		}
		return cell;
	}
}
