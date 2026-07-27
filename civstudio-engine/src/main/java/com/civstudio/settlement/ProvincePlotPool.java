package com.civstudio.settlement;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

import com.civstudio.geo.PlotType;
import com.civstudio.geo.Province;
import com.civstudio.geo.RouteType;
import com.civstudio.geo.ProvincePlotField;
import com.civstudio.geo.ProvincePlotField.ProvincePlot;
import com.civstudio.geo.ProvinceRaster;
import com.civstudio.geo.TerrainRegistry;
import com.civstudio.tech.Sector;
import com.civstudio.util.Rng;

/**
 * The shared, claimable plot field of one province: the {@link Province}'s land
 * pixels realised as occupiable {@link Plot}s, owned by the province until a
 * settlement claims them. Generated once per province (lazily, cached on the
 * {@link GameSession}) from the Phase-1 {@link ProvincePlotField} terrain
 * generation, and shared by every settlement founded into the province — the
 * substrate for several settlements occupying one province (see {@code
 * docs/province-plots.md}).
 * <p>
 * Ownership is <b>hybrid</b>: a plot is free (province-owned, {@link Plot#owner()}
 * {@code null}) until a settlement claims it, which transfers it to that
 * settlement; {@link #release(Plot) releasing} returns it to the free pool. A
 * settlement claims via {@link #claimFoundingCenter} (its first plot, spaced from
 * any other settlement already in the province) then {@link #claimNearest} (each
 * subsequent plot, nearest its center). Because several settlements in one province
 * claim from the same pool — concurrently, under the lockstep
 * {@link com.civstudio.simulation.SessionRunner} — every mutating operation is
 * {@code synchronized}; a claim that finds no free plot returns {@code null} (the
 * caller treats it as "no room", never an error). See {@code docs/province-plots.md}.
 */
public final class ProvincePlotPool {

	private final Province province;
	private final List<Plot> plots;
	private int freeCount;
	private final int centroidX; // the founding anchor for the first settlement
	private final int centroidY;

	// lazily-built spatial index (packed (x,y) -> workable plot) and corridor cache, for
	// the caravan land-routing corridors (docs/land-routing.md Level 2). Built on first
	// corridor() request; a province with no caravan crossing it never pays for them.
	private Map<Long, Plot> posIndex;
	private final Map<Long, PlotCorridor> corridorCache = new HashMap<>();

	// the authoritative per-session route layer for this province: the plots that carry a route
	// (trail/paved road/…), in the order they were first laid. It lives on the pool, not on the band
	// that pioneered it, so it survives the band's dissolution and is the whole standing network —
	// what the viewport-windowed route feed serves per province (docs/route-rendering.md §Viewport-
	// windowed route persistence). routeRev bumps on every change, the "this province's routes moved
	// since you last fetched" signal the render snapshot advertises.
	private final Set<Plot> routedPlots = new LinkedHashSet<>();
	private int routeRev;
	// The neighbour ring — cells just OUTSIDE the province, carried only so the web feed can ship
	// them for border blending. NEVER claimable, never counted, never settled: they are not this
	// province's land. Empty on the persisted path (the ring lives in the cached bytes, and the sim
	// has no use for it) — see ProvincePlotStore.
	private final List<ProvincePlotField.EdgeCell> edge;

	private ProvincePlotPool(Province province, List<Plot> plots) {
		this(province, plots, List.of());
	}

	private ProvincePlotPool(Province province, List<Plot> plots,
			List<ProvincePlotField.EdgeCell> edge) {
		this.province = province;
		this.plots = plots;
		this.edge = edge;
		this.freeCount = plots.size();
		long sx = 0, sy = 0;
		for (Plot p : plots) {
			sx += p.x();
			sy += p.y();
			// seed the registry from any plot that already carries a route — the urban trailing
			// (trailUrbanPlots) runs on the plot list before this constructor, so the city core's
			// trails land here without touching that path. Seeding does not bump routeRev: a
			// client fetches a province's routes on first view regardless; the rev is only the
			// "changed since" delta signal.
			if (p.routeType() != null)
				routedPlots.add(p);
		}
		int n = Math.max(1, plots.size());
		this.centroidX = Math.round((float) sx / n);
		this.centroidY = Math.round((float) sy / n);
	}

