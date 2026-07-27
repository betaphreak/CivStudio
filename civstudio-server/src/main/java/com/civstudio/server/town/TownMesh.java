package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Lloyd;
import com.civstudio.server.town.geom.Poly;
import com.civstudio.server.town.geom.Pt;
import com.civstudio.server.town.geom.TownScale;
import com.civstudio.server.town.geom.Voronoi;

/**
 * The <b>mesh</b>: one patch per plot ({@code docs/towngen-port.md} T3, the core inversion of §4).
 * <p>
 * The reference generator <em>creates</em> its shape — scatter points, take the nearest cells as
 * the city. We invert it: the shape is given by sim state and the mesh is fitted to it. One seed
 * per plot centre, jittered, clamped, one Lloyd pass. A patch therefore <b>is</b> a plot, so the
 * engine's per-plot district type is the patch's ward and the client never has to invent district
 * identity.
 * <p>
 * <b>Grid-line clips instead of boolean geometry.</b> The footprint is a polyomino — concave,
 * sometimes holed — and clipping convex cells to it would need general polygon boolean ops
 * (Sutherland–Hodgman is exact only against a convex window). Instead each patch is clipped by the
 * shared grid line with any <b>empty orthogonal neighbour</b>: four half-planes at worst, exact for
 * a polyomino, and every patch stays a convex intersection of half-planes. No boolean geometry
 * anywhere in the pipeline.
 * <p>
 * Ghost seeds in the empty cells were the obvious alternative and are <b>worse</b>: a bisector
 * against a ghost falls short of the plot edge, so every boundary ward would pull back from the
 * wall and leave a ring of unclaimed ground between the last houses and the fortification. The grid
 * clip puts the ward exactly on the line the wall will follow. The residue is a diagonal corner —
 * where a patch reaches across the corner into an empty diagonal cell — bounded by the jitter
 * radius, rare, and hidden under the wall the moment T4 draws one.
 * <p>
 * <b>Everything is computed locally, and that is a guarantee, not an optimisation.</b> Each patch
 * is built from the seeds within two plots of it, against bounds derived from its own cell — never
 * from the town's bounding box. A patch is therefore a bit-exact function of its own 5×5
 * neighbourhood, so a plot built on the far side of town cannot perturb it, not even in the last
 * ulp. Deriving the bounds globally (the obvious way) silently broke this: growing the town moved
 * the box, and every patch in it shifted a few ulps — which is the same class of bug as
 * stream-ordered jitter, just quieter.
 * <p>
 * <b>Suburbs get patches too.</b> The mesh runs over {@link Footprint#allCells()}, so extramural
 * clusters (§2b) are meshed exactly like the walled body — they are built ground with households on
 * them. The wall decides what a patch is <em>inside</em> of, not whether it exists.
 *
 * @param patches  one patch per footprint plot, in the footprint's {@code (y, x)} order
 * @param siteSeed the seed this mesh was derived from
 * @param diag     what the fit did, for the caller to log
 */
public record TownMesh(List<Patch> patches, long siteSeed, Diagnostics diag) {

	/** An empty mesh — a settlement standing on nothing. */
	public static final TownMesh EMPTY = new TownMesh(List.of(), 0, new Diagnostics(0, 0, 0));

	/**
	 * One patch: the ward-shaped piece of ground belonging to exactly one plot.
	 *
	 * @param cell    the plot it belongs to
	 * @param seed    the jittered, clamped seed its cell was grown from
	 * @param poly    the patch outline, convex, in plot space
	 * @param walled  whether this plot is in the walled body ({@code false} for an extramural
	 *                cluster — §2b)
	 */
	public record Patch(Cell cell, Pt seed, Poly poly, boolean walled) {
	}

	/**
	 * What the fit did.
	 *
	 * @param patches          how many patches were produced
	 * @param extramural       how many of them are outside the walled body
	 * @param bijectionRepairs how many patches failed to contain their own plot centre and were
	 *                         replaced by the plot square. Under the clamp this is <b>always
	 *                         zero</b> — the bijection holds by construction (§4.1) — so a non-zero
	 *                         count means an invariant broke and the layout deserves a warning, not
	 *                         that the mesh is unusable
	 */
	public record Diagnostics(int patches, int extramural, int bijectionRepairs) {

		/** Whether this is worth a log line. */
		public boolean interesting() {
			return bijectionRepairs > 0;
		}

		@Override
		public String toString() {
			return patches + " patches" + (extramural > 0 ? ", " + extramural + " extramural" : "")
					+ (bijectionRepairs > 0 ? ", " + bijectionRepairs + " BIJECTION REPAIRS" : "");
		}
	}

