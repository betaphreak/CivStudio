package com.civstudio.geo;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.civstudio.util.Rng;

/**
 * The plot field of one province: its real land pixels as plots, generated from
 * the province's {@link ProvinceMask silhouette} and climate. Each land cell of
 * the mask becomes one {@link ProvincePlot} (1 raster pixel = 1 plot), carrying
 * its raster position, river flag, terrain, and relief. Generated lazily — the
 * first time a province is needed — and shared by all the settlements that found
 * into the province (which claim plots from it; ownership/claiming land in a later
 * phase). See {@code docs/province-plots.md}.
 * <p>
 * <b>This phase</b> assembles four stages: the relief ({@link PlotType}
 * flat/hill/peak) from the C2C-ported {@link ReliefGenerator} (spatially clustered
 * ranges), roughened by the real {@code terrain.bmp} mountain palette ({@link
 * MapTerrainCodec#relief}); the ground {@link Terrain} from the C2C temperature×humidity
 * bands ({@link ClimateTerrainGenerator}), grown in world-space patches off the continuous
 * {@link WorldClimate} field; the wild {@link Feature}
 * from the C2C-ported {@link FeatureGenerator} (the {@code addFeatures} seed-and-spread
 * — per-cell weighted jungle/forest/swamp with peak-seeding and the jungle→forest cold
 * substitution), plus river <b>flood plains</b> and the generic <b>appearance-probability
 * scatter</b> ({@link #featureFor}); and the {@link Bonus} resource from {@link
 * BonusGenerator} (placed by each bonus's own terrain/feature/relief/latitude
 * constraints). The C2C stage's <b>terrain rewriting</b> (jungle greening desert, …) is
 * deliberately not applied (see {@code docs/c2c-generator-port.md} §2, "feature
 * consequences only").
 * <p>
 * <b>Generation is seamless across province borders</b>, which it was not before
 * {@code MAP_VERSION} 11. The mask carries a {@linkplain ProvinceMask#isGround halo} of the
 * neighbouring provinces' land, so every stage runs over real context instead of reading a
 * border as ocean; the ground is a <b>pure function of world position</b>
 * ({@link #worldGround}) drawn from a <b>continuous</b> climate field, so it neither restarts
 * at a border nor depends on which province asks. Only {@link ProvinceMask#isLand} cells are
 * emitted as plots. See {@code docs/plot-generator.md} §Seamless generation.
 */
public final class ProvincePlotField {

	/**
	 * One generated plot: its {@link PlotGeo raster-derived scalars} (position, river, elevation,
	 * sea mask) plus its terrain, relief, wild feature and resource. The positional/raster
	 * accessors delegate to {@link #geo()} — see {@link PlotGeo} for why they are grouped.
	 *
	 * @param geo      the raster-derived scalars (position, river code, elevation, sea mask)
	 * @param terrain  the ground (from the climate pool)
	 * @param plotType the relief (flat/hill/peak; from {@link ReliefGenerator})
	 * @param feature  the wild feature, or {@code null}
	 * @param bonus    the resource on this plot, or {@code null}
	 * @param urban    whether the plot is a settlement's built-up urban core (an overlay on the
	 *                 natural terrain/relief, not a base terrain — the retired {@code TERRAIN_URBAN})
	 */
	public record ProvincePlot(PlotGeo geo, Terrain terrain, PlotType plotType, Feature feature, Bonus bonus,
			boolean urban) {

		/** Absolute raster x. */
		public int x() {
			return geo.x();
		}

		/** Absolute raster y. */
		public int y() {
			return geo.y();
		}

		/** The packed river code (0 = none; see {@link ProvinceRaster#classifyRiver}). */
		public int riverCode() {
			return geo.river();
		}

		/** The real heightmap elevation (0..255). */
		public int elevation() {
			return geo.elevation();
		}

		/** The 8-bit sea mask (edges + corners; see {@code docs/coastlines.md}). */
		public int coast() {
			return geo.coast();
		}

		/** Whether a river runs through this plot (any non-zero {@link #riverCode()}). */
		public boolean river() {
			return geo.river() != 0;
		}
	}

	/**
	 * Per-cell chance a terrain-implied feature is placed on an otherwise-bare cell —
	 * a wetland is its biome so it places densely ({@link #SWAMP_CHANCE}), while a
	 * desert/savanna feature places sparsely ({@link #SPARSE_CHANCE}) so the ground
	 * reads as a mix of bare and featured rather than a uniform blanket.
	 */
	// UNDERGROUND province types → the fixed cavern pool their plots generate from (no climate below
	// ground). All four flatten relief to a walkable floor. See docs/underworld.md.
	private static final Map<ProvinceType, Map<String, Double>> SPECIAL_POOL = Map.of(
			ProvinceType.CAVERN, cavernPool(),
			ProvinceType.DWARVEN_HOLD, cavernPool(),
			ProvinceType.DWARVEN_HOLD_SURFACE, cavernPool(),
			ProvinceType.DWARVEN_ROAD, cavernPool());

	// SURFACE special-terrain province types → their SIGNATURE terrain, which dominates the province
	// (SPECIAL_SIGNATURE_FRAC of plots); the remaining plots are climate-aware FILLER drawn from the
	// province's climate generator (a northern ancient forest gets taiga/marsh filler, not a fixed
	// grassland). Relief and trees are kept (unlike the underground floor). See docs/plot-generator.md.
	private static final Map<ProvinceType, String> SPECIAL_SIGNATURE = Map.of(
			ProvinceType.ANCIENT_FOREST, "TERRAIN_ANCIENT_FOREST",
			ProvinceType.GLADEWAY, "TERRAIN_GLADEWAY",
			ProvinceType.FEY_GLADEWAY, "TERRAIN_FEY_GLADEWAY",
			ProvinceType.BLOODGROVES, "TERRAIN_BLOODGROVES",
			ProvinceType.MUSHROOM_FOREST, "TERRAIN_MUSHROOM_FOREST",
			ProvinceType.SHADOW_SWAMP, "TERRAIN_SHADOW_SWAMP",
			ProvinceType.GLACIER, "TERRAIN_GLACIER");
	private static final double SPECIAL_SIGNATURE_FRAC = 0.82; // signature share; the rest is climate filler

