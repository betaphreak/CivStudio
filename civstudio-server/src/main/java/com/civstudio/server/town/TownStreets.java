package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.civstudio.server.town.geom.Graph;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Polyline;
import com.civstudio.server.town.geom.Pt;
import com.civstudio.settlement.ProvincePlotPool;

/**
 * The town's <b>streets</b> — {@code docs/towngen-port.md} T5.
 * <p>
 * Every street starts where a road enters town and ends at the centre, or at the first street it
 * meets on the way. It gets there by A* over the plots themselves, under <b>one weight function
 * carrying every reason a street would rather go elsewhere</b>: the ground's slope, the cost of
 * bridging a river, and the discount for joining a street that already exists. The plan calls the
 * slope term "one line; most of what separates a plausible town map from a convincing one", and the
 * reason is visible the moment it is on: a street that contours around a hill reads as a street
 * somebody wore into the ground, and a street that runs dead straight up it reads as a diagram.
 * <p>
 * <b>The network is a tree, and that is deliberate.</b> Each gate is routed in turn and its path is
 * cut short at the first plot already carrying a street, so two gates on opposite sides of town meet
 * at a crossroads instead of laying two lines of ink down the same plots. The reuse discount is what
 * makes them <em>want</em> to meet: joining an existing street is cheaper than running a parallel
 * one, which is how real street networks come to have a high street at all. A street that reaches
 * the centre under its own steam is {@link Kind#MAIN}; one that ends on another is a branch.
 * <p>
 * <b>Four-connected, like everything else here.</b> The footprint's components, the patch grid clips
 * and the wall are all 4-connected, so the street graph is too: a street can never squeeze through a
 * diagonal gap that the wall considers closed, and a river crossing stays exactly one plot edge — a
 * thing {@link Terrain} can answer without approximation. The streets do not look like a grid for
 * it, because they run through the mesh's <em>jittered</em> seeds rather than plot centres, and are
 * then corner-cut ({@link Polyline#smooth}).
 * <p>
 * <b>Unwalled settlements still have roads.</b> With no gates, streets radiate from the centre out
 * to the footprint edge, aimed at the same neighbour bearings a wall would have put gates on — and,
 * failing even those, at the quarters of the compass. A hamlet has lanes; it just has no gate to
 * hang them on. A <em>walled</em> town short of gates is topped up the same way, for the reason in
 * {@link #WAYS_IN}: a waterfront city's gates are few because its wall is mostly quay, and its
 * traffic comes in over the water rather than not at all.
 *
 * @param streets the streets, in the order they were routed — the first is the one that reached the
 *                centre, and later ones end on earlier ones
 * @param diag    what the routing did, for the caller to log
 */
public record TownStreets(List<Street> streets, Diagnostics diag) {

	/** A settlement with no streets — nothing built, or nowhere for a road to come from. */
	public static final TownStreets NONE =
			new TownStreets(List.of(), new Diagnostics(0, 0, 0, 0, 0));

	/**
	 * What a river crossing costs, as a multiple of an ordinary flat step. High enough that a street
	 * will detour several plots to reach an easier crossing, low enough that a town on both banks
	 * still bridges rather than growing two disconnected halves of street.
	 */
	public static final double BRIDGE_COST = 4.0;

	/**
	 * What a step along an existing street costs, as a fraction of the same step over open ground.
	 * <b>This is the constant that produces a high street.</b> Without it, every gate routes its own
	 * near-optimal line to the centre and the town ends up with a fan of parallel roads; with it,
	 * the second gate would rather walk a little further to join the first than run beside it.
	 */
	public static final double REUSE_DISCOUNT = 0.4;

	/** Corner-cutting passes. Two is enough to read as curved without quadrupling the payload. */
	public static final int SMOOTH_PASSES = 2;

	/**
	 * How many ways into town the streets aim for — roughly one per side, which is what a town of
	 * any size reads as having.
	 * <p>
	 * <b>Why a walled town needs a floor at all.</b> A gate goes only in a curtain segment, so a
	 * town whose line is mostly water gets almost no gates: Nathalaire's is 20 quay to 5 curtain and
	 * yields exactly one, which would leave a city of twenty-seven plots with a single road through
	 * it. That is the wall's correct answer and the wrong town — a waterfront city's traffic comes
	 * in <em>over the water</em> — so the shortfall is made up from its own outward edges, which on
	 * such a town are its landings. It is a target and not a guarantee: an extra way in that opens
	 * straight onto a street the town already has is one junction, not two roads.
	 * <p>
	 * Unwalled settlements are left alone when their neighbours give them any lanes at all. A hamlet
	 * has the roads that lead somewhere, and inventing more would be inventing traffic.
	 */
	public static final int WAYS_IN = 4;