	/**
	 * Build a province's pool: generate its plot field and realise each
	 * {@link ProvincePlot} as a free, claimable {@link Plot} (position + terrain +
	 * relief + feature + resource). Deterministic per {@code rng} (a per-province
	 * terrain stream).
	 *
	 * @param province the province to build the pool for
	 * @param registry the curated terrain/feature/bonus definitions
	 * @param raster   the raster reader (supplies the province mask)
	 * @param rng      the dedicated per-province terrain stream
	 * @return the province's claimable plot pool
	 */
	public static ProvincePlotPool generate(Province province, TerrainRegistry registry,
			ProvinceRaster raster, Rng rng) throws IOException {
		ProvincePlotField field = ProvincePlotField.generate(province, registry, raster, rng);
		List<Plot> plots = new ArrayList<>(field.size());
		for (ProvincePlot pp : field.plots())
			plots.add(toPlot(pp));
		trailUrbanPlots(plots, registry);
		return new ProvincePlotPool(province, plots, field.edge());
	}

	// a generated province plot -> a free runtime Plot, carrying the built-up `urban` overlay
	// (an urban plot keeps its natural terrain/relief; `urban` is a property, not a terrain).
	private static Plot toPlot(ProvincePlot pp) {
		Plot plot = new Plot(pp.geo(), pp.terrain(), pp.plotType(), pp.feature(), pp.bonus());
		plot.setUrban(pp.urban());
		return plot;
	}

	/**
	 * Build a province's pool from its <b>persisted</b> plot field when one exists (see
	 * {@link ProvincePlotStore}), generating and persisting it on first use otherwise. This
	 * is the path a live session uses: the (expensive) per-tile generation is paid once and
	 * the canonical field reused by every run. The {@code rng} must be the
	 * {@linkplain com.civstudio.util.RngSeed#forProvinceCanonical seed-independent} terrain
	 * stream, so a regenerated field always matches the persisted one.
	 *
	 * @param province the province to build the pool for
	 * @param registry the curated terrain/feature/bonus definitions
	 * @param raster   the raster reader (supplies the province mask, only if generating)
	 * @param rng      the seed-independent per-province terrain stream
	 * @return the province's claimable plot pool
	 */
	public static ProvincePlotPool loadOrGenerate(Province province, TerrainRegistry registry,
			ProvinceRaster raster, Rng rng) throws IOException {
		List<Plot> plots = ProvincePlotStore.load(province.id(), registry);
		if (plots == null) {
			ProvincePlotField field = ProvincePlotField.generate(province, registry, raster, rng);
			plots = new ArrayList<>(field.size());
			for (ProvincePlot pp : field.plots())
				plots.add(toPlot(pp));
			ProvincePlotStore.save(province.id(), plots, field.edge());
		}
		trailUrbanPlots(plots, registry);
		return new ProvincePlotPool(province, plots);
	}

	// urban (city-core) plots start TRAILED — every urban plot begins with a trail (the tier the
	// Explorer pioneers), so a settlement's own ground is routable from founding (a trail is the
	// minimum a caravan needs to leave, once trail-gating lands in Phase 6) WITHOUT handing the city
	// a free paved network. A paved road is real infrastructure a settlement builds; the city has to
	// earn its paving (docs/city-of-hamlets-plan.md §8 — the roads→trails cleanup that ships with
	// urban-fields). A per-session default applied at pool construction — routes are per-session state
	// and never bake into the canonical .map (ProvincePlotStore serializes only terrain/feature/bonus).
	// Set before any corridor is cached, so no invalidation is needed. See docs/explorer-caravan.md §Phase 3.
	private static void trailUrbanPlots(List<Plot> plots, TerrainRegistry registry) {
		RouteType trail = registry.route(RouteType.TRAIL);
		if (trail == null)
			return;
		for (Plot p : plots)
			if (p.urban())
				p.layRoute(trail);
	}

	/** The province this pool belongs to. */
	public Province province() {
		return province;
	}

