package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Pt;

/**
 * The town's <b>fortification</b> — {@code docs/towngen-port.md} T4.
 * <p>
 * <b>A wall is not a ring; it is a property of individual plots</b> (owner, 2026-07-28). Every
 * outward-facing edge of a plot on the town's boundary carries one piece of fortification, and what
 * kind it is depends on what lies beyond that edge: dry ground gets curtain wall, water gets a quay
 * or sea wall, a road leaving town gets a gate, a river leaving town gets a water gate. The town's
 * defences are then the sum of its plots' edges rather than a shape drawn around them.
 * <p>
 * That model is worth more than the tidiness. It matches how the reference art actually reads (see
 * §2c — Nathalaire has no curtain at all, it has gate forts on the causeways and chains across the
 * channels), it degrades correctly for a half-built town, and it leaves the door open for
 * fortification to become real engine state one day: a plot that has raised a wall building would
 * simply report a different kind here, and nothing else in the pipeline would change.
 * <p>
 * <b>What is walled.</b> Only a {@linkplain #of permanent} settlement of at least {@link
 * #MIN_WALL_PLOTS} plots is walled at all (§5.3 — this is also what sidesteps the reference
 * generator's degenerate single-patch wall). The wall encloses a <b>capped core</b> (§2b): the
 * nearest {@link #coreCap} plots to the centre, so one of the ~62 all-urban provinces cannot wall a
 * town several times any other's. Everything outside the core is extramural — suburbs, thinning
 * outward, clustered at the gates.
 *
 * @param segments the fortified edges, deterministically ordered by {@code (y, x, side)}; empty for
 *                 an unwalled settlement
 * @param gates    the gates among them, in the order their bearings were offered
 * @param core     the plots the wall encloses — a subset of the footprint's body
 * @param walled   whether this settlement is walled at all
 */
public record TownWall(List<Segment> segments, List<Gate> gates, Set<Cell> core, boolean walled) {

	/** An unfortified settlement — a hamlet, a camp, a town too small to enclose. */
	public static final TownWall NONE = new TownWall(List.of(), List.of(), Set.of(), false);

	/**
	 * The smallest town worth walling. Below this a "wall" is a box around two or three plots,
	 * which reads as a stockade at best and hits the reference generator's degenerate branch at
	 * worst (§5.3).
	 */
	public static final int MIN_WALL_PLOTS = 4;

	/** Minimum angular separation between gates, or two nearby roads produce one double gate. */
	private static final double MIN_GATE_SEPARATION = Math.PI / 5;      // 36°

	/**
	 * Which side of a plot an edge is on. The bit values match the engine's {@code Plot.coast()}
	 * and {@code Plot.riverAdj()} orthogonal masks exactly ({@code 1}=E, {@code 2}=W, {@code 4}=S,
	 * {@code 8}=N), so classifying an edge against either is a bit test and never a lookup table
	 * that can drift out of step with the engine.
	 */
	public enum Side {

		/** The east edge. */
		E(1, 1, 0),
		/** The west edge. */
		W(2, -1, 0),
		/** The south edge ({@code y} grows downward, so south is {@code +y}). */
		S(4, 0, 1),
		/** The north edge. */
		N(8, 0, -1);

		private final int bit;
		private final int dx;
		private final int dy;

		Side(int bit, int dx, int dy) {
			this.bit = bit;
			this.dx = dx;
			this.dy = dy;
		}

		/** The engine mask bit for this side. */
		public int bit() {
			return bit;
		}

		/** The neighbouring cell across this edge. */
		public Cell of(Cell c) {
			return new Cell(c.x() + dx, c.y() + dy);
		}

		/** The outward unit normal. */
		public Pt outward() {
			return new Pt(dx, dy);
		}

		/** Whether this side is set in an engine orthogonal mask. */
		public boolean in(int mask) {
			return (mask & bit) != 0;
		}
	}

	/**
	 * What stands on one plot edge. Ordered loosely by how much of a barrier it is, but the useful
	 * distinction is that a {@code *_GATE} is a way through and everything else is not.
	 */
	public enum Kind {

		/** Curtain wall: the default, facing dry ground. */
		CURTAIN,
		/** A quay or sea wall, facing water — the town's edge is the shore here. */
		QUAY,
		/** A gate where a road leaves town toward a neighbouring province. */
		ROAD_GATE,
		/** A water gate where a river passes through the line — historically barred or chained. */
		RIVER_GATE;

