package com.civstudio.settlement;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.civstudio.geo.Bonus;
import com.civstudio.geo.Feature;
import com.civstudio.geo.Improvement;
import com.civstudio.geo.PlotGeo;
import com.civstudio.geo.PlotType;
import com.civstudio.geo.RouteType;
import com.civstudio.geo.Terrain;
import com.civstudio.good.ResourceType;
import com.civstudio.tech.Sector;

/**
 * One build <b>plot</b> in a {@link Settlement} — the occupiable unit of the
 * Civ4-style plot model that replaces the old disc {@code Slot}. A plot carries
 * its position on the travel-time ladder (its {@link #index()}), the {@link
 * Terrain} it sits on, its {@link PlotType} relief (flat/hill/peak), an optional
 * wild {@link Feature} overlay, the {@link Improvement} an on-plot firm has raised
 * on it, the {@link Building center buildings} standing on it (distinct from the tile
 * improvement — see below), and at most one {@link PlotOccupant} (a firm today; the
 * interface is the seam for housing and other buildings later). A plot is either <b>vacant</b>
 * ({@code occupant == null}) or taken by exactly one occupant; a {@link
 * PlotType#PEAK peak} is {@link #isWorkable() unworkable} and never seated.
 * <p>
 * As of Phase 3 a plot's land is the three Civ4 legs: its base {@code terrain}, an
 * optional {@code feature} (forest/jungle/…), and the {@code improvement} a firm
 * builds on it (an {@code NFirm} raises a {@code FARM}). Raising a farm <b>clears</b>
 * any feature ({@link #isCleared()}), so a developed farm's {@link #yields()} are
 * terrain + improvement (+ a food {@link #bonus() resource}'s food yield, if any); an
 * <b>uncleared, feature-bearing</b> plot is {@link
 * #isWild() wild} — the seam the future forage firm works (a {@code CAMP} reading
 * terrain + feature, no clearing). The terrain {@link #yieldFactor(Sector) yield
 * factor} is read into the on-plot firm's TFP (food only this cut — {@link
 * Sector#NECESSITY}). Occupancy and development move no money and consume no
 * randomness. See {@code docs/plots.md}.
 */
public final class Plot {

	/**
	 * Per-yield-index <b>reference</b> the raw Food/Production/Commerce yields are
	 * divided by to get a TFP <b>multiplier</b> (not a raw yield): chosen so a plot
	 * at the reference yield lands at factor 1.0, bounding the disturbance to the
	 * model's existing calibration. {@code food} is calibrated so the default
	 * (Dhenijansar) colony's aggregate food TFP stays near its pre-rework value — as
	 * of Phase 3 against the <b>developed farm</b> (terrain food + {@code FARM} +2),
	 * so the reference is Dhenijansar's expected terrain food (≈ 1.4) plus the farm's
	 * +2 (see {@code docs/plots.md} <i>Calibration</i>); production/commerce are
	 * placeholders — they are dormant this cut (only food is live; see {@link
	 * Settlement#plotYieldFactor}).
	 */
	private static final double[] YIELD_REFERENCE = { 3.4, 2.0, 2.0 };

	/**
	 * The floor on a plot's yield factor — a small &epsilon; so a zero-yield plot
	 * (e.g. a desert with 0 food) produces poorly but not at literally zero.
	 */
	private static final double YIELD_FLOOR = 0.1;

	// the plot's position on the travel-time ladder (0 = the first plot; the commute
	// cost T(index) is read by plotTravelTime). For a legacy/province-less colony the
	// plot's own intrinsic claim order; for a plot drawn from a shared province pool
	// it is the per-settlement claim rank, assigned by setIndex when claimed (-1 until).
	private int index;

	// the plot's real-world place name (a GeoNames town/feature stamped on at bake time by the
	// plot place-naming pass; see com.civstudio.geo.names), or null for a plot generated without
	// naming (no GeoNames dump present, or a runtime cache-miss regen). Persisted in the plot cache.
	private String placeName;

	// the plot's raster-derived scalars: its (x, y) position in the province silhouette and the
	// fields read off the Anbennar rasters — the packed river code, the heightmap elevation, and
	// the 8-bit sea mask. Grouped so a new raster attribute is one line in PlotGeo, not another
	// Plot constructor parameter; the positional/raster accessors below delegate to it. PlotGeo.NONE
	// for a province-less plot (position -1, no water/elevation). See PlotGeo / docs/plots.md.
	private final PlotGeo geo;

