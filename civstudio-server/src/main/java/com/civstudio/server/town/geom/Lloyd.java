package com.civstudio.server.town.geom;

import java.util.ArrayList;
import java.util.List;
import java.util.random.RandomGenerator;

/**
 * Seed jitter and clamped Lloyd relaxation — the mesh step of {@code docs/towngen-port.md} §4.1.
 * <p>
 * <b>Why jitter at all.</b> Plot centres sit on a regular lattice, and the Voronoi diagram of a
 * lattice <em>is</em> the lattice: every cell is the plot square, every cell's centroid is its own
 * seed, and relaxation moves nothing. Read literally, "seed the plot centres and relax" is a no-op
 * that lands on square wards and a staircase wall. So the irregularity is injected as jitter, and
 * relaxation's only job is to take the worst slivers back out — hence {@link
 * TownScale#LLOYD_PASSES} = 1, because Lloyd converges toward a honeycomb and therefore
 * <em>spends</em> the irregularity it is given.
 * <p>
 * <b>Why the clamp.</b> Every seed stays within {@code r < 0.5} plot widths of its anchor (its own
 * plot's centre). With plot spacing 1, for any other plot {@code |anchor_i − seed_j| ≥ 1 − r}, so
 * {@code r < 0.5} makes each plot centre strictly closer to its own seed than to any other.
 * Therefore every plot centre lies in its own cell and every cell is non-empty: the {@code
 * Plot ↔ Patch} bijection the whole design rests on holds <b>by construction, for any footprint
 * shape</b> — including a concave or holed one, where an unclamped Lloyd pass can walk a seed into
 * a neighbour's territory (an L-shaped clipped cell can have its centroid outside itself). The
 * clamp also bounds growth churn: no patch boundary can shift by more than about {@code 2r}
 * however the town grows, which is the honest form of the plan's §2a stability claim.
 */
public final class Lloyd {

	private Lloyd() {
	}

	/**
	 * Anchors jittered into seeds — a uniform draw within the disc of radius {@code r} about each
	 * anchor.
	 * <p>
	 * Uniform <em>in area</em> ({@code r·√u}, not {@code r·u}), so seeds do not pile up at their
	 * anchors and the mesh reads evenly irregular. Two draws per anchor, in list order: this is
	 * the mesh's only randomness and therefore its whole reproducibility surface, so the caller
	 * must pass anchors in a stable order (plot claim order) and never in a hash iteration order
	 * ({@code docs/towngen-port.md} §10).
	 *
	 * @param anchors the fixed points to jitter about — plot centres
	 * @param r       the jitter radius, in plots; clamped to below {@link TownScale#JITTER_MAX}
	 * @param rnd     the generator, threaded explicitly (there is no global RNG here)
	 * @return one jittered seed per anchor, in the same order
	 */
	public static List<Pt> jitter(List<Pt> anchors, double r, RandomGenerator rnd) {
		double rr = Math.min(r, TownScale.JITTER_MAX * 0.999);
		List<Pt> out = new ArrayList<>(anchors.size());
		for (Pt a : anchors) {
			double u = rnd.nextDouble();
			double t = rnd.nextDouble() * 2 * Math.PI;
			double d = rr * Math.sqrt(u);
			out.add(new Pt(a.x() + Math.cos(t) * d, a.y() + Math.sin(t) * d));
		}
		return out;
	}

	/**
	 * {@code passes} rounds of Lloyd relaxation: each seed moves to its clipped cell's area
	 * centroid, then is clamped back into its anchor's {@code r}-disc.
	 * <p>
	 * A seed whose cell clips away to nothing keeps its previous position rather than jumping to
	 * the origin — degeneracy degrades, it does not throw (§5's rule for the whole package).
	 *
	 * @param seeds   the current seeds
	 * @param anchors the anchor per seed — the plot centre it may not stray far from
	 * @param bounds  the convex polygon cells are clipped to
	 * @param r       the clamp radius, in plots
	 * @param passes  how many rounds to run
	 * @return the relaxed seeds, in the same order
	 */
	public static List<Pt> relax(List<Pt> seeds, List<Pt> anchors, Poly bounds, double r,
			int passes) {
		List<Pt> cur = new ArrayList<>(seeds);
		for (int pass = 0; pass < passes; pass++) {
			List<Poly> cells = Voronoi.cells(cur, bounds);
			List<Pt> next = new ArrayList<>(cur.size());
			for (int i = 0; i < cur.size(); i++) {
				Poly c = cells.get(i);
				Pt moved = c.isEmpty() ? cur.get(i) : c.centroid();
				next.add(clamp(moved, anchors.get(i), r));
			}
			cur = next;
		}
		return cur;
	}

	/**
	 * {@code p} pulled back onto the disc of radius {@code r} about {@code anchor}, if it strayed
	 * outside. {@code r} is itself held below {@link TownScale#JITTER_MAX}, so this is the one
	 * place the bijection guarantee is enforced and the one place to look if it is ever in doubt.
	 *
	 * @param p      the candidate position
	 * @param anchor the plot centre it belongs to
	 * @param r      the clamp radius, in plots
	 * @return {@code p}, or the nearest point to it within the disc
	 */
	public static Pt clamp(Pt p, Pt anchor, double r) {
		double rr = Math.min(r, TownScale.JITTER_MAX * 0.999);
		Pt d = p.minus(anchor);
		double l = d.len();
		return l <= rr ? p : anchor.plus(d.scale(rr / l));
	}
}