	/** Minimum angular separation between two roads leaving town, matching the gate rule. */
	private static final double MIN_STREET_SEPARATION = Math.PI / 5;         // 36°

	/**
	 * How many ways in are <em>offered</em> before {@link #WAYS_IN} of them are taken. More than the
	 * target on purpose: a way in that turns out to open onto a street the town already has yields no
	 * street, and without spares a town would quietly end up with fewer roads than it aimed for — the
	 * commonest case being a big town whose longest artery already runs out past the far edge the
	 * next candidate was chosen from.
	 */
	private static final int CANDIDATE_WAYS_IN = 8;

	/** What a street is. */
	public enum Kind {

		/** An artery: it runs from the edge of town all the way to the centre. */
		MAIN,
		/** A branch: it runs from the edge of town until it joins another street. */
		STREET
	}

	/**
	 * One street.
	 *
	 * @param points  the line, in plot space, smoothed — its first point is on the town's edge (a
	 *                gate's midpoint, where walled) and its last is the centre or a junction
	 * @param cells   the plots it runs through, in order, before smoothing — the routing's own
	 *                answer, kept because T6 needs to know which patches a street touches to place
	 *                wards and lots along it
	 * @param kind    whether it reached the centre
	 * @param toward  what lies out through its outer end — a neighbouring province's name, or
	 *                {@code null} for a road invented for a town with no recorded crossings
	 * @param bridges how many river crossings it makes
	 */
	public record Street(List<Pt> points, List<Cell> cells, Kind kind, String toward, int bridges) {
	}

	/**
	 * What the routing did.
	 *
	 * @param streets     how many streets were laid
	 * @param arteries    how many of them reached the centre
	 * @param unreachable how many entry points could not reach the centre at all — an extramural
	 *                    cluster is disconnected from the body by definition, so this is normal and
	 *                    not an error; T6's gate clustering is what gives a suburb its own lanes
	 * @param junctions   how many plots carry more than one street
	 * @param bridges     how many river crossings the network makes
	 */
	public record Diagnostics(int streets, int arteries, int unreachable, int junctions,
			int bridges) {

		/** Whether this is worth a log line. */
		public boolean interesting() {
			return unreachable > 0 || bridges > 0;
		}

		@Override
		public String toString() {
			return streets + " streets" + (arteries > 0 ? ", " + arteries + " to the centre" : "")
					+ (junctions > 0 ? ", " + junctions + " junction(s)" : "")
					+ (bridges > 0 ? ", " + bridges + " bridge(s)" : "")
					+ (unreachable > 0 ? ", " + unreachable + " unreachable" : "");
		}
	}

	/**
	 * The ground under the streets. The engine adapter supplies this from the plots; tests supply it
	 * directly, and a flat riverless town needs neither method.
	 */
	public interface Terrain {

		/** The plot's 0..255 heightmap elevation. Flat ground by default. */
		default int elevation(Cell cell) {
			return 0;
		}

		/**
		 * Whether a river runs between two orthogonally adjacent plots — i.e. whether going from one
		 * to the other means crossing water. No rivers by default.
		 */
		default boolean river(Cell from, Cell to) {
			return false;
		}
	}

