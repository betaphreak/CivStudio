package com.civstudio.server.town.geom;

import java.util.ArrayList;
import java.util.List;
import java.util.random.RandomGenerator;

/**
 * Block cutters — the ways a ward's block is divided into smaller blocks, and eventually into
 * building lots ({@code docs/towngen-port.md} §8: "no CivStudio equivalent; needed for parks,
 * plazas, ring cathedrals").
 * <p>
 * Each cutter takes a block and returns its pieces, leaving a gap where the street between them
 * runs. Every cut removes area — the streets are the difference between the block and the sum of
 * its pieces, which is why nothing here tries to conserve it.
 * <p>
 * <b>Subdivision here is shape, not population.</b> {@link #subdivide} takes a target <em>count</em>
 * because §4a fits it to real state — the households living on the plot and the buildings standing
 * on it — instead of inventing one from a random size threshold as the reference generator must.
 * The cutters decide how regular the blocks look; how many there are is the caller's business.
 */
public final class Cutter {

	private Cutter() {
	}

	/**
	 * Cut a block in two, across its long axis: the cutting line runs perpendicular to the longest
	 * edge, through the centroid displaced along that edge by up to {@code jitter} of the block's
	 * extent.
	 * <p>
	 * Perpendicular to the <em>longest</em> edge is what keeps recursive subdivision from producing
	 * slivers: a long block is always cut across, so pieces tend back toward square.
	 *
	 * @param block  the block to cut
	 * @param gap    the street width left between the pieces
	 * @param jitter how far the cut may stray from the middle, as a fraction of the block's extent
	 *               along the cut axis ({@code 0} cuts exactly through the centroid)
	 * @param rnd    the generator; one draw, and only when {@code jitter > 0}
	 * @return the pieces — two normally, one if the block is too small to split
	 */
	public static List<Poly> bisect(Poly block, double gap, double jitter, RandomGenerator rnd) {
		int e = block.longestEdge();
		if (block.isEmpty() || e < 0) {
			return List.of(block);
		}
		Pt along = block.edgeVec(e).unit();
		Pt through = block.centroid();
		if (jitter > 0) {
			double extent = extentAlong(block, along);
			through = through.plus(along.scale((rnd.nextDouble() - 0.5) * jitter * extent));
		}
		// the cut runs ACROSS the long axis, so its direction is the long edge's perpendicular
		return block.cut(through, along.perp(), gap);
	}

	/**
	 * Cut a block into wedges around a focus — the plaza-and-radiating-lanes pattern, and the base
	 * of a ring cathedral's close.
	 *
	 * @param block      the block to cut
	 * @param focus      the point the cuts radiate from; it need not be inside the block
	 * @param spokes     how many wedges to produce (fewer than 2 returns the block unchanged)
	 * @param gap        the lane width along each cut
	 * @param startAngle the bearing of the first cut, in radians
	 * @return the non-empty wedges, in angular order
	 */
	public static List<Poly> radial(Poly block, Pt focus, int spokes, double gap,
			double startAngle) {
		if (spokes < 2 || block.isEmpty()) {
			return List.of(block);
		}
		List<Poly> out = new ArrayList<>(spokes);
		double step = 2 * Math.PI / spokes;
		for (int i = 0; i < spokes; i++) {
			double a0 = startAngle + i * step, a1 = a0 + step;
			Pt d0 = new Pt(Math.cos(a0), Math.sin(a0));
			Pt d1 = new Pt(Math.cos(a1), Math.sin(a1));
			// the wedge is what lies left of the first ray and right of the next, each ray pushed
			// out by half the lane so the lanes themselves are not built on
			Poly w = block.clipHalfPlane(focus.plus(d0.perp().scale(gap / 2)), d0.perp());
			w = w.clipHalfPlane(focus.plus(d1.perp().scale(-gap / 2)), d1.perp().scale(-1));
			if (!w.isEmpty()) {
				out.add(w);
			}
		}
		return out.isEmpty() ? List.of(block) : out;
	}