	// the resource on this plot (from the province field's bonus stage), or null. A
	// necessity-class (food) bonus adds its food yield in yields() — the live cut of the
	// bonus -> consumer-good connection (Bonus.resourceType()); enjoyment and strategic
	// bonuses stay dormant, as their sectors are gated off in Settlement.plotYieldFactor.
	private final Bonus bonus;

	// the settlement that has claimed this plot out of the shared province pool, or null
	// while the plot is free (province-owned). Hybrid ownership: claiming transfers the
	// plot to the settlement. Null for a legacy/province-less plot (no shared pool).
	private Settlement owner;

	// the ground this plot sits on (its base Food/Production/Commerce yield); the
	// baseline terrain for a province-less colony. Never null.
	private final Terrain terrain;

	// the plot's relief (flat/hill/peak), orthogonal to its terrain. A hill adds a
	// production bonus; a peak is unworkable. Never null (FLAT by default).
	private final PlotType plotType;

	// the wild feature overlaying the terrain (forest, jungle, …), or null if the
	// plot is bare. Fixed at generation; removed in effect once the plot is cleared
	// (the field is kept for the wild/cleared record — see isWild/isCleared).
	private final Feature feature;

	// the improvement a firm has raised on this plot (a FARM for a necessity firm),
	// or null until one is built — a durable land investment that survives the firm
	// that built it (a vacated developed plot keeps its improvement, so re-seating is
	// free). Set by raiseImprovement.
	private Improvement improvement;

	// whether the plot has been cleared for cultivation (its feature removed to raise
	// a farm). A wild plot is feature-bearing and not cleared; a forage CAMP is raised
	// without clearing, so cleared stays false there.
	private boolean cleared;

	// whether this plot is a settlement's built-up urban core (its city footprint). An
	// OVERLAY on the plot's natural terrain/relief, NOT a base terrain: the ground stays
	// whatever the generator drew (grassland/hill/…) and `urban` marks it built-up on top
	// (the old synthetic TERRAIN_URBAN ground was retired — urban is a property, not a
	// terrain). Stamped at generation on the city-core cells (ProvincePlotField), persisted
	// in the plot cache (ProvincePlotStore.StoredPlot), and read by the web district layer
	// and the caravan camp rule (a caravan may not camp on an urban plot of a province that
	// already holds a settlement; an abandoned urban plot is fair game). See docs/urban-plots.md.
	private boolean urban;

	// the occupant standing on this plot, or null if the plot is vacant
	private PlotOccupant occupant;

	// the route (trail/path/road/…) laid on this plot, or null if unimproved. Like the
	// occupant and buildings this is MUTABLE per-session state, NOT part of the plot's
	// generation-time field data — so it is excluded from the canonical .map
	// (ProvincePlotStore.StoredPlot serializes only terrain/relief/feature/bonus): trails
	// belong to a run, not the map (docs/explorer-caravan.md §Phase 3). The Explorer stamps
	// ROUTE_TRAIL as it pioneers; every other caravan will require ≥ a trail to route through.
	private RouteType routeType;

	// the center buildings standing on this plot — Civ4-style city buildings, distinct
	// from the single tile `improvement` leg above and from the `occupant` firm. Phase 1
	// tracks them but nothing populates the list and they never enter yields(), so the
	// data model lands byte-identical; the tech-gated auto-build trigger (which calls
	// addBuilding) and the building effect are later phases. See docs/plots.md.
	private final List<Building> buildings = new ArrayList<>();

	// the FIEF-HOLDER: the agent id of the household (a Noble, or the Ruler) that holds this plot as
	// its fief, or null when it is held by the Crown directly / unenfeoffed (docs/estate-system.md,
	// the vassalage P3). The households resident on a fief are that holder's vassals. Like occupant
	// and routeType this is MUTABLE per-session state, excluded from the canonical .map; and like
	// Building.ownerId it is a death-safe id — a null or dead holder simply reads as Crown-held.
	private Integer ownerId;