	/**
	 * Record that a route was laid (or upgraded) on one of this province's plots, so the standing
	 * route layer this pool serves stays authoritative. Every route-laying site calls this after
	 * {@link Plot#layRoute}: a caravan pioneering a trail ({@link
	 * com.civstudio.agent.MarchingCaravan#layTrail}), a future road-builder. Urban trailing is
	 * captured by the constructor's seed scan instead, so it need not call here. Idempotent: a plot
	 * already in the layer is not re-added, but any call bumps {@link #routeRev()} (an upgrade
	 * trail→road is a change clients must refetch even though the plot was already routed).
	 *
	 * @param plot the plot a route was just laid on (must already carry a {@link Plot#routeType()})
	 */
	public void recordRoute(Plot plot) {
		assert plot.routeType() != null : "recordRoute called before layRoute";
		// synchronized because the route feed reads this off the request thread while the sim thread
		// lays trails; the set doubles as the monitor guarding it and routeRev (see routedPlots()).
		synchronized (routedPlots) {
			routedPlots.add(plot);
			routeRev++;
		}
	}

	/**
	 * A consistent read of this province's route layer — its routed plots (the whole standing
	 * network, in first-laid order) paired with the {@code rev} they were read at, taken atomically
	 * under one lock so the two never disagree even as the sim thread lays more. This is what the
	 * viewport-windowed route feed serves per province (docs/route-rendering.md); the layer survives
	 * band dissolution (it lives on the pool, not on the band that pioneered it).
	 *
	 * @return a snapshot of the routed plots and the route revision, safe to read off the sim thread
	 */
	public RouteSnapshot routeSnapshot() {
		synchronized (routedPlots) {
			return new RouteSnapshot(routeRev, new ArrayList<>(routedPlots));
		}
	}

	/**
	 * Whether this province carries any route at all — a cheap check used to decide whether a
	 * freshly-built (possibly trailed) pool should notify viewing clients (see {@link
	 * GameSession#provincePlotPool}).
	 *
	 * @return {@code true} if at least one plot carries a route
	 */
	public boolean hasRoutes() {
		synchronized (routedPlots) {
			return !routedPlots.isEmpty();
		}
	}

	/**
	 * A consistent snapshot of a province's route layer — the routed plots and the {@code rev} they
	 * were read at, taken together so a client that dedupes redundant fetches on {@code rev} never
	 * stores a rev newer than the plots it holds.
	 *
	 * @param rev   the route revision at the read
	 * @param plots the routed plots (a copy the caller owns), in first-laid order
	 */
	public record RouteSnapshot(int rev, List<Plot> plots) {
	}

	/** All plots of the province (free and claimed), an unmodifiable view. */
	public List<Plot> plots() {
		return Collections.unmodifiableList(plots);
	}

	/**
	 * The neighbour ring — cells just OUTSIDE the province, for the web feed's border blending only
	 * (see {@link ProvincePlotField.EdgeCell}). Not plots: nothing may claim, settle or count these.
	 * Empty when the pool was restored from the persisted field, which the sim reads plots-only.
	 */
	public List<ProvincePlotField.EdgeCell> edge() {
		return edge;
	}

	/** The total number of plots (== {@code province.plots()}). */
	public int size() {
		return plots.size();
	}

	/** The raster x of the province's plot centroid (a corridor anchor fallback). */
	public int centroidX() {
		return centroidX;
	}

	/** The raster y of the province's plot centroid (a corridor anchor fallback). */
	public int centroidY() {
		return centroidY;
	}

	/** The number of unclaimed (province-owned) plots. */
	public synchronized int freeCount() {
		return freeCount;
	}

	/**
	 * Whether a settlement is present in this province — i.e. any plot is <b>claimed</b> (owned).
	 * A live colony owns its claimed plots; a dead one releases them back to the pool, so an
	 * all-free pool means no settlement. Used by the caravan camp rule: a marching band may not
	 * camp on an urban plot of a <em>settled</em> province, but an abandoned urban core is fair
	 * game (a nightly {@link com.civstudio.agent.march.Camp} is a non-owning occupant, so it never
	 * flips this). O(1) off the free-plot counter.
	 */
	public synchronized boolean hasSettlement() {
		return freeCount < plots.size();
	}

	/**
	 * Claim the free plot nearest {@code (cx, cy)} for a settlement, transferring its
	 * ownership — a settlement's per-plot claim, growing outward from its center.
	 *
	 * @param owner the claiming settlement (non-null)
	 * @param cx    the settlement's center x
	 * @param cy    the settlement's center y
	 * @return the claimed plot, or {@code null} if the pool is exhausted
	 */
	public synchronized Plot claimNearest(Settlement owner, int cx, int cy) {
		return take(owner, bestYieldNearest(cx, cy));
	}