	/**
	 * Lay a town's streets.
	 *
	 * @param footprint the town's plots
	 * @param mesh      its mesh — the streets run through the patches' jittered seeds, which is
	 *                  where their wander comes from
	 * @param wall      its fortification; its gates are where the roads come in
	 * @param centre    the city centre plot, which every street aims at
	 * @param terrain   the ground the cost function reads
	 * @param bearings  the directions roads leave town in (§6), used when there are no gates to hang
	 *                  them on
	 * @return the streets, or {@link #NONE} for a town with nowhere to route
	 */
	public static TownStreets of(Footprint footprint, TownMesh mesh, TownWall wall, Cell centre,
			Terrain terrain, List<TownWall.Bearing> bearings) {
		if (footprint == null || footprint.isEmpty() || centre == null) {
			return NONE;
		}
		Set<Cell> town = new LinkedHashSet<>(footprint.allCells());
		if (town.size() < 2 || !town.contains(centre)) {
			return NONE;
		}
		List<Entry> entries = entries(town, centre, wall, bearings);
		if (entries.isEmpty()) {
			return NONE;
		}

		Map<Cell, Pt> seeds = seedsOf(mesh, town);
		List<Routed> routed = new ArrayList<>();
		Set<Link> usedLinks = new LinkedHashSet<>();
		Set<Cell> onNetwork = new LinkedHashSet<>();
		onNetwork.add(centre);
		int unreachable = 0;

		for (Entry entry : entries) {
			if (routed.size() >= WAYS_IN) {
				break;                              // the target is streets laid, not ways offered
			}
			if (!town.contains(entry.cell())) {
				unreachable++;
				continue;
			}
			List<Cell> path = route(town, entry.cell(), centre, terrain, usedLinks);
			if (path.isEmpty()) {
				unreachable++;
				continue;
			}
			List<Cell> fresh = untilNetwork(path, onNetwork);
			if (fresh.size() < 2) {
				continue;                       // this gate opens straight onto a street that exists
			}
			for (int i = 0; i + 1 < fresh.size(); i++) {
				usedLinks.add(Link.of(fresh.get(i), fresh.get(i + 1)));
			}
			onNetwork.addAll(fresh);
			routed.add(new Routed(entry, fresh,
					fresh.get(fresh.size() - 1).equals(centre) ? Kind.MAIN : Kind.STREET));
		}
		return assemble(routed, seeds, terrain, unreachable);
	}

	/** Whether any street was laid. */
	public boolean isEmpty() {
		return streets.isEmpty();
	}

	/** Every plot a street runs through. */
	public Set<Cell> streetCells() {
		Set<Cell> out = new LinkedHashSet<>();
		for (Street s : streets) {
			out.addAll(s.cells());
		}
		return out;
	}

	// --- assembly ---------------------------------------------------------------------------

	/**
	 * Turn routed cell paths into drawn lines: the entry point, then each plot's jittered seed,
	 * corner-cut — with every junction pinned so the branch that ends there still touches the street
	 * it ends on, to the last bit.
	 */
	private static TownStreets assemble(List<Routed> routed, Map<Cell, Pt> seeds, Terrain terrain,
			int unreachable) {
		Map<Cell, Integer> visits = new LinkedHashMap<>();
		for (Routed r : routed) {
			for (Cell c : r.cells()) {
				visits.merge(c, 1, Integer::sum);
			}
		}
		List<Street> streets = new ArrayList<>(routed.size());
		int arteries = 0;
		int bridges = 0;
		for (Routed r : routed) {
			List<Pt> raw = new ArrayList<>(r.cells().size() + 1);
			raw.add(r.entry().at());
			for (Cell c : r.cells()) {
				raw.add(seeds.getOrDefault(c, c.centre()));
			}
			boolean[] pinned = new boolean[raw.size()];
			for (int i = 0; i < r.cells().size(); i++) {
				pinned[i + 1] = visits.getOrDefault(r.cells().get(i), 0) > 1;
			}
			int crossings = 0;
			for (int i = 0; i + 1 < r.cells().size(); i++) {
				if (terrain.river(r.cells().get(i), r.cells().get(i + 1))) {
					crossings++;
				}
			}
			bridges += crossings;
			if (r.kind() == Kind.MAIN) {
				arteries++;
			}
			streets.add(new Street(Polyline.smooth(raw, pinned, SMOOTH_PASSES),
					List.copyOf(r.cells()), r.kind(), r.entry().toward(), crossings));
		}
		int junctions = (int) visits.values().stream().filter(n -> n > 1).count();
		return new TownStreets(List.copyOf(streets),
				new Diagnostics(streets.size(), arteries, unreachable, junctions, bridges));
	}

	/** The path prefix up to and including the first plot already carrying a street. */
	private static List<Cell> untilNetwork(List<Cell> path, Set<Cell> onNetwork) {
		List<Cell> fresh = new ArrayList<>();
		for (Cell c : path) {
			fresh.add(c);
			if (onNetwork.contains(c)) {
				break;
			}
		}
		return fresh;
	}

	/** Each plot's jittered seed, so the streets wander with the mesh rather than against it. */
	private static Map<Cell, Pt> seedsOf(TownMesh mesh, Set<Cell> town) {
		Map<Cell, Pt> out = new LinkedHashMap<>();
		if (mesh != null) {
			for (TownMesh.Patch p : mesh.patches()) {
				if (town.contains(p.cell())) {
					out.put(p.cell(), p.seed());
				}
			}
		}
		return out;
	}

