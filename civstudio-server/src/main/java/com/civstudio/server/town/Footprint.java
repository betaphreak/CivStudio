package com.civstudio.server.town;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

import com.civstudio.server.town.geom.GridOutline;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Poly;

/**
 * The <b>footprint</b> — which plots the town stands on, and the outline around them ({@code
 * docs/towngen-port.md} T2, shipping §5.2).
 * <p>
 * This is the pure half: a set of cells and a land test go in, a cleaned-up set with its boundary
 * loops comes out. Where the cells come from — the 1444 starting core union the built plots — is
 * {@link ColonyFootprint}'s business, so everything here is testable without an engine, a session
 * or a map.
 * <p>
 * <b>Three cleanups, in this order, and the order matters.</b>
 * <ol>
 * <li><b>Largest connected component.</b> 4-neighbour connectivity; outlying clumps are dropped
 *     rather than walled, which reads correctly anyway — an outlying built plot is a hamlet outside
 *     the town, not part of it.</li>
 * <li><b>Water-aware hole fill.</b> An enclosed pocket of <em>unbuilt land</em> is an artefact of
 *     the claim order and gets promoted into the footprint; an enclosed <em>lake</em> is a real
 *     feature the town built around and is kept. A pocket containing any water is kept whole —
 *     filling the dry half of a shoreline pocket would put lots in the shallows.</li>
 * <li><b>Outline.</b> One outer loop, plus one loop per surviving water hole.</li>
 * </ol>
 * <b>Why not simply assert a single closed loop.</b> The plan's §5.2 wanted exactly that, and §7a
 * then relaxed it to "one outer loop plus zero or more water holes" — because a lake is legitimate.
 * What the components pass guarantees is the <em>outer</em> loop being unique; that is reported in
 * {@link Diagnostics#singleOuterLoop()} rather than asserted, because a render feature must never
 * be able to kill a session thread (§5.1). The caller logs it; nothing throws.
 *
 * @param cells      the surviving cells, sorted by {@code (y, x)} — the order everything downstream
 *                   iterates in
 * @param outer      the boundary of the whole town, in canonical orientation; the wall line before
 *                   it is a wall, and {@link Poly#EMPTY} for an empty footprint
 * @param waterHoles the enclosed water bodies, as loops wound the other way
 * @param diag       what the cleanup did, for the caller to log
 */
public record Footprint(List<Cell> cells, Poly outer, List<Poly> waterHoles, Diagnostics diag) {

	/** The footprint of a settlement that has nothing to stand on yet. */
	public static final Footprint EMPTY = new Footprint(List.of(), Poly.EMPTY, List.of(),
			new Diagnostics(0, 0, 0, 0, 0, 0, true));

	/**
	 * What the cleanup did — enough to explain any footprint in one log line, and the material for
	 * the {@code SimLog} warning §5.2 asks for when the shape was not what we expected.
	 *
	 * @param given            how many cells were offered
	 * @param kept             how many survived into the footprint
	 * @param droppedCells     cells discarded with the smaller components
	 * @param droppedClumps    how many separate components were discarded
	 * @param filledPockets    enclosed land pockets promoted into the footprint
	 * @param waterHoles       enclosed water bodies kept as holes
	 * @param singleOuterLoop  whether the outline came back with exactly one outer boundary, which
	 *                         it always should after the components pass — {@code false} means the
	 *                         cleanup and the outline disagree and the layout deserves a warning
	 */
	public record Diagnostics(int given, int kept, int droppedCells, int droppedClumps,
			int filledPockets, int waterHoles, boolean singleOuterLoop) {

		/** Whether anything was discarded or repaired — i.e. whether this is worth a log line. */
		public boolean interesting() {
			return droppedCells > 0 || filledPockets > 0 || waterHoles > 0 || !singleOuterLoop;
		}

		@Override
		public String toString() {
			return kept + "/" + given + " plots"
					+ (droppedCells > 0 ? ", dropped " + droppedCells + " in " + droppedClumps
							+ " outlying clump(s)" : "")
					+ (filledPockets > 0 ? ", filled " + filledPockets + " land pocket(s)" : "")
					+ (waterHoles > 0 ? ", kept " + waterHoles + " water hole(s)" : "")
					+ (singleOuterLoop ? "" : ", MULTIPLE OUTER LOOPS");
		}
	}