	/**
	 * Create a vacant, undeveloped plot at the given ladder index.
	 *
	 * @param index    the plot's position on the travel-time ladder
	 * @param terrain  the ground it sits on (non-null)
	 * @param plotType the relief (flat/hill/peak; non-null)
	 * @param feature  the wild feature overlaying it, or {@code null} if bare
	 */
	public Plot(int index, Terrain terrain, PlotType plotType, Feature feature) {
		this(index, PlotGeo.NONE, terrain, plotType, feature, null);
	}

	/**
	 * Create a vacant, undeveloped plot at a raster position in a province field, with its
	 * resource — a plot for the shared province pool. Its ladder {@link #index()} is unset
	 * ({@code -1}) until a settlement claims it (see {@link #setIndex(int)}).
	 *
	 * @param geo      the raster-derived scalars — position, river code, elevation, sea mask
	 * @param terrain  the ground it sits on (non-null)
	 * @param plotType the relief (flat/hill/peak; non-null)
	 * @param feature  the wild feature overlaying it, or {@code null} if bare
	 * @param bonus    the resource on it, or {@code null}
	 */
	public Plot(PlotGeo geo, Terrain terrain, PlotType plotType, Feature feature, Bonus bonus) {
		this(-1, geo, terrain, plotType, feature, bonus);
	}

	/**
	 * Create a vacant province-field plot with <b>no river</b> — the convenience overload
	 * for a plot on dry land (and for tests).
	 *
	 * @param x        the raster x of the plot in the province silhouette
	 * @param y        the raster y of the plot in the province silhouette
	 * @param terrain  the ground it sits on (non-null)
	 * @param plotType the relief (flat/hill/peak; non-null)
	 * @param feature  the wild feature overlaying it, or {@code null} if bare
	 * @param bonus    the resource on it, or {@code null}
	 */
	public Plot(int x, int y, Terrain terrain, PlotType plotType, Feature feature, Bonus bonus) {
		this(-1, new PlotGeo(x, y, 0, 0, 0, 0), terrain, plotType, feature, bonus);
	}

	private Plot(int index, PlotGeo geo, Terrain terrain, PlotType plotType, Feature feature, Bonus bonus) {
		if (terrain == null)
			throw new IllegalArgumentException("terrain must be non-null");
		if (plotType == null)
			throw new IllegalArgumentException("plotType must be non-null");
		this.index = index;
		this.geo = geo;
		this.terrain = terrain;
		this.plotType = plotType;
		this.feature = feature;
		this.bonus = bonus;
	}

	/** The plot's position on the travel-time ladder ({@code -1} until claimed, for a pool plot). */
	public int index() {
		return index;
	}

	/** Set the plot's ladder index — its claim rank, assigned when a settlement claims it. */
	public void setIndex(int index) {
		this.index = index;
	}

	/**
	 * The plot's real-world place name (a GeoNames town/feature), or {@code null} if the plot was
	 * generated without the naming pass. Stamped at bake time; persisted in the plot cache.
	 */
	public String placeName() {
		return placeName;
	}

	/** Set the plot's real-world place name (the bake-time place-naming pass). */
	public void setPlaceName(String placeName) {
		this.placeName = placeName;
	}

	/**
	 * Whether this plot is a settlement's built-up urban core — an overlay on its natural
	 * terrain/relief, not a base terrain (the old {@code TERRAIN_URBAN} ground was retired).
	 * Stamped at generation on the city-core cells; persisted in the plot cache.
	 */
	public boolean urban() {
		return urban;
	}

	/** Mark (or clear) this plot as a built-up urban core — see {@link #urban()}. */
	public void setUrban(boolean urban) {
		this.urban = urban;
	}

	/** The plot's {@link PlotGeo raster-derived scalars} (position, river code, elevation, sea mask). */
	public PlotGeo geo() {
		return geo;
	}

	/** The plot's raster x in the province silhouette, or {@code -1} if not from a province field. */
	public int x() {
		return geo.x();
	}

	/** The plot's raster y in the province silhouette, or {@code -1} if not from a province field. */
	public int y() {
		return geo.y();
	}

	/**
	 * The resource on this plot, or {@code null}. A necessity-class (food) bonus
	 * contributes its food yield to {@link #yields()}; enjoyment/strategic bonuses
	 * stay dormant (their sectors are gated off this cut).
	 */
	public Bonus bonus() {
		return bonus;
	}

