package com.civstudio.server.town.geom;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The outline of a set of grid cells — "the wall around an arbitrary set of cells", which {@code
 * docs/towngen-port.md} calls the one-line takeaway of the whole port: the curtain wall is not a
 * generated shape but the union outline of the plots the settlement actually built on.
 * <p>
 * Cell {@code (x, y)} covers {@code [x, x+1] × [y, y+1]} in plot space, so a cell's corners land on
 * integers and coincident corners compare <b>exactly</b> — the reason this walks a grid rather than
 * doing general polygon union on floating-point cells. The plan's §5.2 hazard (a hole, or a second
 * disconnected clump, silently mis-walked) is answered structurally here: <b>every</b> boundary loop
 * is returned, not just the first one found, and their signs tell them apart.
 * <p>
 * <b>Orientation carries the meaning.</b> Loops come back with the interior consistently on the same
 * side, so the outer boundary has positive {@link Poly#signedArea()} and each hole negative. A
 * caller can therefore classify without a point-in-polygon test: {@link #outer(List)} is the largest
 * positive loop, and the rest of the positives are separate components — which is exactly the check
 * T2 needs before it decides what to keep.
 * <p>
 * Which loops <em>should</em> exist is not this class's business: keeping the largest component and
 * filling land holes while leaving lakes alone are T2's rules, and they read this.
 */
public final class GridOutline {

	private GridOutline() {
	}

	/**
	 * A grid cell — one plot, keyed by its raster coordinates (the space the plot feed speaks).
	 *
	 * @param x the raster x
	 * @param y the raster y
	 */
	public record Cell(int x, int y) {

		/** This cell's centre, in plot space — the anchor a mesh seed is jittered about. */
		public Pt centre() {
			return new Pt(x + 0.5, y + 0.5);
		}

		/** This cell as a unit square, in canonical order. */
		public Poly square() {
			return Poly.rect(x, y, 1, 1);
		}
	}

	/**
	 * Every boundary loop of the given cells: the outer boundary of each connected clump (positive
	 * signed area) and each enclosed hole (negative).
	 * <p>
	 * Vertices are emitted only where the boundary turns — a straight run of ten cells is two
	 * points, not eleven — because the wall smoothing and the gate spacing downstream both scale
	 * with vertex count, and a staircase of collinear points is what §5.4 warns produces "a wall
	 * that is mostly gate".
	 *
	 * @param cells the cells to outline
	 * @return the loops, in no particular order; empty for no cells
	 */
	public static List<Poly> loops(Collection<Cell> cells) {
		Set<Cell> set = new HashSet<>(cells);
		// each boundary side becomes a directed edge with the interior on its perp side, so the
		// loops that come out are already consistently oriented
		Map<Pt, List<Pt>> outgoing = new HashMap<>();
		for (Cell c : set) {
			if (!set.contains(new Cell(c.x(), c.y() - 1))) {
				edge(outgoing, new Pt(c.x(), c.y()), new Pt(c.x() + 1, c.y()));
			}
			if (!set.contains(new Cell(c.x() + 1, c.y()))) {
				edge(outgoing, new Pt(c.x() + 1, c.y()), new Pt(c.x() + 1, c.y() + 1));
			}
			if (!set.contains(new Cell(c.x(), c.y() + 1))) {
				edge(outgoing, new Pt(c.x() + 1, c.y() + 1), new Pt(c.x(), c.y() + 1));
			}
			if (!set.contains(new Cell(c.x() - 1, c.y()))) {
				edge(outgoing, new Pt(c.x(), c.y() + 1), new Pt(c.x(), c.y()));
			}
		}
		List<Poly> out = new ArrayList<>();
		while (!outgoing.isEmpty()) {
			Poly loop = walk(outgoing);
			if (!loop.isEmpty()) {
				out.add(loop);
			}
		}
		return out;
	}

	/**
	 * The outer boundary among {@link #loops} — the largest loop by area, which for a single
	 * connected clump is its wall line.
	 *
	 * @param loops the loops
	 * @return the largest, or {@link Poly#EMPTY} for none
	 */
	public static Poly outer(List<Poly> loops) {
		Poly best = Poly.EMPTY;
		double ba = -1;
		for (Poly p : loops) {
			if (p.area() > ba) {
				ba = p.area();
				best = p;
			}
		}
		return best;
	}

	/**
	 * The holes among {@link #loops} — the negatively-oriented loops, each an enclosed void. A
	 * hole may be legitimate (a lake the town built around) or an artefact to fill (unbuilt land);
	 * telling those apart needs the map, so it is T2's call and not this class's.
	 *
	 * @param loops the loops
	 * @return the hole loops
	 */
	public static List<Poly> holes(List<Poly> loops) {
		List<Poly> out = new ArrayList<>();
		for (Poly p : loops) {
			if (p.signedArea() < 0) {
				out.add(p);
			}
		}
		return out;
	}

	private static void edge(Map<Pt, List<Pt>> outgoing, Pt from, Pt to) {
		outgoing.computeIfAbsent(from, k -> new ArrayList<>()).add(to);
	}

	/** Consume one loop from the edge map, following it until it closes. */
	private static Poly walk(Map<Pt, List<Pt>> outgoing) {
		Pt start = outgoing.keySet().iterator().next();
		List<Pt> loop = new ArrayList<>();
		Pt at = start;
		Pt inDir = null;
		while (true) {
			List<Pt> outs = outgoing.get(at);
			if (outs == null || outs.isEmpty()) {
				break;                                   // open chain: malformed input, not a crash
			}
			Pt next = pick(at, inDir, outs);
			outs.remove(next);
			if (outs.isEmpty()) {
				outgoing.remove(at);
			}
			Pt dir = next.minus(at);
			// keep only the corners: a vertex whose incoming and outgoing directions agree is a
			// point in the middle of a straight run and carries no information
			if (inDir != null && Math.abs(inDir.cross(dir)) > 1e-12) {
				loop.add(at);
			}
			inDir = dir;
			at = next;
			if (at.equals(start)) {
				Pt first = loop.isEmpty() ? start : loop.get(0);
				Pt closing = first.minus(start);
				if (loop.isEmpty() || Math.abs(inDir.cross(closing)) > 1e-12) {
					loop.add(start);
				}
				break;
			}
		}
		return loop.size() < 3 ? Poly.EMPTY : new Poly(loop);
	}

	/**
	 * Which way to go at a vertex. A pinch — two cells meeting only at a corner — offers two
	 * onward edges, and taking the wrong one merges two loops into a figure of eight. Turning as
	 * far as possible toward the interior (the largest cross product with the incoming direction)
	 * always keeps to the tighter loop, which is the one that belongs to the boundary being walked.
	 */
	private static Pt pick(Pt at, Pt inDir, List<Pt> outs) {
		if (outs.size() == 1 || inDir == null) {
			return outs.get(0);
		}
		Pt best = outs.get(0);
		double bc = -Double.MAX_VALUE;
		for (Pt o : outs) {
			double c = inDir.cross(o.minus(at));
			if (c > bc) {
				bc = c;
				best = o;
			}
		}
		return best;
	}
}