	/**
	 * Build a footprint from the cells a settlement stands on.
	 *
	 * @param claimed the cells — the 1444 starting core union the built plots, in any order
	 * @param isLand  whether a cell that is <em>not</em> in {@code claimed} is dry land. Only ever
	 *                asked about cells enclosed by the footprint, so a predicate that answers
	 *                "this province has a plot there" is enough: a land province generates plots
	 *                for its land cells and no others, making "no plot" exactly "water or not
	 *                ours", and both of those are things a town should build around rather than
	 *                swallow
	 * @return the cleaned footprint, or {@link #EMPTY} when nothing was given
	 */
	public static Footprint of(Collection<Cell> claimed, Predicate<Cell> isLand) {
		Set<Cell> given = new LinkedHashSet<>(claimed);
		if (given.isEmpty()) {
			return EMPTY;
		}
		List<Set<Cell>> clumps = components(given);
		Set<Cell> kept = largest(clumps);
		int droppedCells = given.size() - kept.size();

		Pockets pockets = enclosedPockets(kept, isLand);
		Set<Cell> all = new LinkedHashSet<>(kept);
		all.addAll(pockets.land());

		List<Poly> loops = GridOutline.loops(all);
		Poly outer = GridOutline.outer(loops);
		List<Poly> holes = GridOutline.holes(loops);
		int outerLoops = loops.size() - holes.size();

		List<Cell> sorted = new ArrayList<>(all);
		sorted.sort(Comparator.comparingInt(Cell::y).thenComparingInt(Cell::x));
		return new Footprint(List.copyOf(sorted), outer, List.copyOf(holes),
				new Diagnostics(given.size(), all.size(), droppedCells, clumps.size() - 1,
						pockets.land().size(), holes.size(), outerLoops == 1));
	}

	/** Whether the town stands on nothing. */
	public boolean isEmpty() {
		return cells.isEmpty();
	}

	/** How many plots the town stands on. */
	public int size() {
		return cells.size();
	}

	/** The cells as a set, for membership tests. */
	public Set<Cell> cellSet() {
		return new LinkedHashSet<>(cells);
	}

	/**
	 * The {@code n} cells nearest {@code (cx, cy)}, by squared distance from cell centres, ties
	 * broken on {@code (y, x)}.
	 * <p>
	 * This is the ranking the web has been doing in {@code district-plots.mjs nearestPlots()},
	 * moved server-side — deliberately, and with its tie-break preserved. It answers two questions
	 * that must not be allowed to diverge: which urban plots make up the 1444 starting core (§2.1),
	 * and which footprint plots fall inside the walled core cap (§2b). The client having its own
	 * answer to the first is how the two-footprint disagreement of §2.1 arose in the first place.
	 *
	 * @param cells the candidates
	 * @param n     how many to take; {@code n >= cells.size()} returns them all
	 * @param cx    the centre's x, in plot space (a cell centre is {@code x + 0.5})
	 * @param cy    the centre's y
	 * @return the nearest {@code n}, nearest first
	 */
	public static List<Cell> nearest(Collection<Cell> cells, int n, double cx, double cy) {
		List<Cell> ranked = new ArrayList<>(cells);
		if (n <= 0) {
			return List.of();
		}
		ranked.sort(Comparator
				.comparingDouble((Cell c) -> sq(c.centre().x() - cx) + sq(c.centre().y() - cy))
				.thenComparingInt(Cell::y)
				.thenComparingInt(Cell::x));
		return List.copyOf(ranked.subList(0, Math.min(n, ranked.size())));
	}

	private static double sq(double d) {
		return d * d;
	}