	/** The settlement that has claimed this plot from the shared pool, or {@code null} if free. */
	public Settlement owner() {
		return owner;
	}

	/** Set (or clear, with {@code null}) the settlement owning this plot. Called by the province pool. */
	public void setOwner(Settlement owner) {
		this.owner = owner;
	}

	/** The ground this plot sits on. */
	public Terrain terrain() {
		return terrain;
	}

	/** The plot's relief (flat/hill/peak). */
	public PlotType plotType() {
		return plotType;
	}

	/** Whether a river runs through this plot (fording it costs a caravan a full day). */
	public boolean river() {
		return geo.river() != 0;
	}

	/**
	 * The packed river classification code on this plot, by decimal digit — {@code 0} = no river:
	 * <table><caption>river code digits</caption>
	 * <tr><td>{@code 1}</td><td>authored width level {@code 1..4} — {@link #riverWidth()}</td></tr>
	 * <tr><td>{@code 10}</td><td>downstream flow direction {@code 1..8} — {@link #flowDir()}</td></tr>
	 * <tr><td>{@code 100}</td><td>node marker ({@code 1} source, {@code 2} confluence, {@code 3} split) — {@link #riverNode()}</td></tr>
	 * <tr><td>{@code 1000}</td><td>river-adjacency mask {@code 0..15}, <b>two digits</b> — {@link #riverAdj()}</td></tr>
	 * <tr><td>{@code 100000}</td><td>render width class {@code 1..9} — {@link #riverClass()}</td></tr>
	 * </table>
	 * e.g. {@code 915384} = class 9, adjacency 15, a split, flowing SE, authored width 4. Note the
	 * adjacency field spans the thousands <em>and</em> ten-thousands digits (it reaches 15), which
	 * is why the class sits at {@code 100000} and why {@link #riverAdj()} demasks with {@code % 100}.
	 * Persisted for the web map (whose ribbon tapers by class and links across province seams via
	 * the adjacency mask) and, via {@code flowDir}, for river navigation; see
	 * {@link com.civstudio.geo.RiverFlow} and {@code docs/river-rendering.md} §1/§3/§4.
	 */
	public int riverCode() {
		return geo.river();
	}

	/**
	 * The <b>authored</b> river width level on this plot ({@code 0} = no river, {@code 1..4}
	 * narrow→wide), straight from the mod's {@code rivers.bmp} palette. Kept for future gameplay
	 * use; the renderer tapers by {@link #riverClass()} instead, which measures the real catchment.
	 */
	public int riverWidth() {
		return geo.river() % 10;
	}

	/**
	 * The <b>render width class</b> of this plot's river, {@code 1..9} narrow→wide ({@code 0} = no
	 * river): one class per octave of drainage accumulation, floored by the authored width. This —
	 * not {@link #riverWidth()} — is what makes a headwater read as a thread and a trunk as a
	 * highway, because the authored width is bimodal and coarse. See {@code docs/river-rendering.md} §4.
	 */
	public int riverClass() {
		return (geo.river() / 100000) % 10;
	}

	/**
	 * The downstream flow direction on this plot as an 8-neighbour code {@code 1..8} (E, NE,
	 * N, NW, W, SW, S, SE), or {@code 0} for no river or a local sink/mouth. Derived by
	 * {@link com.civstudio.geo.RiverFlow} — the seam for caravan river-navigation.
	 */
	public int flowDir() {
		return (geo.river() / 10) % 10;
	}

	/** The river node marker ({@code 0} plain/none, {@code 1} source, {@code 2} confluence, {@code 3} split). */
	public int riverNode() {
		return (geo.river() / 100) % 10;
	}

	/**
	 * The 4-bit river-adjacency mask on this plot: which orthogonal neighbours are also river
	 * cells ({@code 1}=E, {@code 2}=W, {@code 4}=S, {@code 8}=N; {@code 0} = no river neighbour).
	 * Computed globally so it names neighbours in adjacent provinces too — the web ribbon reads
	 * it to draw river links across province seams. See {@code docs/river-rendering.md} §1.
	 * <p>
	 * Demasked with {@code % 100}, not {@code % 16}: the mask reaches 15, so it occupies two
	 * decimal digits, and {@code % 16} would fold the class digit above it back in as garbage.
	 */
	public int riverAdj() {
		return (geo.river() / 1000) % 100;
	}