	private static Map<String, Double> cavernPool() {
		return Map.of("TERRAIN_CAVERN", 8.0, "TERRAIN_ROCKY", 1.0);
	}

	// special surface terrains whose signature feature the trees.bmp density signal misses (they
	// are terrain-override provinces, not painted wooded/marshy): the forests carry FEATURE_FOREST,
	// the shadow swamp FEATURE_SWAMP, over most of their plots (see SPECIAL_FEATURE_COVER).
	private static final Map<ProvinceType, String> SPECIAL_FEATURE = Map.of(
			ProvinceType.ANCIENT_FOREST, "FEATURE_FOREST",
			ProvinceType.GLADEWAY, "FEATURE_FOREST",
			ProvinceType.FEY_GLADEWAY, "FEATURE_FOREST",
			ProvinceType.BLOODGROVES, "FEATURE_FOREST",
			ProvinceType.SHADOW_SWAMP, "FEATURE_SWAMP");
	// fraction of a special-terrain province's (non-peak) plots that carry its signature feature
	private static final double SPECIAL_FEATURE_COVER = 0.90;

	private static final double SWAMP_CHANCE = 0.85;
	private static final double SPARSE_CHANCE = 0.35;

	/**
	 * How far (Chebyshev pixels) from dry land the Civ4 <b>sea bonuses</b> are placed — fish, crab,
	 * whale, pearls are coastal, and scattering them across open ocean would litter the deep with
	 * resource icons no one can reach. {@code 1} = COAST (touching land), {@code 2..3} = near-shore
	 * SEA. See {@code docs/coastlines.md}.
	 * <p>
	 * This used to bound plot GENERATION as well, and that is exactly what produced the coastline
	 * staircase: a sea province's plots stopped at an arbitrary three-ring band, and its outer
	 * boundary — where plot-rendered water met the screen-space sea gradient — stepped with every
	 * plot square. Softening that edge cannot work, because the band itself is the artefact. A sea
	 * province now generates a plot for <b>every</b> water cell it owns, so water is continuous and
	 * there is no boundary left to step. See {@code docs/civ4-texture-inventory.md} §4 P3.
	 */
	private static final int BONUS_SHELF_MAX = 3;

	/**
	 * The climate-field temperature (°C, C2C scale) at or below which water reads <b>polar</b> — the
	 * sea terrain bands to its polar variant and the ice cap starts. Keyed on temperature, not on
	 * {@code |lat| >= 66}: the EU4 projection puts temperate Cannor at |lat| 60–75, so the latitude
	 * form iced its seas. See {@link WorldClimate} and {@code docs/plot-generator.md} §Temperature.
	 */
	static final double POLAR_TEMPERATURE = -2.0;

	private final Province province;
	private final List<ProvincePlot> plots;
	private final List<EdgeCell> edge;

	/**
	 * One cell of the <b>neighbour ring</b>: a cell just outside this province that the halo already
	 * grounded, carried so a client can blend the province's border correctly on its FIRST bake.
	 * <p>
	 * It is deliberately NOT a {@link ProvincePlot}: it is not this province's land, nothing may
	 * settle or farm it, and it must never reach the sim. All a terrain blend needs of a neighbour is
	 * which terrain owns the corner, so that is all this carries — position and the terrain key, with
	 * relief folded in only because {@code PEAK} outranks every terrain in the corner-ownership rule.
	 *
	 * @param x        world raster x
	 * @param y        world raster y
	 * @param terrain  the neighbouring cell's ground
	 * @param plotType its relief — only {@code PEAK} matters to the blend, the rest is context
	 */
	public record EdgeCell(int x, int y, Terrain terrain, PlotType plotType) {
	}

	private ProvincePlotField(Province province, List<ProvincePlot> plots, List<EdgeCell> edge) {
		this.province = province;
		this.plots = plots;
		this.edge = edge;
	}