	/**
	 * Peel a band off the edge of a block: the inner core, then one quad per edge of the band
	 * between the original outline and the core.
	 * <p>
	 * This is how a ward gets a built frontage around an open middle — a close around a cathedral,
	 * houses around a green — without needing polygons with holes anywhere in the pipeline.
	 *
	 * @param block the block
	 * @param width the band's width
	 * @return the core first (possibly {@link Poly#EMPTY} if the band ate the block), then the band
	 *         pieces in edge order
	 */
	public static List<Poly> ring(Poly block, double width) {
		if (block.isEmpty()) {
			return List.of(block);
		}
		Poly outer = block.canonical();
		Poly core = outer.inset(width);
		List<Poly> out = new ArrayList<>(outer.size() + 1);
		boolean noCore = !validInset(outer, core, width);
		out.add(noCore ? Poly.EMPTY : core);
		if (!noCore && core.size() == outer.size()) {
			for (int i = 0; i < outer.size(); i++) {
				Poly q = Poly.of(outer.get(i), outer.get(i + 1), core.get(i + 1), core.get(i));
				if (!q.isEmpty()) {
					out.add(q);
				}
			}
		}
		return out;
	}

	/**
	 * Recursively bisect a block until there are at least {@code target} pieces — the fitted
	 * subdivision of §4a, where the target comes from the plot's real household and building
	 * counts.
	 * <p>
	 * Always splits the <b>largest</b> remaining piece, so the pieces stay comparable in size
	 * rather than one corner being shredded while the rest stays whole. Stops early — returning
	 * fewer than {@code target} pieces — when every remaining piece is below {@link
	 * TownScale#MIN_BLOCK_AREA}: a block that cannot hold the lots asked of it is a fact about the
	 * block, and inventing sliver lots to hit a number would be worse than reporting it.
	 *
	 * @param block  the block to subdivide
	 * @param target how many pieces are wanted
	 * @param gap    the street width left at each cut
	 * @param rnd    the generator
	 * @return the pieces, largest-first order not guaranteed
	 */
	public static List<Poly> subdivide(Poly block, int target, double gap, RandomGenerator rnd) {
		List<Poly> pieces = new ArrayList<>();
		if (block.isEmpty()) {
			return pieces;
		}
		pieces.add(block);
		while (pieces.size() < target) {
			int bi = -1;
			double ba = TownScale.MIN_BLOCK_AREA;
			for (int i = 0; i < pieces.size(); i++) {
				double a = pieces.get(i).area();
				if (a > ba) {
					ba = a;
					bi = i;
				}
			}
			if (bi < 0) {
				break;                                  // nothing left worth cutting
			}
			List<Poly> half = bisect(pieces.get(bi), gap, 0.3, rnd);
			if (half.size() < 2) {
				break;                                  // the cut failed; stop rather than spin
			}
			pieces.remove(bi);
			pieces.addAll(half);
		}
		return pieces;
	}

	/**
	 * Whether an inset actually produced a core, rather than a plausible-looking wreck.
	 * <p>
	 * Inset a unit square by 0.6 and the opposite edges cross, yet the four corners still wind the
	 * same way: the result is a tidy 0.2 square with positive area that happens to be nonsense. So
	 * neither {@code area()} nor the orientation can be trusted here. What does hold is the
	 * definition of an inset: every new vertex must be at least {@code width} from the boundary it
	 * was pushed away from, and inside it.
	 */
	private static boolean validInset(Poly outer, Poly core, double width) {
		if (core.isEmpty() || core.area() <= TownScale.MIN_BLOCK_AREA) {
			return false;
		}
		for (Pt p : core.points()) {
			if (!outer.contains(p) || outer.distanceToBoundary(p) < width - 1e-9) {
				return false;
			}
		}
		return true;
	}

	/** The block's extent along a unit direction — how long it is on that axis. */
	private static double extentAlong(Poly block, Pt dir) {
		double lo = Double.MAX_VALUE, hi = -Double.MAX_VALUE;
		for (Pt p : block.points()) {
			double d = p.dot(dir);
			lo = Math.min(lo, d);
			hi = Math.max(hi, d);
		}
		return hi - lo;
	}
}