	/** The real heightmap elevation (0..255) at this plot; 0 for a province-less plot. */
	public int elevation() {
		return geo.elevation();
	}

	/**
	 * The 8-bit sea mask on this plot: which of the 8 neighbours border water. Low nibble =
	 * orthogonal edges ({@code 1}=E, {@code 2}=W, {@code 4}=S, {@code 8}=N); high nibble =
	 * diagonal corners ({@code 16}=NW, {@code 32}=NE, {@code 64}=SE, {@code 128}=SW), which
	 * index the Civ4 coastscalemask blend ({@code coast >> 4}). {@code 0} = inland. Persisted
	 * for the web coastline and the seam for coastal gameplay. See {@code docs/coastlines.md}.
	 */
	public int coast() {
		return geo.coast();
	}

	/** Whether this plot borders water on any edge (a coastal plot). */
	public boolean isCoastal() {
		return geo.coast() != 0;
	}

	/** Whether a firm can occupy this plot (false for a {@link PlotType#PEAK peak}). */
	public boolean isWorkable() {
		return plotType.isWorkable();
	}

	/** The wild feature overlaying the terrain, or {@code null} if the plot is bare. */
	public Feature feature() {
		return feature;
	}

	/** The improvement raised on this plot, or {@code null} if undeveloped. */
	public Improvement improvement() {
		return improvement;
	}

	/** Whether the plot has been cleared for cultivation (its feature removed). */
	public boolean isCleared() {
		return cleared;
	}

	/**
	 * Whether the plot is <b>wild</b>: it carries a feature and has not been cleared
	 * — the uncleared, feature-bearing land the future forage firm works (a {@code
	 * CAMP} gathering off it, no clearing). A bare plot or a cleared farm is not wild.
	 *
	 * @return {@code true} if the plot is uncleared and feature-bearing
	 */
	public boolean isWild() {
		return feature != null && !cleared;
	}

	/**
	 * The work to <b>clear</b> this plot's feature (the Civ4 feature-removal cost), or
	 * {@code 0} if the plot is bare or already cleared. Added to the build cost when a
	 * farm is raised on feature-bearing land.
	 *
	 * @return the feature-clearance work, or 0 if there is nothing to clear
	 */
	public double clearCost() {
		return isWild() ? feature.clearCost() : 0;
	}

	/**
	 * Raise an improvement on this plot, optionally <b>clearing</b> its feature first
	 * (a farm needs cleared land; a forage camp does not). Once developed the plot's
	 * {@link #yields()} include the improvement.
	 *
	 * @param improvement  the improvement built (a {@code FARM}, {@code CAMP}, …)
	 * @param clearFeature whether raising it clears the plot's feature
	 */
	public void raiseImprovement(Improvement improvement, boolean clearFeature) {
		this.improvement = improvement;
		if (clearFeature)
			this.cleared = true;
	}

	/**
	 * The plot's raw {@code [food, production, commerce]} yield triple: its terrain,
	 * plus the {@link PlotType#productionBonus() hill production bonus}, plus the
	 * feature's yield change while the plot is still {@link #isWild() wild} (a cleared
	 * plot's feature is gone), plus the {@link #improvement() improvement}'s yield
	 * change once one is built, plus a {@link #bonus() resource}'s food yield when it
	 * is a necessity-class (food) bonus. (The hill production bonus and non-food
	 * bonuses are dormant until a production/commerce firm sits on a plot — only food
	 * is live this cut.)
	 *
	 * @return the plot's yields (a fresh length-3 array)
	 */
	public int[] yields() {
		int[] out = terrain.yields().clone();
		out[1] += plotType.productionBonus();
		if (isWild())
			for (int i = 0; i < 3; i++)
				out[i] += feature.yieldChange(i);
		if (improvement != null)
			for (int i = 0; i < 3; i++)
				out[i] += improvement.yieldChange(i);
		// a food (necessity-class) bonus adds its food yield — the live cut of the
		// bonus -> consumer-good connection (BonusClass.resourceType()), so a necessity
		// firm on wheat/cattle/fish land is the more productive for it. Enjoyment and
		// strategic bonuses stay dormant, as their sectors are in plotYieldFactor.
		if (bonus != null && bonus.resourceType() == ResourceType.NECESSITY)
			out[0] += bonus.yieldChange(0);
		return out;
	}