	/**
	 * Fit a mesh to a footprint.
	 *
	 * @param footprint the town's plots
	 * @param siteSeed  the site's layout seed ({@link TownRng#siteSeed})
	 * @return the mesh, or {@link #EMPTY} for an empty footprint
	 */
	public static TownMesh of(Footprint footprint, long siteSeed) {
		List<Cell> cells = footprint.allCells();
		if (cells.isEmpty()) {
			return EMPTY;
		}
		Set<Cell> town = new LinkedHashSet<>(cells);
		Set<Cell> walled = footprint.cellSet();

		Map<Cell, Pt> jittered = new LinkedHashMap<>();
		for (Cell c : cells) {
			jittered.put(c, Lloyd.jitterAt(c.centre(), TownScale.JITTER_R,
					TownRng.cellKey(siteSeed, c.x(), c.y())));
		}
		Map<Cell, Pt> seeds = relax(cells, jittered, town);

		List<Patch> patches = new ArrayList<>(cells.size());
		int repairs = 0;
		int extramural = 0;
		for (Cell c : cells) {
			Poly poly = clipToNeighbours(patchOf(c, seeds, town), c, town);
			if (poly.isEmpty() || !poly.contains(c.centre())) {
				// the bijection is guaranteed by the clamp (§4.1), so this cannot happen — and if
				// it ever does, one square patch is a far better outcome than a dead session
				poly = c.square();
				repairs++;
			}
			boolean inWall = walled.contains(c);
			if (!inWall) {
				extramural++;
			}
			patches.add(new Patch(c, seeds.get(c), poly, inWall));
		}
		return new TownMesh(List.copyOf(patches), siteSeed,
				new Diagnostics(patches.size(), extramural, repairs));
	}

	/** The patch belonging to each plot. */
	public Map<Cell, Patch> byCell() {
		Map<Cell, Patch> out = new LinkedHashMap<>();
		for (Patch p : patches) {
			out.put(p.cell(), p);
		}
		return out;
	}

	/** Whether the mesh has no patches. */
	public boolean isEmpty() {
		return patches.isEmpty();
	}

	/**
	 * How far a patch can possibly reach, in plots. A patch is bounded by the bisectors with its
	 * immediate neighbours (or by the grid clip where one is missing), so it never extends more
	 * than about a plot from its anchor; seeds two plots out already bisect beyond that, and are
	 * included only as insurance.
	 */
	private static final int LOCAL_RADIUS = 2;

	/** Lloyd relaxation, run locally per cell so a distant plot cannot perturb the result. */
	private static Map<Cell, Pt> relax(List<Cell> cells, Map<Cell, Pt> jittered, Set<Cell> town) {
		Map<Cell, Pt> cur = jittered;
		for (int pass = 0; pass < TownScale.LLOYD_PASSES; pass++) {
			Map<Cell, Pt> next = new LinkedHashMap<>();
			for (Cell c : cells) {
				Poly cell = clipToNeighbours(patchOf(c, cur, town), c, town);
				Pt moved = cell.isEmpty() ? cur.get(c) : cell.centroid();
				next.put(c, Lloyd.clamp(moved, c.centre(), TownScale.JITTER_R));
			}
			cur = next;
		}
		return cur;
	}

	/**
	 * One cell's Voronoi region against its local neighbourhood, in local bounds. Both the seed set
	 * and the bounds are derived from the cell itself, which is what makes a patch independent of
	 * everything more than {@link #LOCAL_RADIUS} plots away.
	 */
	private static Poly patchOf(Cell c, Map<Cell, Pt> seeds, Set<Cell> town) {
		List<Pt> local = new ArrayList<>();
		int self = -1;
		for (int dy = -LOCAL_RADIUS; dy <= LOCAL_RADIUS; dy++) {
			for (int dx = -LOCAL_RADIUS; dx <= LOCAL_RADIUS; dx++) {
				Cell n = new Cell(c.x() + dx, c.y() + dy);
				if (!town.contains(n)) {
					continue;
				}
				if (n.equals(c)) {
					self = local.size();
				}
				local.add(seeds.get(n));
			}
		}
		if (self < 0) {
			return Poly.EMPTY;
		}
		return Voronoi.cell(local, self, Poly.rect(c.x() - 1, c.y() - 1, 3, 3));
	}

	/**
	 * Clip a patch at the grid lines it must not cross: the shared edge with any empty orthogonal
	 * neighbour. Exact for a polyomino, convex, and four half-planes at worst.
	 */
	private static Poly clipToNeighbours(Poly poly, Cell c, Set<Cell> town) {
		Poly out = poly;
		if (!town.contains(new Cell(c.x() + 1, c.y()))) {
			out = out.clipHalfPlane(new Pt(c.x() + 1, c.y()), new Pt(-1, 0));
		}
		if (!town.contains(new Cell(c.x() - 1, c.y()))) {
			out = out.clipHalfPlane(new Pt(c.x(), c.y()), new Pt(1, 0));
		}
		if (!town.contains(new Cell(c.x(), c.y() + 1))) {
			out = out.clipHalfPlane(new Pt(c.x(), c.y() + 1), new Pt(0, -1));
		}
		if (!town.contains(new Cell(c.x(), c.y() - 1))) {
			out = out.clipHalfPlane(new Pt(c.x(), c.y()), new Pt(0, 1));
		}
		return out;
	}
}