	/**
	 * Claim a settlement's <b>founding center</b>: the free plot best spaced from any
	 * plots already claimed by <em>other</em> settlements in the province (so several
	 * settlements spread out), or — for the first settlement — the plot nearest the
	 * province centroid.
	 *
	 * @param owner the founding settlement (non-null)
	 * @return the claimed center plot, or {@code null} if the pool is exhausted
	 */
	public synchronized Plot claimFoundingCenter(Settlement owner) {
		return take(owner, foundingCenter(owner));
	}

	/**
	 * Claim a specific free plot for a settlement (used directly in tests; settlements
	 * claim via {@link #claimNearest}/{@link #claimFoundingCenter}).
	 *
	 * @param plot  a plot of this pool that is currently free
	 * @param owner the claiming settlement (non-null)
	 * @throws IllegalArgumentException if the plot is not free or owner is null
	 */
	public synchronized void claim(Plot plot, Settlement owner) {
		if (owner == null)
			throw new IllegalArgumentException("owner must be non-null");
		if (plot == null || plot.owner() != null)
			throw new IllegalArgumentException("plot is not free to claim");
		take(owner, plot);
	}

	/**
	 * Release a claimed plot back to the free pool (clearing its owner). A no-op for a
	 * plot that is already free.
	 *
	 * @param plot a plot of this pool
	 */
	public synchronized void release(Plot plot) {
		if (plot != null && plot.owner() != null) {
			plot.setOwner(null);
			freeCount++;
		}
	}

	// transfer a (free) plot to owner; null-safe so the claim helpers can pass a
	// failed search straight through as a null result
	private Plot take(Settlement owner, Plot plot) {
		if (plot == null)
			return null;
		plot.setOwner(owner);
		freeCount--;
		return plot;
	}

	// how many of the nearest free plots a settlement weighs by food yield when it
	// claims — it takes the best-food plot among its nearest few, favouring good land
	// in its vicinity without abandoning the nearest-first growth (which keeps the
	// travel ladder and the food-balance calibration stable). A small, proximity-
	// dominant placeholder pending calibration (1 == pure nearest-first).
	private static final int YIELD_CHOICE_NEIGHBOURS = 4;

	// the best-food free plot among the YIELD_CHOICE_NEIGHBOURS nearest to (cx, cy):
	// proximity picks the candidate band, yield picks within it (Phase 4b/4c). Returns
	// null if the pool is exhausted.
	private Plot bestYieldNearest(int cx, int cy) {
		int k = YIELD_CHOICE_NEIGHBOURS;
		long[] nearDist = new long[k];
		Plot[] nearPlot = new Plot[k];
		Arrays.fill(nearDist, Long.MAX_VALUE);
		for (Plot p : plots) {
			if (p.owner() != null)
				continue;
			long d = dist2(p, cx, cy);
			// keep the k nearest: replace the current farthest if this is closer
			int farthest = 0;
			for (int i = 1; i < k; i++)
				if (nearDist[i] > nearDist[farthest])
					farthest = i;
			if (d < nearDist[farthest]) {
				nearDist[farthest] = d;
				nearPlot[farthest] = p;
			}
		}
		Plot best = null;
		double bestYield = -1;
		for (Plot p : nearPlot) {
			if (p == null)
				continue;
			double y = p.yieldFactor(Sector.NECESSITY);
			if (y > bestYield) {
				bestYield = y;
				best = p;
			}
		}
		return best;
	}

	// the free plot maximizing the minimum distance to any other settlement's claimed
	// plots (min-distance auto-spacing); the centroid-nearest free plot if this is the
	// first settlement to claim in the province
	private Plot foundingCenter(Settlement owner) {
		boolean anyOther = false;
		for (Plot p : plots)
			if (p.owner() != null && p.owner() != owner) {
				anyOther = true;
				break;
			}
		if (!anyOther) {
			// the first settlement anchors its centre on the province's city — its urban core.
			// Both tiers use the same water-first logic (docs/settlement-tiers.md): for a Village
			// the single urban plot is already the water-dominant foundValue cell; for a City
			// (every plot urban) the most-watered urban plot is the centre. Fall back to the
			// centroid-nearest plot for a province with no urban core (non-LAND, or none generated).
			Plot city = bestUrbanCenter(centroidX, centroidY);
			return city != null ? city : bestYieldNearest(centroidX, centroidY);
		}

		Plot best = null;
		long bestSpacing = -1;
		for (Plot p : plots) {
			if (p.owner() != null)
				continue;
			long minDist = Long.MAX_VALUE;
			for (Plot q : plots)
				if (q.owner() != null && q.owner() != owner)
					minDist = Math.min(minDist, dist2(p, q.x(), q.y()));
			if (minDist > bestSpacing) {
				bestSpacing = minDist;
				best = p;
			}
		}
		return best;
	}