	/**
	 * The plot's <b>TFP multiplier</b> for a sector — its raw yield in that sector's
	 * Civ4 yield channel (Food for {@link Sector#NECESSITY}, Production for {@link
	 * Sector#CAPITAL}, Commerce for {@link Sector#EXPORT}/{@link Sector#ENJOYMENT})
	 * divided by the per-index {@link #YIELD_REFERENCE reference}, floored at {@link
	 * #YIELD_FLOOR}. A plot at the reference yield gives factor 1.0. The staging of
	 * which sectors are live (only food this cut) is applied by the caller — see
	 * {@link Settlement#plotYieldFactor}.
	 *
	 * @param sector the firm's sector
	 * @return the plot's yield factor for that sector
	 */
	public double yieldFactor(Sector sector) {
		int idx = yieldIndex(sector);
		double factor = yields()[idx] / YIELD_REFERENCE[idx];
		// cold ground farms poorly (frost, a short growing season) — scale down FOOD only, so a
		// tundra/glacier colony is food-scarce however it improves the land (the +2 farm bonus no
		// longer papers over the arctic). Production/commerce are unaffected: the cold can still mine.
		if (sector == Sector.NECESSITY)
			factor *= coldFoodPenalty(terrain.type());
		return Math.max(YIELD_FLOOR, factor);
	}

	// the food multiplier for a cold terrain — 1.0 for temperate ground, dropping toward the poles
	// so arctic colonies genuinely struggle to feed themselves (see docs; pairs with LatitudeClimate)
	private static double coldFoodPenalty(String terrainType) {
		return switch (terrainType) {
			case "TERRAIN_GLACIER" -> 0.12;      // ~unfarmable ice
			case "TERRAIN_PERMAFROST" -> 0.30;
			case "TERRAIN_TUNDRA" -> 0.45;
			case "TERRAIN_TAIGA" -> 0.70;        // boreal — some food
			default -> 1.0;
		};
	}

	// the Civ4 yield channel (0 = food, 1 = production, 2 = commerce) a sector reads
	private static int yieldIndex(Sector sector) {
		return switch (sector) {
			case NECESSITY -> 0;
			case CAPITAL -> 1;
			case EXPORT, ENJOYMENT -> 2;
		};
	}

	/** Whether the plot is unoccupied. */
	public boolean isVacant() {
		return occupant == null;
	}

	/** The occupant on this plot, or {@code null} if it is vacant. */
	public PlotOccupant getOccupant() {
		return occupant;
	}

	/**
	 * The {@link RouteType route} laid on this plot (trail/path/road/…), or {@code null} if
	 * the plot is unimproved. <b>Per-session mutable state</b> — like the {@link
	 * #getOccupant() occupant} and {@link #buildings()}, and unlike the terrain/feature/bonus
	 * field it is <b>not</b> baked into the canonical {@code .map} (trails belong to a
	 * run, not the map). The Explorer stamps {@code ROUTE_TRAIL} as it pioneers; other bands
	 * will require at least a trail to route through. See {@code docs/explorer-caravan.md}.
	 *
	 * @return the plot's route, or {@code null} if unimproved
	 */
	public RouteType routeType() {
		return routeType;
	}

	/**
	 * Lay (or upgrade to) a {@link RouteType route} on this plot — the Explorer stamps {@code
	 * ROUTE_TRAIL} as it pioneers, and a road-builder lays better tiers later. A durable
	 * per-session land mark: once trailed, a plot is "explored" and other caravans may route
	 * through it. Callers that only pioneer bare ground guard on {@link #routeType()} being
	 * {@code null} so a better existing route is never downgraded.
	 *
	 * @param routeType the route to lay (non-null)
	 */
	public void layRoute(RouteType routeType) {
		if (routeType == null)
			throw new IllegalArgumentException("routeType must be non-null");
		this.routeType = routeType;
	}

	/**
	 * Place <tt>occupant</tt> on this plot.
	 *
	 * @param occupant
	 *            the occupant to place (non-null)
	 * @throws IllegalStateException
	 *             if the plot is already occupied
	 */
	public synchronized void occupy(PlotOccupant occupant) {
		if (occupant == null)
			throw new IllegalArgumentException("occupant must be non-null");
		if (this.occupant != null)
			throw new IllegalStateException(
					"plot already occupied by " + this.occupant);
		this.occupant = occupant;
	}