		/** Whether this is a way through the line. */
		public boolean isGate() {
			return this == ROAD_GATE || this == RIVER_GATE;
		}
	}

	/**
	 * One fortified plot edge.
	 *
	 * @param cell the plot it belongs to — fortification is per-plot, so this is the plot that
	 *             would carry the wall building if walls ever become engine state
	 * @param side which edge of that plot
	 * @param a    one end of the segment, in plot space
	 * @param b    the other end
	 * @param kind what stands here
	 */
	public record Segment(Cell cell, Side side, Pt a, Pt b, Kind kind) {

		/** The segment's midpoint — where a gate's street meets the line. */
		public Pt mid() {
			return a.mid(b);
		}
	}

	/**
	 * A gate, and what it faces.
	 *
	 * @param segment the fortified edge it stands in
	 * @param toward  what it is aimed at — a neighbouring province's name or id, or {@code null}
	 *                for a river gate, which is aimed at nothing but the water
	 * @param bearing the bearing it was chosen for, in radians
	 */
	public record Gate(Segment segment, String toward, double bearing) {
	}

	/**
	 * A direction something leaves town in — a neighbouring province's border crossing (§6), so
	 * that the town's main streets end up pointing at the roads that actually leave it.
	 *
	 * @param bearing where it lies, in radians, from the town centre
	 * @param toward  what lies that way
	 */
	public record Bearing(double bearing, String toward) {
	}

	/**
	 * What lies beyond a plot edge. The engine adapter supplies this from {@code Plot.coast()} and
	 * {@code Plot.riverAdj()}; tests supply it directly.
	 */
	@FunctionalInterface
	public interface EdgeInfo {

		/** Whether the given edge of the given plot faces water. */
		boolean water(Cell cell, Side side);

		/** Whether a river crosses this edge. Defaults to no river anywhere. */
		default boolean river(Cell cell, Side side) {
			return false;
		}
	}

	/**
	 * Fortify a town.
	 *
	 * @param footprint the town's plots
	 * @param permanent whether the settlement is permanent ({@code Settlement.isPermanent()},
	 *                  true from {@code TOWN} up) — an impermanent one is never walled
	 * @param coreCap   how many plots the wall may enclose (§2b); {@code <= 0} means no cap
	 * @param centre    the town centre, in plot space, that the core is measured from
	 * @param edges     what lies beyond each edge
	 * @param bearings  the directions roads leave town in, best first
	 * @return the fortification, or {@link #NONE} for a settlement that gets none
	 */
	public static TownWall of(Footprint footprint, boolean permanent, int coreCap, Pt centre,
			EdgeInfo edges, List<Bearing> bearings) {
		if (!permanent || footprint.size() < MIN_WALL_PLOTS) {
			return NONE;
		}
		Set<Cell> core = core(footprint, coreCap, centre);
		if (core.size() < MIN_WALL_PLOTS) {
			return NONE;
		}
		List<Segment> segments = new ArrayList<>();
		for (Cell c : core) {
			for (Side side : Side.values()) {
				if (core.contains(side.of(c))) {
					continue;                       // interior edge: nothing to fortify
				}
				segments.add(segment(c, side, kind(c, side, edges)));
			}
		}
		segments.sort(Comparator.comparingInt((Segment s) -> s.cell().y())
				.thenComparingInt(s -> s.cell().x())
				.thenComparing(Segment::side));
		List<Gate> gates = gates(segments, centre, bearings);
		return new TownWall(List.copyOf(segments), gates, Set.copyOf(core), true);
	}

	/**
	 * The plots the wall encloses: the {@code cap} nearest the centre, reduced to their largest
	 * connected clump so the wall never has to wrap two pieces. An uncapped or oversized cap
	 * returns the whole body.
	 *
	 * @param footprint the town
	 * @param cap       the maximum plots to enclose, or {@code <= 0} for no cap
	 * @param centre    the point to measure from
	 * @return the core cells
	 */
	public static Set<Cell> core(Footprint footprint, int cap, Pt centre) {
		List<Cell> body = footprint.cells();
		if (cap <= 0 || cap >= body.size()) {
			return new LinkedHashSet<>(body);
		}
		Set<Cell> near = new LinkedHashSet<>(Footprint.nearest(body, cap, centre.x(), centre.y()));
		// taking the nearest N can sever a limb of the body; the wall encloses the largest piece
		// that survives, and the severed part becomes extramural like any other suburb
		List<Set<Cell>> clumps = Footprint.components(near);
		Set<Cell> best = new LinkedHashSet<>();
		for (Set<Cell> clump : clumps) {
			if (clump.size() > best.size()) {
				best = new LinkedHashSet<>(clump);
			}
		}
		return best;
	}