	/** The 4-connected components of a cell set, largest first is <em>not</em> guaranteed. */
	static List<Set<Cell>> components(Set<Cell> cells) {
		List<Set<Cell>> out = new ArrayList<>();
		Set<Cell> seen = new HashSet<>();
		for (Cell start : cells) {
			if (!seen.add(start)) {
				continue;
			}
			Set<Cell> clump = new LinkedHashSet<>();
			Deque<Cell> queue = new ArrayDeque<>();
			queue.add(start);
			clump.add(start);
			while (!queue.isEmpty()) {
				Cell c = queue.poll();
				for (Cell nb : neighbours(c)) {
					if (cells.contains(nb) && seen.add(nb)) {
						clump.add(nb);
						queue.add(nb);
					}
				}
			}
			out.add(clump);
		}
		return out;
	}

	/**
	 * The biggest component. Ties break on the component holding the lowest {@code (y, x)} cell,
	 * so a town that happens to build two equal halves does not flip between them from run to run.
	 */
	private static Set<Cell> largest(List<Set<Cell>> clumps) {
		Set<Cell> best = Set.of();
		Cell bestKey = null;
		for (Set<Cell> c : clumps) {
			Cell key = c.stream()
					.min(Comparator.comparingInt(Cell::y).thenComparingInt(Cell::x))
					.orElse(null);
			boolean better = c.size() > best.size()
					|| (c.size() == best.size() && bestKey != null && key != null
							&& (key.y() < bestKey.y()
									|| (key.y() == bestKey.y() && key.x() < bestKey.x())));
			if (better) {
				best = c;
				bestKey = key;
			}
		}
		return best;
	}

	/**
	 * The pockets enclosed by a cell set, split into the land ones (fill them) and the rest (keep
	 * them as holes). Found by flooding the <em>outside</em> from beyond the bounding box: anything
	 * the flood cannot reach is enclosed.
	 */
	private static Pockets enclosedPockets(Set<Cell> cells, Predicate<Cell> isLand) {
		if (cells.isEmpty()) {
			return new Pockets(Set.of(), Set.of());
		}
		int x0 = Integer.MAX_VALUE, y0 = Integer.MAX_VALUE;
		int x1 = Integer.MIN_VALUE, y1 = Integer.MIN_VALUE;
		for (Cell c : cells) {
			x0 = Math.min(x0, c.x());
			y0 = Math.min(y0, c.y());
			x1 = Math.max(x1, c.x());
			y1 = Math.max(y1, c.y());
		}
		x0--;
		y0--;
		x1++;
		y1++;
		Set<Cell> outside = new HashSet<>();
		Deque<Cell> queue = new ArrayDeque<>();
		Cell seed = new Cell(x0, y0);
		outside.add(seed);
		queue.add(seed);
		while (!queue.isEmpty()) {
			Cell c = queue.poll();
			for (Cell nb : neighbours(c)) {
				if (nb.x() < x0 || nb.x() > x1 || nb.y() < y0 || nb.y() > y1) {
					continue;
				}
				if (cells.contains(nb) || !outside.add(nb)) {
					continue;
				}
				queue.add(nb);
			}
		}
		// every in-box cell that is neither footprint nor reachable from outside is enclosed;
		// group those into pockets and judge each pocket as a whole
		Set<Cell> enclosed = new LinkedHashSet<>();
		for (int y = y0; y <= y1; y++) {
			for (int x = x0; x <= x1; x++) {
				Cell c = new Cell(x, y);
				if (!cells.contains(c) && !outside.contains(c)) {
					enclosed.add(c);
				}
			}
		}
		Set<Cell> land = new LinkedHashSet<>();
		Set<Cell> water = new LinkedHashSet<>();
		for (Set<Cell> pocket : components(enclosed)) {
			boolean allLand = pocket.stream().allMatch(isLand);
			(allLand ? land : water).addAll(pocket);
		}
		return new Pockets(land, water);
	}

	private static List<Cell> neighbours(Cell c) {
		return List.of(new Cell(c.x() + 1, c.y()), new Cell(c.x() - 1, c.y()),
				new Cell(c.x(), c.y() + 1), new Cell(c.x(), c.y() - 1));
	}

	private record Pockets(Set<Cell> land, Set<Cell> water) {
	}
}