	private static long dist2(Plot p, int x, int y) {
		long dx = p.x() - x, dy = p.y() - y;
		return dx * dx + dy * dy;
	}

	// the free urban (city-core) plot best sited for a civic centre — the same water-first
	// criterion as a Village's foundValue centre (most adjacent water: the plot's sea edges,
	// whether it sits on a river, and its river-adjacent neighbours), tie-broken by proximity
	// to (cx, cy). So a City anchors its centre by the same logic as a Village; a province with
	// no water differs only by the tie-break (nearest the centroid), unchanged from before. Null
	// if the province has no free urban plot. See docs/settlement-tiers.md.
	private Plot bestUrbanCenter(int cx, int cy) {
		Plot best = null;
		int bestWater = -1;
		long bestD = Long.MAX_VALUE;
		for (Plot p : plots) {
			if (p.owner() != null || !p.urban())
				continue;
			int water = Integer.bitCount(p.coast()) + (p.river() ? 2 : 0)
					+ Integer.bitCount(p.riverAdj());
			long d = dist2(p, cx, cy);
			if (water > bestWater || (water == bestWater && d < bestD)) {
				bestWater = water;
				bestD = d;
				best = p;
			}
		}
		return best;
	}

	// --- caravan land-routing corridors (docs/land-routing.md Level 2) --------

	/**
	 * The <b>plot corridor</b> a caravan crosses through this province from its entry
	 * border to its exit border — an A* over the province's plots (4-neighbour raster
	 * adjacency, {@link PlotType#PEAK peaks} impassable), returning the plots crossed and
	 * their total move cost (see {@link PlotCorridor} / {@code docs/caravan-march.md} §6).
	 * The entry/exit anchors are the {@link com.civstudio.geo.WorldMap#portal border
	 * portals}; the corridor snaps each to the nearest workable plot. Cached per
	 * (entry-plot, exit-plot), so a province a route revisits pays the search once.
	 *
	 * @param entryX the entry border anchor's raster x
	 * @param entryY the entry border anchor's raster y
	 * @param exitX  the exit border anchor's raster x
	 * @param exitY  the exit border anchor's raster y
	 * @return the corridor, or {@link PlotCorridor#NONE} if no plot path exists
	 */
	public synchronized PlotCorridor corridor(int entryX, int entryY, int exitX, int exitY) {
		Plot start = nearestWorkable(entryX, entryY);
		Plot goal = nearestWorkable(exitX, exitY);
		if (start == null || goal == null)
			return PlotCorridor.NONE;
		long key = corridorKey(start, goal);
		PlotCorridor cached = corridorCache.get(key);
		if (cached != null)
			return cached;
		PlotCorridor result = search(start, goal);
		corridorCache.put(key, result);
		return result;
	}

	/**
	 * Drop the cached plot corridors. Call when a plot's {@link Plot#routeType() route} (mutable
	 * per-session state) changes — the Explorer laying a {@code ROUTE_TRAIL}, a road-builder later
	 * — since {@link #moveCost move cost} is route-aware and cached corridors would otherwise keep
	 * their stale, pre-route cost and path. Cheap: routes change rarely (a band pioneering a
	 * province once), so the province re-searches on the next {@link #corridor} request.
	 */
	public synchronized void invalidateCorridorCache() {
		corridorCache.clear();
	}

	// A* over the workable plots' 4-neighbour raster adjacency, from start to goal
	private PlotCorridor search(Plot start, Plot goal) {
		Map<Long, Plot> index = posIndex();
		Map<Plot, Double> g = new HashMap<>();
		Map<Plot, Plot> cameFrom = new HashMap<>();
		PriorityQueue<Plot> open = new PriorityQueue<>((a, b) -> Double.compare(
				g.getOrDefault(a, Double.MAX_VALUE) + heuristic(a, goal),
				g.getOrDefault(b, Double.MAX_VALUE) + heuristic(b, goal)));
		g.put(start, 0.0);
		open.add(start);
		while (!open.isEmpty()) {
			Plot cur = open.poll();
			if (cur == goal)
				return build(cameFrom, start, goal, g.get(goal));
			double gc = g.get(cur);
			for (Plot nb : neighbours(index, cur)) {
				double tentative = gc + moveCost(cur, nb);
				Double best = g.get(nb);
				if (best == null || tentative < best) {
					g.put(nb, tentative);
					cameFrom.put(nb, cur);
					open.add(nb);
				}
			}
		}
		return PlotCorridor.NONE; // disconnected (e.g. a peak barrier splits the province)
	}