	/** Whether the given plot is enclosed by this wall. */
	public boolean encloses(Cell cell) {
		return core.contains(cell);
	}

	/** The fortified edges of one plot. */
	public List<Segment> segmentsOf(Cell cell) {
		List<Segment> out = new ArrayList<>();
		for (Segment s : segments) {
			if (s.cell().equals(cell)) {
				out.add(s);
			}
		}
		return out;
	}

	private static Kind kind(Cell c, Side side, EdgeInfo edges) {
		if (edges.river(c, side)) {
			return Kind.RIVER_GATE;                 // the water gets through whatever we build
		}
		if (edges.water(c, side)) {
			return Kind.QUAY;
		}
		return Kind.CURTAIN;
	}

	private static Segment segment(Cell c, Side side, Kind kind) {
		double x = c.x(), y = c.y();
		Pt a;
		Pt b;
		switch (side) {
			case N -> {
				a = new Pt(x, y);
				b = new Pt(x + 1, y);
			}
			case E -> {
				a = new Pt(x + 1, y);
				b = new Pt(x + 1, y + 1);
			}
			case S -> {
				a = new Pt(x + 1, y + 1);
				b = new Pt(x, y + 1);
			}
			default -> {
				a = new Pt(x, y + 1);
				b = new Pt(x, y);
			}
		}
		return new Segment(c, side, a, b, kind);
	}

	/**
	 * Place gates: for each bearing, the boundary segment whose outward normal best matches it.
	 * <p>
	 * Three rules, all inherited from §6 and all still necessary. A gate never goes in a quay (a
	 * road does not leave over water — that is a harbour, and its own problem); a river gate is
	 * already a way through, so a road gate is not doubled onto it; and gates keep a minimum
	 * angular separation, which replaces the reference generator's vertex-splicing rule that a
	 * polyomino outline would turn into a wall of almost nothing but gates (§5.4).
	 */
	private static List<Gate> gates(List<Segment> segments, Pt centre, List<Bearing> bearings) {
		List<Gate> gates = new ArrayList<>();
		List<Double> taken = new ArrayList<>();
		for (Bearing want : bearings) {
			if (tooClose(taken, want.bearing())) {
				continue;
			}
			int best = -1;
			double bestScore = -Double.MAX_VALUE;
			for (int i = 0; i < segments.size(); i++) {
				Segment s = segments.get(i);
				if (s.kind() != Kind.CURTAIN) {
					continue;
				}
				// how well this edge faces the bearing, and how far out it lies in that direction:
				// a gate belongs on the side of town the road leaves from, not merely on an edge
				// that happens to point the right way
				double facing = Math.cos(angleDiff(bearingOf(s.side()), want.bearing()));
				if (facing <= 0) {
					continue;
				}
				Pt out = s.mid().minus(centre);
				double along = out.len() == 0 ? 0 : Math.cos(angleDiff(out.angle(), want.bearing()));
				double score = facing + along;
				if (score > bestScore) {
					bestScore = score;
					best = i;
				}
			}
			if (best < 0) {
				continue;                            // no land edge faces that way; skip it
			}
			Segment s = segments.get(best);
			segments.set(best, new Segment(s.cell(), s.side(), s.a(), s.b(), Kind.ROAD_GATE));
			gates.add(new Gate(segments.get(best), want.toward(), want.bearing()));
			taken.add(want.bearing());
		}
		return List.copyOf(gates);
	}

	private static boolean tooClose(List<Double> taken, double bearing) {
		for (double t : taken) {
			if (Math.abs(angleDiff(t, bearing)) < MIN_GATE_SEPARATION) {
				return true;
			}
		}
		return false;
	}

	private static double bearingOf(Side side) {
		return side.outward().angle();
	}

	/** The signed difference between two bearings, wrapped to [-π, π]. */
	private static double angleDiff(double a, double b) {
		double d = a - b;
		while (d > Math.PI) {
			d -= 2 * Math.PI;
		}
		while (d < -Math.PI) {
			d += 2 * Math.PI;
		}
		return d;
	}
}