	/**
	 * Atomically place <tt>occupant</tt> if the plot is vacant — the thread-safe
	 * check-then-act for transient claims that bypass the pool's synchronized claim
	 * path (a caravan's nightly camp). Two bands camping in the same province the
	 * same night thus cannot double-occupy a plot; the loser simply tries the next.
	 *
	 * @param occupant
	 *            the occupant to place (non-null)
	 * @return whether the plot was vacant and is now occupied by {@code occupant}
	 */
	public synchronized boolean tryOccupy(PlotOccupant occupant) {
		if (occupant == null)
			throw new IllegalArgumentException("occupant must be non-null");
		if (this.occupant != null)
			return false;
		this.occupant = occupant;
		return true;
	}

	/** Free the plot, removing any occupant. */
	public synchronized void vacate() {
		occupant = null;
	}

	/**
	 * The {@link Building center buildings} standing on this plot — an unmodifiable live
	 * view. Distinct from the single tile {@link #improvement()} leg: buildings are
	 * Civ4-style city buildings with no {@link #yields()} footprint (their effect is
	 * deferred — see {@code docs/plots.md}). Empty until {@link #addBuilding} places one;
	 * in this phase nothing does.
	 *
	 * @return the buildings on this plot (possibly empty, never {@code null})
	 */
	public List<Building> buildings() {
		return Collections.unmodifiableList(buildings);
	}

	/**
	 * Whether a building with the given eos-native id stands on this plot.
	 *
	 * @param id the building id
	 * @return {@code true} if such a building is present
	 */
	public boolean hasBuilding(String id) {
		for (Building b : buildings)
			if (b.id().equals(id))
				return true;
		return false;
	}

	/**
	 * Whether a <b>regular building</b> stands on this plot — a firm {@link #getOccupant()
	 * occupant} or any non-housing {@link Building}. This is the "developed ground" signal
	 * (user ruling 2026-07-24): a plot with a regular building is <b>not farmable</b> and
	 * hosts stacked housing; a plot with only the households' own huts ({@link
	 * Building#isHousing() housing}) — or nothing — is empty ground a single household farms.
	 * Housing is deliberately excluded: a farmstead has a farmhouse and still farms its land.
	 *
	 * @return whether developed by a firm or a non-housing building
	 */
	/**
	 * The <b>fief-holder</b> of this plot — the agent id of the household (a {@link
	 * com.civstudio.agent.noble.Noble} or the {@link com.civstudio.agent.ruler.Ruler}) that holds
	 * it as a fief, or {@code null} when it is held by the Crown directly (docs/estate-system.md,
	 * vassalage P3). The households resident here are that holder's vassals.
	 *
	 * @return the fief-holder's agent id, or {@code null} if Crown-held
	 */
	public Integer ownerId() {
		return ownerId;
	}

	/**
	 * Enfeoff this plot to a holder (or clear it back to the Crown with {@code null}) — the
	 * grant / ennoblement seam ({@code docs/estate-system.md}).
	 *
	 * @param ownerId the fief-holder's agent id, or {@code null} to hold it as Crown demesne
	 */
	public void setOwnerId(Integer ownerId) {
		this.ownerId = ownerId;
	}

	public boolean hasRegularBuilding() {
		if (occupant != null)
			return true;
		for (Building b : buildings)
			if (!b.isHousing())
				return true;
		return false;
	}

	/**
	 * Add a center building to this plot. The tech-gated auto-build trigger (a later
	 * phase) calls this once a building's prerequisite is met; nothing does yet, so the
	 * collection stays empty in this phase and the data model is byte-identical.
	 *
	 * @param building the building to place (non-null)
	 */
	public void addBuilding(Building building) {
		if (building == null)
			throw new IllegalArgumentException("building must be non-null");
		buildings.add(building);
	}

	/**
	 * Remove a center building from this plot — the housing-upgrade seam: a household that
	 * climbs to a better rung retires the house it replaces (docs/build-queue-plan.md B5).
	 * A no-op if the building is not on this plot.
	 *
	 * @param building the building to remove
	 */
	public void removeBuilding(Building building) {
		buildings.remove(building);
	}
}