	/**
	 * Generate a province's plot field deterministically off the terrain {@code rng}. Relief is
	 * generated first (consuming the stream for its clustering), then the ground — which consumes
	 * <b>no</b> rng at all, being a pure function of world position — then features and resources in
	 * row-major order, so the same {@code (rng seed, province)} yields the same field.
	 *
	 * @param province the province to build a field for
	 * @param registry the curated terrain/feature definitions
	 * @param raster   the raster reader (supplies the province mask)
	 * @param rng      the dedicated terrain stream (salted apart from the economy)
	 * @return the province's plot field
	 */
	public static ProvincePlotField generate(Province province, TerrainRegistry registry,
			ProvinceRaster raster, Rng rng) throws IOException {
		// sea/lake provinces grow a coastal-shelf water field instead of the land field; every
		// other type (LAND, and IMPASSABLE wasteland) goes through the land path below
		if (province.type() == ProvinceType.SEA || province.type() == ProvinceType.LAKE)
			return generateWater(province, registry, raster, rng);
		ProvinceMask mask = raster.mask(province.id());
		WorldClimate world = WorldClimate.of(raster);
		int w = mask.width(), h = mask.height();
		PlotType[] relief = ReliefGenerator.generate(mask, ReliefGenerator.Params.forProvince(province), rng);
		ClimateProfile climate = ClimateProfile.of(province);

		// Ground every GROUND cell — this province's land plus the halo of neighbouring land the mask
		// carries — procedurally with the C2C temperature×humidity terrain generator
		// (docs/plot-generator.md). This is the PRIMARY terrain source, replacing the terrain.bmp biome,
		// so all 33 terrains appear climate-appropriately. Grounding first lets the feature stage read the
		// whole terrain+relief grid (it seeds off peaks, chooses per-cell by terrain category). Relief
		// stays HYBRID: the C2C ReliefGenerator ranges roughened with the map's real mountain palette
		// (MapTerrainCodec.relief still read for peak/hill only, not biome), so real ranges survive while
		// the ground is climate-driven.
		//
		// SEAMLESS (v11): the ground is now a pure function of WORLD position — a lattice of patches
		// hashed off absolute raster coordinates, each patch's terrain drawn from the CONTINUOUS
		// WorldClimate field sampled at the patch's own position (docs/plot-generator.md §Seamless
		// generation). It consumes no rng and does not depend on which province is being generated, so
		// two provinces agree exactly on their shared border and the lazy per-province path produces
		// byte-identical ground to a single global pass.
		ClimateTerrainGenerator.Cache pools = new ClimateTerrainGenerator.Cache(registry);
		Terrain[] ground = new Terrain[w * h];
		PlotType[] composed = new PlotType[w * h];
		// relief per-plot from the heightmap (already spatially coherent — the elevation field is smooth)
		for (int ly = 0; ly < h; ly++)
			for (int lx = 0; lx < w; lx++) {
				if (!mask.isGround(lx, ly))
					continue;
				int idx = ly * w + lx;
				composed[idx] = rougher(relief[idx], MapTerrainCodec.relief(mask.terrainIndex(lx, ly)));
			}
		worldGround(ground, mask, w, h, world, pools);

		// this province's OWN cells (row-major) — the emission set, and the only cells the
		// membership-driven overrides below touch. The surrounding halo keeps its world ground so
		// the de-speckle and vegetation stages read real neighbouring land, not a wasteland smear.
		List<int[]> cells = new ArrayList<>(mask.landCount());
		for (int ly = 0; ly < h; ly++)
			for (int lx = 0; lx < w; lx++)
				if (mask.isLand(lx, ly))
					cells.add(new int[] { lx, ly });

		// the province-level generator the membership-driven overrides draw from (barren wasteland,
		// cavern pool, special-terrain filler) — a province TYPE, not its climate, drives those, and
		// their borders are meant to be sharp, so they stay a per-province draw off the terrain stream
		double provinceTemp = world.temperature(mask.originX() + w / 2.0, mask.originY() + h / 2.0);
		ClimateTerrainGenerator terrainGen = province.type() == ProvinceType.IMPASSABLE
				? ClimateTerrainGenerator.barren(registry, provinceTemp)                     // wasteland → barren ground
				: new ClimateTerrainGenerator(registry, provinceTemp, climate.humidity());
		if (province.type() == ProvinceType.IMPASSABLE)
			for (int[] c : cells)
				ground[c[1] * w + c[0]] = terrainGen.next(rng);   // barren waste, not the climate mix

		// Special-terrain provinces override the climate ground (membership, not the climate, drives it).
		// Done before the feature/bonus stages so those read the real ground. UNDERGROUND types (cavern/
		// dwarven) draw the fixed cavern pool and flatten relief to a floor. SURFACE special terrains keep
		// their relief and trees, drawing their SIGNATURE terrain for most plots with the rest as climate-
		// aware filler (docs/plot-generator.md + docs/underworld.md).
		Map<String, Double> cavern = SPECIAL_POOL.get(province.type());
		if (cavern != null) {                                          // underground
			TerrainGenerator cavernGen = new TerrainGenerator(registry, cavern);
			for (int[] c : cells) {
				int idx = c[1] * w + c[0];
				ground[idx] = cavernGen.next(rng);
				composed[idx] = PlotType.FLAT;
			}
		}
		String signatureKey = SPECIAL_SIGNATURE.get(province.type());
		if (signatureKey != null) {                                    // surface special terrain
			Terrain signature = registry.terrain(signatureKey);
			for (int[] c : cells)                                      // signature-dominant, climate-aware filler
				ground[c[1] * w + c[0]] = rng.uniform() < SPECIAL_SIGNATURE_FRAC ? signature : terrainGen.next(rng);
		}

		// De-speckle the ground into coherent regions. Terrain is sampled 1 raster pixel = 1 plot, so the
		// patch edges and the special-pool passes above leave stray single cells, which read as a hard
		// grid at the deepest city-builder zoom no matter how the web blends plot edges. A few passes of
		// majority (mode) smoothing coalesce the speckle into natural patches while keeping each terrain's
		// overall share. It runs over the whole GROUND grid (halo included), so a cell on the province
		// border is smoothed against its real neighbours instead of against nothing. Reads a per-pass
		// snapshot (order-independent) and consumes NO rng, so the terrain draws above are untouched.
		despeckle(ground, w, h);

		// the C2C-ported feature seed-and-spread: the per-cell vegetation intent
		// (jungle/forest/swamp or bare), which this loop validity-gates below. Temperature, humidity
		// and vegetation density are sampled per cell off the continuous field, and the stage runs
		// over the halo too, so vegetation carries across a province seam.
		Feature[] vegetation = FeatureGenerator.generate(mask, ground, composed,
				world, 0.2 + 0.8 * climate.humidity(), registry, rng);
		Feature floodPlains = registry.feature("FEATURE_FLOOD_PLAINS");
		List<Bonus> bonuses = registry.bonuses();

		// resolve the wild feature of every land cell into a grid, in priority: flood
		// plains on a valid flat riverside plot; else the C2C vegetation pick
		// (validity-gated, with the real tree-class fallback for an invalid host); else a
		// sparse terrain-implied feature (swamp/cactus/…) or the appearance scatter. Every
		// choice is validity-gated (see featureFor). A grid (not the final plot) so the
		// oasis pass can score a cell's neighbours before the bonuses read the feature.
		Feature[] feature = new Feature[w * h];
		for (int[] c : cells) {
			int lx = c[0], ly = c[1], idx = ly * w + lx;
			feature[idx] = featureFor(ground[idx], composed[idx], mask.riverCode(lx, ly) != 0,
					vegetation[idx], mask.treeIndex(lx, ly), mask.terrainIndex(lx, ly),
					climate, floodPlains, registry, rng);
		}
		// special forest/swamp terrains: the C2C stage above leaves them bare (no trees.bmp
		// coverage), so stamp their signature feature over ~90% of non-peak plots. See
		// docs/underworld.md.
		String specialFeatureKey = SPECIAL_FEATURE.get(province.type());
		if (specialFeatureKey != null) {
			Feature specialFeature = registry.feature(specialFeatureKey);
			for (int ly = 0; ly < h; ly++)
				for (int lx = 0; lx < w; lx++) {
					if (!mask.isLand(lx, ly))
						continue;
					int idx = ly * w + lx;
					feature[idx] = composed[idx] != PlotType.PEAK
							&& rng.uniform() < SPECIAL_FEATURE_COVER ? specialFeature : null;
				}
		}
		// C2C oasis scoring (slice 5, addFeatures L3076–3135): scatters oases across the
		// best inland-desert cells, scored by their surroundings — a feature-only pass,
		// so it never rewrites the real ground
		placeOases(mask, ground, composed, feature, registry.feature("FEATURE_OASIS"), rng);
		// C2C bonus placement (slice 8): a per-province pass, resources laid in placement
		// order at target densities with group spacing (see BonusGenerator)
		// Wastelands (IMPASSABLE) carry no resources — barren ground is worked by no one.
		Bonus[] bonusGrid = province.type() == ProvinceType.IMPASSABLE
				? new Bonus[w * h]
				: BonusGenerator.place(w, h, cells, ground, composed, feature,
						province.latitude(), bonuses, rng, false);

		// the urban core: site the province's city on its best Civ4 foundValue cell(s) — as
		// close as possible to as many bonuses as fit in a city work radius — and flag them
		// built-up. Urban is a PURE OVERLAY, not a base terrain and not a yield edit
		// (docs/city-of-hamlets-plan.md §8): the plot keeps its FULL natural yield stack — terrain,
		// relief, feature, and bonus — exactly like every other plot (the synthetic TERRAIN_URBAN
		// ground was retired long ago; the gen-time flatten/feature-strip/bonus-strip is retired
		// here). We only mark `urban` (for the web district layer, the caravan camp rule, and the
		// hamlet food model — a city on rich land feeds itself from its own fields), and apply ONE
		// workability guard: an unworkable PEAK is clamped to a HILL so the whole footprint can be
		// built and farmed. Whether a given plot actually farms is a runtime fact
		// (Plot.hasRegularBuilding), not stamped here. Runs after the bonus stage so the core score
		// reads the final resource layout; consumes no rng. One plot for an ordinary province, a
		// denser core for a city_terrain province. See docs/urban-plots.md. Only plain LAND provinces
		// get a surface city: underground holds are their own cave-cities (DWARVEN_HOLD) and the
		// special surface terrains keep their character; every city_terrain province is LAND, so all
		// get a core.
		boolean[] urban = new boolean[w * h];
		if (province.type() == ProvinceType.LAND && !cells.isEmpty()) {
			if (province.city()) {
				// a city_terrain province is one sprawling city — flag EVERY plot urban (the city
				// render layer covers it); the ground keeps its full natural yields beneath.
				for (int[] c : cells) {
					int idx = c[1] * w + c[0];
					urban[idx] = true;
					if (composed[idx] == PlotType.PEAK)
						composed[idx] = PlotType.HILL; // keep the footprint workable/buildable
				}
			} else {
				int coreSize = CityPlacement.coreSize(province, cells.size());
				for (int idx : CityPlacement.coreCells(w, h, cells, ground, composed, feature,
						bonusGrid, mask, coreSize)) {
					urban[idx] = true;                  // built-up overlay; the plot stays fully natural
					if (composed[idx] == PlotType.PEAK) // (CityPlacement already avoids peak cores, so
						composed[idx] = PlotType.HILL;  // this guard is belt-and-braces here)
				}
			}
		}

		List<ProvincePlot> out = new ArrayList<>(mask.landCount());
		for (int ly = 0; ly < h; ly++) {
			for (int lx = 0; lx < w; lx++) {
				if (!mask.isLand(lx, ly))
					continue;
				int idx = ly * w + lx;
				Terrain terrain = ground[idx];
				PlotType plotType = composed[idx];
				int riverCode = mask.riverCode(lx, ly);
				Bonus bonus = bonusGrid[idx];
				// elevation is a pure heightmap lookup (no rng), so adding it leaves the
				// terrain/relief/feature/bonus draws — and thus the field — otherwise identical
				int elevation = mask.elevation(lx, ly);
				int coast = mask.coast(lx, ly);
				// landDist is 0 on dry land by definition — the shelf ramp it feeds is water-only
				PlotGeo geo = new PlotGeo(mask.originX() + lx, mask.originY() + ly, riverCode, elevation, coast, 0);
				out.add(new ProvincePlot(geo, terrain, plotType, feature[idx], bonus, urban[idx]));
			}
		}
		return new ProvincePlotField(province, out, edgeRing(mask, ground, composed, w, h));
	}