	// --- routing ----------------------------------------------------------------------------

	/**
	 * The cheapest way from one plot to another over the town, under the weight function.
	 * <p>
	 * <b>Dijkstra, not A* with a distance heuristic.</b> The reuse discount can take a step below
	 * what any distance-based estimate would allow, so the obvious heuristic stops being admissible
	 * the moment the second street is routed — and an inadmissible heuristic does not fail, it
	 * quietly returns a path that is not the cheapest, which here means a street that mysteriously
	 * declines to join the high street. A town is tens of plots; the zero heuristic costs nothing
	 * and cannot be wrong.
	 */
	private static List<Cell> route(Set<Cell> town, Cell from, Cell to, Terrain terrain,
			Set<Link> used) {
		if (from.equals(to)) {
			return List.of(from);
		}
		Graph<Cell> graph = new Graph<>();
		for (Cell c : town) {
			for (Cell n : orthogonal(c)) {
				if (town.contains(n)) {
					graph.addEdge(c, n, weight(c, n, terrain, used));
				}
			}
		}
		return graph.path(from, to, (a, b) -> 0);
	}

	/**
	 * What one step costs: the ground's slope, the river in the way, and the street already there.
	 * <p>
	 * The slope term is the engine's own {@code ProvincePlotPool.slopeFactor} — <b>borrowed, not
	 * copied</b> (§8b). The client already carries a hand copy of those constants and a third would
	 * be one too many: streets that contour a hill the caravans walk straight over is exactly the
	 * kind of divergence nobody notices until it is on screen in public.
	 */
	private static double weight(Cell from, Cell to, Terrain terrain, Set<Link> used) {
		double w = from.centre().dist(to.centre())
				* ProvincePlotPool.slopeFactor(terrain.elevation(to) - terrain.elevation(from));
		if (terrain.river(from, to)) {
			w *= BRIDGE_COST;
		}
		if (used.contains(Link.of(from, to))) {
			w *= REUSE_DISCOUNT;
		}
		return w;
	}

	private static List<Cell> orthogonal(Cell c) {
		return List.of(new Cell(c.x() + 1, c.y()), new Cell(c.x() - 1, c.y()),
				new Cell(c.x(), c.y() + 1), new Cell(c.x(), c.y() - 1));
	}

	// --- where the roads come in ------------------------------------------------------------

	/**
	 * Where the roads come in, best first.
	 * <ul>
	 * <li><b>The gates</b>, in the order T4 placed them — the nearest border crossing first.</li>
	 * <li><b>Failing gates</b>, the footprint's own outward edges aimed at the same neighbour
	 *     bearings a wall would have hung gates on, so an unwalled hamlet's lanes point where a
	 *     town's gates would (§5.3 leaves it unwalled; it does not leave it roadless).</li>
	 * <li><b>Topping up a walled town</b> that its gates left short of a network, from its own far
	 *     edges — see {@link #WAYS_IN} for why a waterfront city needs this.</li>
	 * </ul>
	 * Every stage keeps the same angular separation from the ones before it, so a topped-up road
	 * never comes in beside a gate.
	 */
	private static List<Entry> entries(Set<Cell> town, Cell centre, TownWall wall,
			List<TownWall.Bearing> bearings) {
		List<Entry> out = new ArrayList<>();
		List<Double> taken = new ArrayList<>();
		// two bearings 40° apart on a small town can pick the same corner plot, and a second road in
		// through a plot that already has one is not a second road — so each way in takes its own
		Set<Cell> claimed = new LinkedHashSet<>();
		boolean walled = wall != null && wall.walled();
		if (wall != null) {
			for (TownWall.Gate g : wall.gates()) {
				out.add(new Entry(g.segment().cell(), g.segment().mid(), g.toward()));
				taken.add(g.bearing());
				claimed.add(g.segment().cell());
			}
		}
		if (out.isEmpty() && bearings != null && !bearings.isEmpty()) {
			out.addAll(radialEntries(town, centre, bearings, taken, claimed, CANDIDATE_WAYS_IN));
		}
		if (out.size() < WAYS_IN && (walled || out.isEmpty())) {
			out.addAll(radialEntries(town, centre, compassBearings(taken), taken, claimed,
					CANDIDATE_WAYS_IN));
		}
		return out;
	}