	// reconstruct the corridor path (entry -> exit), carrying the accumulated cost and
	// counting the river plots on it (each a full-day ford for the march)
	private PlotCorridor build(Map<Plot, Plot> cameFrom, Plot start, Plot goal, double cost) {
		List<Plot> path = new ArrayList<>();
		for (Plot cur = goal; cur != start; cur = cameFrom.get(cur))
			path.add(cur);
		path.add(start);
		Collections.reverse(path);
		int rivers = 0;
		for (Plot p : path)
			if (p.river())
				rivers++;
		return new PlotCorridor(Collections.unmodifiableList(path), cost, rivers);
	}

	// the 4-neighbour workable plots of a plot, by raster adjacency
	private List<Plot> neighbours(Map<Long, Plot> index, Plot p) {
		List<Plot> out = new ArrayList<>(4);
		addNeighbour(out, index, p.x() + 1, p.y());
		addNeighbour(out, index, p.x() - 1, p.y());
		addNeighbour(out, index, p.x(), p.y() + 1);
		addNeighbour(out, index, p.x(), p.y() - 1);
		return out;
	}

	private static void addNeighbour(List<Plot> out, Map<Long, Plot> index, int x, int y) {
		Plot n = index.get(pack(x, y));
		if (n != null)
			out.add(n);
	}

	// the Civ4 movement cost to step onto a plot: a feature's own <iMovement> when it has
	// one (it replaces the terrain's, as in Civ4), else the terrain's <iMovement>, plus the
	// hill penalty (+1). Peaks are impassable and never enter the corridor graph. (A later
	// cut lowers it for a ROAD-improved plot, so corridors hug roads.)
	private static final int HILL_MOVE_PENALTY = 1;

	// --- elevation-aware movement (Tobler's hiking function) --------------------
	// The directional step cost onto a plot is its flat Civ4 cost scaled by a slope factor
	// derived from the real heightmap elevation gained/lost across the step, so a caravan's
	// plot corridor climbs slowly (and bends around high ground) and descends briskly — see
	// docs/caravan-march.md §6. Only the within-province plot corridor is elevation-aware;
	// the coarse province-graph boundary hop stays flat.

	// slope (rise/run) produced by a one-unit (0..255 heightmap) elevation difference between
	// two adjacent plots — the single calibration constant folding the heightmap's vertical
	// metres-per-unit and a plot's horizontal span into one tunable. The imported heightmap is
	// smooth at plot resolution: adjacent plots almost always differ by ≤5 units (median 0–1),
	// so the elevation cost is chiefly a *cumulative* charge along a corridor that climbs a
	// province's relief, not a per-step shock. Calibrated (empirically, against real relief
	// provinces) so crossing a hilly province costs ~15–30% more and the corridor visibly
	// follows the contours, while the rare sharp ridge (Δ≳10) saturates the cap below and is
	// routed around — the "reroute + meaningful cost" target. Flat ground is left untouched.
	private static final double SLOPE_PER_ELEVATION_UNIT = 0.06;

	// Tobler's hiking function: walking speed W = 6·exp(-3.5·|slope + 0.05|) km/h, peaking on
	// a gentle (−5%) downhill and falling away on steep grades either side. We charge cost as
	// the reciprocal speed relative to flat ground, so the slope factor is
	// exp(3.5·(|slope + 0.05| − 0.05)): 1.0 on the flat, <1 on a gentle downhill, >1 on any
	// steep grade — up, or a steep descent that brakes the marching column.
	private static final double TOBLER_K = 3.5;
	private static final double TOBLER_OFFSET = 0.05;

	// the slope factor's floor (the fastest, gentle-downhill grade — the natural minimum of
	// the unclamped factor) and a cap so one cliff cannot dominate the A* or a day's distance
	// budget (a near-impassable step, short of an outright impassable peak)
	private static final double SLOPE_FACTOR_MIN = Math.exp(-TOBLER_K * TOBLER_OFFSET); // ~0.84
	private static final double SLOPE_FACTOR_CAP = 8.0;