	/**
	 * The <b>neighbour ring</b>: every halo cell touching this province's own land — ground the
	 * generator has already computed and, until now, thrown away at emission.
	 *
	 * <p><b>Why it is emitted at all.</b> A terrain blend asks "which terrain owns this corner", and a
	 * corner of a border plot is touched by plots in ANOTHER province. The client answers that from a
	 * global index it fills as provinces arrive, which is correct but only <i>eventually</i>: a
	 * province baked before its neighbour loaded blends its border against a partial picture and has
	 * to be re-baked when the neighbour lands. Shipping the ring makes the first bake the right one.
	 *
	 * <p><b>Eight neighbours, not four.</b> A plot's corner is shared by up to four plots, so the
	 * diagonal neighbour owns a corner too; a 4-neighbourhood ring would leave every province's four
	 * corner-most vertices unresolved, which is exactly where a seam is most visible.
	 *
	 * <p><b>Ground only.</b> A halo cell that is not ground is a neighbouring WATER province's cell,
	 * whose terrain variant belongs to that province's own generation and is not computed here. Water
	 * neighbours keep the existing eventual-consistency path; this closes the land-to-land case, which
	 * is the one that shows.
	 */
	private static List<EdgeCell> edgeRing(ProvinceMask mask, Terrain[] ground, PlotType[] composed,
			int w, int h) {
		List<EdgeCell> ring = new ArrayList<>();
		for (int ly = 0; ly < h; ly++) {
			for (int lx = 0; lx < w; lx++) {
				// a ring cell is neighbouring ground, never our own land
				if (mask.isLand(lx, ly) || !mask.isGround(lx, ly))
					continue;
				if (!touchesOwnLand(mask, lx, ly, w, h))
					continue;
				int idx = ly * w + lx;
				if (ground[idx] == null)
					continue;   // ungrounded halo cell — nothing to blend against
				ring.add(new EdgeCell(mask.originX() + lx, mask.originY() + ly, ground[idx],
						composed[idx] == null ? PlotType.FLAT : composed[idx]));
			}
		}
		return ring;
	}