	/**
	 * Roads in from the footprint's own outward edges: for each bearing, the boundary edge whose
	 * outward normal best matches it and which lies furthest that way — the same score T4 uses to
	 * choose a gate. Bearings already {@code taken} and plots already {@code claimed} are skipped,
	 * and both are added to as roads are chosen.
	 */
	private static List<Entry> radialEntries(Set<Cell> town, Cell centre,
			List<TownWall.Bearing> want, List<Double> taken, Set<Cell> claimed, int limit) {
		Pt from = centre.centre();
		List<Entry> out = new ArrayList<>();
		for (TownWall.Bearing bearing : want) {
			if (out.size() >= limit) {
				break;
			}
			if (tooClose(taken, bearing.bearing())) {
				continue;
			}
			Entry best = null;
			double bestScore = -Double.MAX_VALUE;
			for (Cell c : town) {
				if (c.equals(centre) || claimed.contains(c)) {
					continue;                           // a road cannot enter at the plot it aims at,
				}                                       // nor share a plot with a road already in
				for (TownWall.Side side : TownWall.Side.values()) {
					if (town.contains(side.of(c))) {
						continue;                       // an interior edge is no way in
					}
					double facing = Math.cos(angleDiff(side.outward().angle(), bearing.bearing()));
					if (facing <= 0) {
						continue;
					}
					Pt at = edgeMid(c, side);
					Pt away = at.minus(from);
					// facing AND lying that way — scored exactly as T4 scores a gate, and unscaled
					// by distance on purpose: weighting by how far out an edge lies makes every edge
					// on the same side of town score identically (their along-bearing components are
					// equal), so the road would leave by whichever the set happened to yield first
					double along = away.len() == 0 ? 0
							: Math.cos(angleDiff(away.angle(), bearing.bearing()));
					double score = facing + along;
					if (score > bestScore) {
						bestScore = score;
						best = new Entry(c, at, bearing.toward());
					}
				}
			}
			if (best != null) {
				out.add(best);
				taken.add(bearing.bearing());
				claimed.add(best.cell());
			}
		}
		return out;
	}

	/**
	 * Bearings a town invents for itself when nobody recorded a border crossing: <b>the compass</b>,
	 * evenly divided, minus whatever is already {@code taken}.
	 * <p>
	 * The obvious alternative — aim at the town's own farthest boundary plots — reads well and is
	 * wrong on exactly the towns that need this most. It is greedy by distance, so on a compact
	 * settlement whose centre sits off to one side, every far plot lies in the same arc and the
	 * angular thinning then leaves three bearings out of eight, all pointing the same way.
	 * Nathalaire is such a town and came out with two streets. Dividing the compass instead gives
	 * roads that leave in every direction by construction, and {@link #radialEntries} still picks a
	 * real boundary edge for each, so nothing points at ground the town does not occupy.
	 */
	private static List<TownWall.Bearing> compassBearings(List<Double> taken) {
		List<TownWall.Bearing> out = new ArrayList<>(CANDIDATE_WAYS_IN);
		for (int i = 0; i < CANDIDATE_WAYS_IN; i++) {
			double bearing = -Math.PI + 2 * Math.PI * i / CANDIDATE_WAYS_IN;
			if (!tooClose(taken, bearing)) {
				out.add(new TownWall.Bearing(bearing, null));
			}
		}
		return out;
	}

	private static Pt edgeMid(Cell c, TownWall.Side side) {
		return switch (side) {
			case N -> new Pt(c.x() + 0.5, c.y());
			case S -> new Pt(c.x() + 0.5, c.y() + 1);
			case W -> new Pt(c.x(), c.y() + 0.5);
			case E -> new Pt(c.x() + 1, c.y() + 0.5);
		};
	}

	private static boolean tooClose(List<Double> taken, double bearing) {
		for (double t : taken) {
			if (Math.abs(angleDiff(t, bearing)) < MIN_STREET_SEPARATION) {
				return true;
			}
		}
		return false;
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

	/** Where a road comes into town, and what lies out through it. */
	private record Entry(Cell cell, Pt at, String toward) {
	}

	/** A routed street before it is drawn. */
	private record Routed(Entry entry, List<Cell> cells, Kind kind) {
	}

	/** An undirected step between two plots, canonically ordered so both directions are one key. */
	private record Link(Cell a, Cell b) {

		static Link of(Cell p, Cell q) {
			boolean first = p.y() < q.y() || (p.y() == q.y() && p.x() <= q.x());
			return first ? new Link(p, q) : new Link(q, p);
		}
	}
}