	// the flat Civ4 step cost onto a plot (elevation-independent): a feature's own <iMovement>
	// when it has one (it replaces the terrain's, as in Civ4), else the terrain's, plus the
	// hill penalty. The minimum is 1 (plains/grassland), so the cheapest possible step is
	// SLOPE_FACTOR_MIN — the lower bound the heuristic relies on.
	private static double flatCost(Plot p) {
		int feature = p.feature() == null ? 0 : p.feature().movement();
		double c = feature > 0 ? feature : p.terrain().movement();
		if (p.plotType() == PlotType.HILL)
			c += HILL_MOVE_PENALTY;
		return c;
	}

	// the directional cost to step from `from` onto `to`: the entered plot's flat cost — CAPPED
	// by any route on it — scaled by Tobler's slope factor for the elevation gained/lost. A route
	// overrides the flat TERRAIN + hill cost only (a road/trail negates the terrain type and the
	// hill penalty, Civ4-style; `min` so a route never slows an already-cheap plot); the
	// height-difference (slope) cost STILL applies on top, so a road up a steep grade is cheaper
	// than unroaded rough ground but dearer than the same road on the flat. Route state is
	// per-session (Plot.routeType) — cached corridors are dropped when a trail is laid (see
	// invalidateCorridorCache / docs/explorer-caravan.md §Phase 3).
	private static double moveCost(Plot from, Plot to) {
		RouteType route = to.routeType();
		double flat = route == null ? flatCost(to) : Math.min(flatCost(to), route.costFactor());
		return flat * slopeFactor(to.elevation() - from.elevation());
	}

	// Tobler's slope factor for a heightmap elevation delta (plot entered minus plot left)
	// between two adjacent plots, clamped to [SLOPE_FACTOR_MIN, SLOPE_FACTOR_CAP].
	private static double slopeFactor(int elevationDelta) {
		double slope = elevationDelta * SLOPE_PER_ELEVATION_UNIT;
		double f = Math.exp(TOBLER_K * (Math.abs(slope + TOBLER_OFFSET) - TOBLER_OFFSET));
		return Math.min(SLOPE_FACTOR_CAP, Math.max(SLOPE_FACTOR_MIN, f));
	}

	// straight-line (Euclidean) distance to the goal scaled by the cheapest possible step
	// cost (a flat-min plot on the fastest gentle downhill) — an admissible lower bound now
	// that a downhill step can cost below 1 (Tobler), so A* still returns least-cost corridors.
	// This stays admissible with TRAILS (costFactor 1.0 ≥ the flat min, so a trailed step never
	// falls below SLOPE_FACTOR_MIN); a future sub-1.0 road tier on a plot could cost below this
	// bound, so when road-building lands the lower bound must drop to the min route costFactor.
	private static double heuristic(Plot a, Plot goal) {
		double dx = a.x() - goal.x(), dy = a.y() - goal.y();
		return SLOPE_FACTOR_MIN * Math.sqrt(dx * dx + dy * dy);
	}

	// the workable plot nearest (x,y), the snap target for a border-portal anchor
	private Plot nearestWorkable(int x, int y) {
		Plot best = null;
		long bestD = Long.MAX_VALUE;
		for (Plot p : plots) {
			if (!p.isWorkable())
				continue;
			long d = dist2(p, x, y);
			if (d < bestD) {
				bestD = d;
				best = p;
			}
		}
		return best;
	}

	// the packed (x,y) -> workable-plot index, built once on first corridor request
	private Map<Long, Plot> posIndex() {
		if (posIndex == null) {
			Map<Long, Plot> idx = new HashMap<>(plots.size() * 2);
			for (Plot p : plots)
				if (p.isWorkable())
					idx.put(pack(p.x(), p.y()), p);
			posIndex = idx;
		}
		return posIndex;
	}

	// pack a raster (x,y) into 25 bits (x<<12 | y; y < 4096 covers the 2048-tall raster,
	// x < ~8192 the 5632-wide one) — so two packs compose into a collision-free long key
	private static long pack(int x, int y) {
		return ((long) x << 12) | (y & 0xFFF);
	}

	private static long corridorKey(Plot start, Plot goal) {
		return (pack(start.x(), start.y()) << 32) | pack(goal.x(), goal.y());
	}
}