	/** Whether any of the eight neighbours of {@code (lx, ly)} is this province's own land. */
	private static boolean touchesOwnLand(ProvinceMask mask, int lx, int ly, int w, int h) {
		for (int dy = -1; dy <= 1; dy++)
			for (int dx = -1; dx <= 1; dx++) {
				if (dx == 0 && dy == 0)
					continue;
				int nx = lx + dx, ny = ly + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h)
					continue;
				if (mask.isLand(nx, ny))
					return true;
			}
		return false;
	}

	/**
	 * The water field of a sea/lake province: <b>every</b> water cell it owns becomes a {@code FLAT}
	 * water plot — COAST (touching land) or SEA further out, in the province's climate variant
	 * ({@link MapTerrainCodec#water}) — each carrying its {@code landDist}, so the web can ramp the
	 * water continuously from shallow to deep instead of ending it at a boundary.
	 * <p>
	 * It used to stop at a three-pixel shelf and leave the deep to the web's screen-space sea
	 * gradient. That is what made every coastline a staircase: the shelf's outer edge was a
	 * plot-square boundary between two different renderings of water. Sea RESOURCES are still
	 * near-shore only ({@link #BONUS_SHELF_MAX}) — the plots extend, the fish do not.
	 * Cold water carries {@code FEATURE_ICE} (the C2C polar-cap + drift-ice model).
	 * Deterministic off the same per-province terrain stream as the land path — an ice draw per
	 * cell only where ice can form, then the bonus draws, in row-major order. See {@code
	 * docs/coastlines.md}.
	 */
	private static ProvincePlotField generateWater(Province province, TerrainRegistry registry,
			ProvinceRaster raster, Rng rng) throws IOException {
		ProvinceMask mask = raster.mask(province.id());
		WorldClimate world = WorldClimate.of(raster);
		boolean lake = province.type() == ProvinceType.LAKE;
		List<Bonus> bonuses = registry.bonuses();
		double latitude = province.latitude();
		// FEATURE_ICE covers frozen water — sea ice thickening as the water gets colder. See the
		// ice-cover model below for why it reads the climate field rather than the latitude.
		Feature ice = registry.feature("FEATURE_ICE");
		// C2C sea ice (addFeatures §3, L2746–2780): temperature-driven drift ice on cold open water,
		// thickening as the water gets colder. The temperature is the sea's own sample of the
		// continuous climate field — which, for water, is the climate of the nearest COAST (water
		// provinces are not control points, so the field's fill hands them their neighbouring
		// shore's value). That is the right signal: a sea ices over because the land around it is
		// frozen, not because a Mercator latitude says 66°. Keying it on |lat| ≥ 66 iced the seas
		// all around Cannor, which the EU4 projection puts at |lat| 60–75. A province reads one
		// sample (its centre), so either all its water ices or none does — keeping the per-cell draw
		// order deterministic. Absent registry ice → no ice, no draws.
		double temp = world.temperature(mask.originX() + mask.width() / 2.0,
				mask.originY() + mask.height() / 2.0);
		final double ICE_ON_WATER = 0.5;
		double driftIce = temp < -40 ? ICE_ON_WATER * 2   // L2766–2780
				: temp < -25 ? ICE_ON_WATER
				: temp < -10 ? ICE_ON_WATER / 2
				: temp < -5 ? ICE_ON_WATER / 3
				: temp < 0 ? ICE_ON_WATER / 4
				: 0;
		// the polar cap the script draws inside poleSeparation rows, here graded by how far the
		// water sits below freezing rather than by row index
		double polarCap = temp < POLAR_TEMPERATURE
				? Math.min(0.9, 0.15 + (POLAR_TEMPERATURE - temp) / 12.0 * 0.75) : 0;
		double iceCover = Math.min(0.95, Math.max(polarCap, driftIce));
		boolean anyIce = ice != null && iceCover > 0;
		int w = mask.width(), h = mask.height();
		// first pass: assemble the shelf cells and their terrain/ice grids (the ice draw
		// per cell, in row-major order, so the stream stays deterministic)
		Terrain[] terrainGrid = new Terrain[w * h];
		Feature[] featureGrid = new Feature[w * h];
		List<int[]> cells = new ArrayList<>();
		List<int[]> bonusCells = new ArrayList<>();   // the near-shore subset — see BONUS_SHELF_MAX
		for (int ly = 0; ly < h; ly++)
			for (int lx = 0; lx < w; lx++) {
				if (!mask.isLand(lx, ly)) // the province's own water pixels
					continue;
				int dist = mask.landDist(lx, ly);
				if (dist < 1) // dry land — not this province's water
					continue;
				Terrain terrain = MapTerrainCodec.water(lake, dist, temp, registry);
				if (terrain == null) // registry lacks the water terrains — no water plots
					continue;
				int idx = ly * w + lx;
				terrainGrid[idx] = terrain;
				// sea ice, validity-gated to the polar water terrain (freshwater lakes get none)
				featureGrid[idx] = anyIce && rng.uniform() < iceCover
						&& ice.validTerrains().contains(terrain.type()) ? ice : null;
				cells.add(new int[] { lx, ly });
				if (dist <= BONUS_SHELF_MAX)
					bonusCells.add(new int[] { lx, ly });
			}
		// Sea resources (fish/crab/whale/…) via the same per-province placement pass (relief-free),
		// offered only the NEAR-SHORE cells now that every water cell is a plot. Two reasons, and the
		// second is the one that would have bitten quietly: the deep ocean would fill with resources
		// nothing can reach, and the placement pass draws row-major over the list it is given, so
		// handing it the whole ocean would shift every coastal draw and silently re-roll placements
		// that have nothing to do with this change.
		Bonus[] bonusGrid = BonusGenerator.place(w, h, bonusCells, terrainGrid, null, featureGrid,
				latitude, bonuses, rng, true);

		List<ProvincePlot> out = new ArrayList<>(cells.size());
		for (int[] c : cells) {
			int lx = c[0], ly = c[1], idx = ly * w + lx;
			// carry the water depth (1 = touching land, rising outward) so the web client can ramp the
			// water continuously from shallow to deep — see PlotGeo#landDist
			PlotGeo geo = new PlotGeo(mask.originX() + lx, mask.originY() + ly, 0,
					mask.elevation(lx, ly), mask.coast(lx, ly), mask.landDist(lx, ly));
			out.add(new ProvincePlot(geo, terrainGrid[idx], PlotType.FLAT, featureGrid[idx], bonusGrid[idx], false));
		}
		// no ring on a water province: its neighbours' LAND is generated by those provinces, and this
		// path never grounds the halo (see edgeRing's "ground only" note). A coast blend still resolves
		// through the client's global index as it always has.
		return new ProvincePlotField(province, out, List.of());
	}

	// the rougher of two reliefs (FLAT < HILL < PEAK), by enum ordinal — used to let
	// a real map mountain/hill override the generator's flatland without flattening
	// the generator's own clustered ranges.
	private static PlotType rougher(PlotType a, PlotType b) {
		return b.ordinal() > a.ordinal() ? b : a;
	}

	// number of majority-smoothing passes over the ground grid (see the call site). More passes
	// grow patches larger; 4 dissolves the salt-and-pepper without erasing genuine terrain regions.
	private static final int DESPECKLE_PASSES = 3;

	// Region-coherence: terrain grows in contiguous PATCHES rather than an independent per-plot draw.
	private static final int PATCH_SIDE = 5;        // patch lattice pitch, in plots (~22 plots per patch)
	private static final double NOISE_CELL = 8.0;   // displacement-noise wavelength, in plots
	private static final double PATCH_JITTER = 5.0; // displacement amplitude, in plots (organic patch edges)

	/**
	 * Ground every {@linkplain ProvinceMask#isGround ground} cell with terrain grown in coherent
	 * regional PATCHES — <b>as a pure function of world position</b>, which is what makes the ground
	 * seamless across province borders (see {@code docs/plot-generator.md} §Seamless generation).
	 * <p>
	 * A {@link #PATCH_SIDE}-pitch lattice is laid over the whole raster in <b>absolute</b>
	 * coordinates. Each lattice cell hashes to a jittered seed point and to its own
	 * {@link Rng}, from which it draws its terrain out of the climate pool sampled at the seed's own
	 * position in the continuous {@link WorldClimate} field. A plot then takes the terrain of its
	 * nearest seed among the 3×3 lattice cells around it, its sample point first nudged by a smooth
	 * low-frequency value-noise field (also in absolute coordinates) so patch boundaries wander
	 * organically instead of forming straight Voronoi walls.
	 * <p>
	 * Every input is a world coordinate and every draw is hash-derived, so this consumes <b>no</b>
	 * rng stream and gives the same answer no matter which province asks: two provinces agree
	 * exactly along their shared border, and generating the world province-by-province is identical
	 * to generating it in one pass. The predecessor scattered seeds over <em>this province's</em>
	 * land and sampled the noise in <em>mask-local</em> coordinates, so neither the patches nor the
	 * noise lattice lined up across a seam.
	 */
	private static void worldGround(Terrain[] ground, ProvinceMask mask, int w, int h,
			WorldClimate climate, ClimateTerrainGenerator.Cache pools) {
		for (int ly = 0; ly < h; ly++)
			for (int lx = 0; lx < w; lx++) {
				if (!mask.isGround(lx, ly))
					continue;
				double wx = mask.originX() + lx, wy = mask.originY() + ly;
				double px = wx + PATCH_JITTER * (valNoise(wx, wy, 1) - 0.5);   // organic boundary displacement
				double py = wy + PATCH_JITTER * (valNoise(wx, wy, 2) - 0.5);
				int cx = (int) Math.floor(px / PATCH_SIDE), cy = (int) Math.floor(py / PATCH_SIDE);
				Terrain best = null;
				double bestD = Double.MAX_VALUE;
				for (int dy = -1; dy <= 1; dy++)
					for (int dx = -1; dx <= 1; dx++) {
						int sxc = cx + dx, syc = cy + dy;
						// the lattice cell's jittered seed point, hashed from its own coordinates
						double sx = (sxc + hash01(sxc, syc, 11)) * PATCH_SIDE;
						double sy = (syc + hash01(sxc, syc, 12)) * PATCH_SIDE;
						double ddx = px - sx, ddy = py - sy, d = ddx * ddx + ddy * ddy;
						if (d >= bestD)
							continue;
						bestD = d;
						best = patchTerrain(sxc, syc, sx, sy, climate, pools);
					}
				ground[ly * w + lx] = best;
			}
	}

	/**
	 * The terrain of one patch: a two-draw {@link ClimateTerrainGenerator} pick (base band then C2C
	 * diversify) from the pool at the patch seed's own climate, off an {@link Rng} seeded by the
	 * lattice coordinates. Pure in {@code (cellX, cellY)} — no shared stream, so patch identity is a
	 * property of the world, not of the generation order.
	 */
	private static Terrain patchTerrain(int cellX, int cellY, double seedX, double seedY,
			WorldClimate climate, ClimateTerrainGenerator.Cache pools) {
		ClimateTerrainGenerator gen = pools.forClimate(
				climate.temperature(seedX, seedY), climate.humidity(seedX, seedY));
		return gen.next(new Rng(hash64(cellX, cellY, 13)));
	}

	/** A 64-bit hash of a lattice coordinate — the per-patch {@link Rng} seed. */
	private static long hash64(int x, int y, int salt) {
		long h = x * 0x9E3779B97F4A7C15L ^ y * 0xC2B2AE3D27D4EB4FL ^ salt * 0x165667B19E3779F9L;
		h ^= h >>> 33;
		h *= 0xFF51AFD7ED558CCDL;
		h ^= h >>> 33;
		h *= 0xC4CEB9FE1A85EC53L;
		return h ^ (h >>> 33);
	}

	/** Smooth value noise in [0,1] at (x,y) for a salt — a hashed coarse lattice, bilinearly smoothstepped. */
	private static double valNoise(double x, double y, int salt) {
		double xs = x / NOISE_CELL, ys = y / NOISE_CELL;
		int x0 = (int) Math.floor(xs), y0 = (int) Math.floor(ys);
		double fx = xs - x0, fy = ys - y0;
		double sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);   // smoothstep
		double a = hash01(x0, y0, salt), b = hash01(x0 + 1, y0, salt);
		double c = hash01(x0, y0 + 1, salt), d = hash01(x0 + 1, y0 + 1, salt);
		return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
	}

	private static double hash01(int x, int y, int salt) {
		int h = x * 374761393 + y * 668265263 + salt * 2147483647;
		h = (h ^ (h >>> 13)) * 1274126177;
		return ((h ^ (h >>> 16)) & 0x7fffffff) / (double) 0x7fffffff;
	}

	// Majority (mode) smoothing of the per-cell ground terrain: each land cell adopts the terrain most
	// common among its 8 land neighbours when that plurality outnumbers the cell's own terrain there —
	// i.e. an isolated speck surrenders to the region around it, while a cell inside a genuine region
	// keeps its terrain (it is the local plurality). Iterated a few times so specks coalesce into
	// patches. Tallied by Terrain.type() (records hold an int[] yields, so keying by the type string is
	// safe regardless of instance interning). Reads a snapshot per pass so the result is independent of
	// scan order, and never touches the rng — the deterministic terrain draws already happened above.
	private static void despeckle(Terrain[] ground, int w, int h) {
		for (int pass = 0; pass < DESPECKLE_PASSES; pass++) {
			Terrain[] src = ground.clone();
			for (int ly = 0; ly < h; ly++)
				for (int lx = 0; lx < w; lx++) {
					int idx = ly * w + lx;
					Terrain self = src[idx];
					if (self == null)
						continue; // water / off-mask cell
					Map<String, Integer> counts = new HashMap<>();
					Map<String, Terrain> byType = new HashMap<>();
					for (int dy = -1; dy <= 1; dy++)
						for (int dx = -1; dx <= 1; dx++) {
							if (dx == 0 && dy == 0)
								continue;
							int nx = lx + dx, ny = ly + dy;
							if (nx < 0 || nx >= w || ny < 0 || ny >= h)
								continue;
							Terrain t = src[ny * w + nx];
							if (t == null)
								continue;
							counts.merge(t.type(), 1, Integer::sum);
							byType.putIfAbsent(t.type(), t);
						}
					int selfCount = counts.getOrDefault(self.type(), 0);
					String bestType = self.type();
					int best = selfCount;
					for (Map.Entry<String, Integer> e : counts.entrySet())
						if (e.getValue() > best) { // strict: ties keep the current terrain (stable)
							best = e.getValue();
							bestType = e.getKey();
						}
					if (!bestType.equals(self.type()))
						ground[idx] = byType.get(bestType);
				}
		}
	}

	// the plot's wild feature, in priority order, every candidate validity-gated
	// against the plot's terrain/relief so no invalid terrain/feature combo is placed
	// (which would mis-gate bonus eligibility and yields):
	//  1. flood plains on a valid flat riverside plot;
	//  2. the C2C vegetation pick (FeatureGenerator's seed-and-spread) where it grew,
	//     used directly if a valid host of this terrain/relief, else falling back to the
	//     map's tree class / climate kind / forest / savanna (vegetationFeature) — this
	//     is where the curated eos feature/terrain rules override the C2C intent;
	//  3. otherwise a sparse terrain-implied feature (swamp on marsh, cactus on desert).
	private static Feature featureFor(Terrain terrain, PlotType relief, boolean river,
			Feature vegetation, int treeIdx, int terrainIdx, ClimateProfile climate,
			Feature floodPlains, TerrainRegistry reg, Rng rng) {
		Feature feature;
		if (river && relief == PlotType.FLAT && valid(floodPlains, terrain, relief))
			feature = floodPlains;
		else if (vegetation != null)
			feature = valid(vegetation, terrain, relief) ? vegetation
					: vegetationFeature(terrain, relief, treeIdx, climate, reg);
		else
			feature = terrainDrivenFeature(terrain, relief, terrainIdx, reg, rng);
		// C2C generic appearance-probability scatter (slice 4, addFeatures L3168): any
		// plot still bare rolls each curated feature's <iAppearance> — this is the only
		// path that places the rarer curated features (forest_ancient / bamboo /
		// very_tall_grass), which no seed-and-spread or terrain-implied rule reaches
		if (feature == null)
			feature = appearanceScatter(terrain, relief, river, reg, rng);
		return feature;
	}

	// C2C oasis scoring & placement (addFeatures L3076–3135). Two steps over the resolved
	// feature grid: (1) score every eligible inland-desert cell (a valid, flat, bare oasis
	// host that is neither riverside/fresh nor coastal) by its 8 neighbours — water and
	// wet/green/featured neighbours drag the score down, dry empty desert lifts it; (2)
	// place an oasis on a random third of the positive-scoring candidates, skipping any
	// adjacent to an oasis already placed, aborting after 20 such misses. Mutates {@code
	// feature} in place; a feature-only pass (no ground rewrite). Consumes one rng draw
	// per candidate placement, so the stream stays deterministic.
	private static void placeOases(ProvinceMask mask, Terrain[] ground, PlotType[] relief,
			Feature[] feature, Feature oasis, Rng rng) {
		if (oasis == null)
			return;
		int w = mask.width(), h = mask.height();
		List<Integer> candidates = new ArrayList<>();
		for (int ly = 0; ly < h; ly++)
			for (int lx = 0; lx < w; lx++) {
				if (!mask.isLand(lx, ly))
					continue;
				int idx = ly * w + lx;
				// eligible = a bare, valid flat oasis host (desert-category), not fresh/riverside
				// and not coastal — the dry interior the oasis punctuates
				if (feature[idx] != null || !valid(oasis, ground[idx], relief[idx])
						|| mask.isRiver(lx, ly) || coastal(mask, lx, ly))
					continue;
				int score = 10;
				for (int[] d : DIRS8) {
					int nx = lx + d[0], ny = ly + d[1];
					if (!mask.isGround(nx, ny))
						continue; // open water neighbour — unreadable, skip
					int ni = ny * w + nx;
					if (mask.isRiver(nx, ny))
						score -= 40;       // a river cell is both fresh and riverside (−20 each)
					if (relief[ni] == PlotType.PEAK)
						score -= 2;
					Feature nf = feature[ni];
					if (nf == null)
						score += 1;
					else if ("FEATURE_JUNGLE".equals(nf.type()))
						score -= 5;
					else if ("FEATURE_FOREST".equals(nf.type()))
						score -= 3;
					else if ("FEATURE_FLOOD_PLAINS".equals(nf.type()))
						score -= 20;
					score += switch (PyTerrain.of(ground[ni])) {
						case DESERT -> 1;
						case PLAINS -> -2;
						case GRASS -> -6;
						case TUNDRA, SNOW -> -20;   // script terrainTundra / terrainSnow
						default -> 0;
					};
					if (score < 0)
						break; // the script bails as soon as the neighbourhood is hostile
				}
				if (score > 0)
					candidates.add(idx);
			}
		int place = candidates.size() / 3;
		int misses = 0;
		for (int i = 0; i < place && !candidates.isEmpty(); i++) {
			int c = candidates.remove(rng.uniform(candidates.size())); // random, without replacement
			int cx = c % w, cy = c / w;
			boolean nearOasis = false;
			for (int[] d : DIRS8) {
				int nx = cx + d[0], ny = cy + d[1];
				if (mask.isGround(nx, ny) && feature[ny * w + nx] == oasis) {
					nearOasis = true;
					break;
				}
			}
			if (nearOasis) {
				if (++misses > 20)
					break;
				continue;
			}
			feature[c] = oasis;
		}
	}

	// the 8 neighbour offsets (oasis scoring reads the full neighbourhood)
	private static final int[][] DIRS8 = {
			{ -1, 0 }, { -1, 1 }, { 0, 1 }, { 1, 1 }, { 1, 0 }, { 1, -1 }, { 0, -1 }, { -1, -1 } };

	// a land cell is coastal if a real sea/lake pixel touches it (the global sea mask) — NOT if a
	// neighbour merely lies outside this province, which would call every border cell coastal
	private static boolean coastal(ProvinceMask mask, int x, int y) {
		return mask.isCoastal(x, y);
	}

	// the generic appearance-probability pass over an otherwise-bare plot (L3171–3175):
	// each curated feature whose <iAppearance> is set and whose terrain/relief/river the
	// plot satisfies is rolled at prob appearance/10000; the last that hits is placed
	// (matching the script's overwrite). One rng draw per valid candidate, so the stream
	// stays deterministic whether or not a feature lands.
	private static Feature appearanceScatter(Terrain terrain, PlotType relief, boolean river,
			TerrainRegistry reg, Rng rng) {
		Feature chosen = null;
		for (Feature f : reg.features()) {
			if (f.appearance() <= 0 || !valid(f, terrain, relief) || (f.requiresRiver() && !river))
				continue;
			if (rng.uniform() < f.appearance() / 10000.0)
				chosen = f;
		}
		return chosen;
	}

	// the feature for a vegetated cell: the first of {the map tree class, the climate
	// kind, forest, savanna} that is a valid host of this terrain/relief — so a hot
	// province whose real ground is plains (where jungle cannot grow) still greens as
	// forest/savanna rather than placing an invalid jungle.
	private static Feature vegetationFeature(Terrain terrain, PlotType relief, int treeIdx,
			ClimateProfile climate, TerrainRegistry reg) {
		String[] keys = { MapTerrainCodec.treeFeatureKey(treeIdx),
				climate.isHot() ? "FEATURE_JUNGLE" : "FEATURE_FOREST",
				"FEATURE_FOREST", "FEATURE_SAVANNA" };
		for (String key : keys) {
			Feature f = key == null ? null : reg.feature(key);
			if (valid(f, terrain, relief))
				return f;
		}
		return null;
	}

	// the sparse terrain-implied feature for a bare cell (swamp/cactus/savanna),
	// validity-gated; always consumes exactly one rng draw so the stream stays
	// deterministic whether or not a feature lands. A wetland places densely (it is
	// the biome), the dry features sparsely (a mix of bare and featured ground).
	private static Feature terrainDrivenFeature(Terrain terrain, PlotType relief,
			int terrainIdx, TerrainRegistry reg, Rng rng) {
		double r = rng.uniform();
		String key = MapTerrainCodec.terrainFeatureKey(terrainIdx);
		Feature f = key == null ? null : reg.feature(key);
		if (!valid(f, terrain, relief))
			return null;
		double chance = "FEATURE_SWAMP".equals(f.type()) ? SWAMP_CHANCE : SPARSE_CHANCE;
		return r < chance ? f : null;
	}

	// whether a feature may sit on a plot: a valid host terrain, and flat ground when
	// the feature requires it (the river requirement is handled by the caller).
	private static boolean valid(Feature f, Terrain terrain, PlotType relief) {
		if (f == null)
			return false;
		if (f.requiresFlatlands() && relief != PlotType.FLAT)
			return false;
		return f.validTerrains().contains(terrain.type());
	}

	/** The province this field belongs to. */
	public Province province() {
		return province;
	}

	/** The generated plots (one per province land pixel), row-major. */
	public List<ProvincePlot> plots() {
		return plots;
	}

	/**
	 * The neighbour ring — cells just OUTSIDE this province, for blending its border (see
	 * {@link EdgeCell}). Never plots: nothing in the sim may read this as the province's land.
	 */
	public List<EdgeCell> edge() {
		return edge;
	}

	/** The number of plots (== the province's land-pixel count). Excludes the neighbour ring. */
	public int size() {
		return plots.size();
	}
}
