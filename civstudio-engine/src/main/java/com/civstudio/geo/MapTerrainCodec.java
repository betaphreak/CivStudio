package com.civstudio.geo;

/**
 * Decodes the Anbennar EU4 map rasters into this engine's Civ4 terrain model — the
 * bridge that lets the real committed map (rather than a climate-weighted random
 * draw) drive a province's plots. Two palettes are decoded, each transcribed from
 * the {@code terrain { }} and {@code tree { }} blocks of {@code data/anbennar/terrain.txt}
 * (the EU4 colour-table → terrain definitions):
 * <ul>
 * <li><b>{@code terrain.bmp}</b> (8-bit, 1 pixel = 1 province pixel) — each palette
 * index is an EU4 terrain category; {@link #ground(int, TerrainRegistry)} maps it to
 * the closest curated Civ4 {@link Terrain}, and {@link #relief(int)} extracts the
 * relief EU4 folds into the same palette ({@code hills}/{@code mountain}/{@code
 * snow}) onto the orthogonal {@link PlotType} axis. Water/coastline/unknown indices
 * return {@code null}/{@link PlotType#FLAT} so the caller can fall back.</li>
 * <li><b>{@code trees.bmp}</b> (8-bit, ~1/7.7 resolution: 732&times;266 vs the
 * 5632&times;2048 province raster) — {@link #isWoody(int)}
 * tells whether an index is a tree-cover class ({@code forest}/{@code woods}/{@code
 * jungle}/{@code palms}); the coarse resolution makes this a province-level density
 * signal rather than a per-pixel feature (see {@code ProvincePlotField}).</li>
 * </ul>
 * The EU4 palette is fixed by the game engine, so the tables are transcribed once
 * here (with each index's source category in a comment) rather than parsed from
 * {@code terrain.txt} at runtime; the semantic EU4→Civ4 mapping has to be authored
 * by hand regardless. See {@code docs/plots.md}.
 */
public final class MapTerrainCodec {

	private MapTerrainCodec() {
	}

	/**
	 * The curated Civ4 terrain key for a {@code terrain.bmp} palette index, or {@code
	 * null} for a water/coastline/unmapped index (the caller falls back to the
	 * climate-weighted draw there). Several EU4 categories that have no distinct Civ4
	 * peer collapse onto the nearest one (e.g. {@code farmlands}→grassland,
	 * {@code highlands}→plains). The relief EU4 carries in the same palette is
	 * stripped out here — a {@code hills} pixel returns its <em>ground</em>
	 * (grassland), with the hill surfaced separately by {@link #relief(int)}.
	 *
	 * @param index the {@code terrain.bmp} palette index at a pixel
	 * @param reg   the curated terrain registry to resolve the key against
	 * @return the Civ4 terrain, or {@code null} if the index is water/unmapped
	 */
	public static Terrain ground(int index, TerrainRegistry reg) {
		String key = groundKey(index);
		return key == null ? null : reg.terrain(key);
	}

	// terrain.bmp index -> curated Civ4 terrain key (null = water/unmapped). The
	// comment on each case is the EU4 category from terrain.txt's `terrain { }` block.
	private static String groundKey(int index) {
		return switch (index) {
			case 0 -> "TERRAIN_GRASSLAND";   // grasslands
			case 1 -> "TERRAIN_GRASSLAND";   // hills (ground is grass; relief() -> HILL)
			case 2 -> "TERRAIN_ROCKY";       // desert_mountain (relief() -> PEAK)
			case 3 -> "TERRAIN_DESERT";      // desert
			case 4 -> "TERRAIN_PLAINS";      // plains
			case 5 -> "TERRAIN_GRASSLAND";   // terrain_5 (grasslands)
			case 6 -> "TERRAIN_ROCKY";       // mountain (relief() -> PEAK)
			case 7 -> "TERRAIN_DESERT";      // desert_mountain_low (relief() -> HILL)
			case 8 -> "TERRAIN_GRASSLAND";   // terrain_8 (hills; relief() -> HILL)
			case 9 -> "TERRAIN_MARSH";       // marsh
			case 10, 11 -> "TERRAIN_GRASSLAND"; // farmlands (rich grassland)
			case 12, 14 -> "TERRAIN_GRASSLAND"; // forest_12/forest_14 (woods over grass)
			case 13 -> "TERRAIN_MARSH";      // shadow_swamp_terrain
			case 16 -> "TERRAIN_PERMAFROST"; // snow / permanent snow (relief() -> PEAK)
			case 19 -> "TERRAIN_DESERT";     // coastal_desert
			case 20 -> "TERRAIN_PLAINS";     // savannah
			case 22 -> "TERRAIN_SCRUB";      // drylands
			case 23 -> "TERRAIN_PLAINS";     // highlands (relief() -> HILL)
			case 24 -> "TERRAIN_SCRUB";      // dry_highlands (relief() -> HILL)
			case 254 -> "TERRAIN_LUSH";      // jungle
			case 255 -> "TERRAIN_GRASSLAND"; // woods (over grass)
			default -> null;                 // 15/17 ocean, 35 coastline, anything else
		};
	}

	/**
	 * The Civ4 water terrain for a coastal-shelf plot: {@code COAST} (touching land, {@code
	 * landDist} 1) or {@code SEA} (further out) in the water's climate variant (polar /
	 * tropical / temperate by temperature), or freshwater {@code LAKE_SHORE}/{@code LAKE}
	 * for a lake province. Resolves against the registry's shelf water terrains ({@link
	 * com.civstudio.geo.export.TerrainExporter} keeps them); {@code null} if the key is absent.
	 * The water counterpart of {@link #ground}: the coastal-shelf plots ground on it and the sea
	 * bonuses (fish/crab/whale/…) place by it. See {@code docs/coastlines.md}.
	 *
	 * @param lake        whether the province is a lake (freshwater) rather than open sea
	 * @param landDist    Chebyshev pixels to the nearest dry land (1 = coast, higher = further out)
	 * @param temperature the {@link WorldClimate} temperature of the water (C2C scale)
	 * @param reg         the terrain registry
	 * @return the water terrain, or {@code null} if the registry lacks the key
	 */
	public static Terrain water(boolean lake, int landDist, double temperature, TerrainRegistry reg) {
		String key;
		if (lake) {
			key = landDist <= 1 ? "TERRAIN_LAKE_SHORE" : "TERRAIN_LAKE";
		} else {
			key = (landDist <= 1 ? "TERRAIN_COAST" : "TERRAIN_SEA") + climateBand(temperature);
		}
		return reg.terrain(key);
	}

	/**
	 * The climate suffix for a sea terrain, by the {@link WorldClimate} temperature the water
	 * inherits from its nearest coast: polar at or below {@link ProvincePlotField#POLAR_TEMPERATURE},
	 * tropical from {@link #TROPICAL_TEMPERATURE} up, temperate (no suffix) between. This used to
	 * band on |latitude| (polar ≥ 66°, tropical ≤ 23°) — but the EU4 map's inverse-Mercator latitudes
	 * put temperate Cannor at 60–75°, so its seas rendered polar and iced over.
	 */
	private static String climateBand(double temperature) {
		if (temperature <= ProvincePlotField.POLAR_TEMPERATURE)
			return "_POLAR";
		if (temperature >= TROPICAL_TEMPERATURE)
			return "_TROPICAL";
		return "";
	}

	/** The temperature (C2C scale) at or above which water reads tropical. */
	static final double TROPICAL_TEMPERATURE = 24.0;

	/**
	 * The {@link PlotType relief} EU4 encodes for a {@code terrain.bmp} palette index
	 * — its palette conflates relief with ground, so {@code hills}/{@code highlands}
	 * are {@link PlotType#HILL} and {@code mountain}/{@code snow} are {@link
	 * PlotType#PEAK}; every other (flat-ground) index is {@link PlotType#FLAT}. The
	 * caller composes this with the spatially-clustered relief from {@link
	 * ReliefGenerator}, taking the rougher of the two, so real mountains survive while
	 * ordinary ground keeps the generator's coherent hill ranges.
	 *
	 * @param index the {@code terrain.bmp} palette index at a pixel
	 * @return the relief that index implies ({@link PlotType#FLAT} when it implies none)
	 */
	public static PlotType relief(int index) {
		return switch (index) {
			case 2, 6, 16 -> PlotType.PEAK;       // desert_mountain / mountain / snow
			case 1, 7, 8, 23, 24 -> PlotType.HILL; // hills / desert_mtn_low / highlands
			default -> PlotType.FLAT;
		};
	}

	/**
	 * Whether a {@code trees.bmp} palette index is a tree-cover class — {@code
	 * forest}, {@code woods}, {@code jungle} or {@code palms} (the woody covers).
	 * Treeless classes ({@code savana}, {@code shadow_swamp}) and the bare index 0
	 * return {@code false}. Transcribed from terrain.txt's {@code tree { }} block.
	 * Used as the province-level <b>density</b> signal (how wooded the map paints the
	 * province); {@link #treeFeatureKey} maps the same classes to a concrete feature.
	 *
	 * @param index the {@code trees.bmp} palette index
	 * @return {@code true} if the index marks tree cover
	 */
	public static boolean isWoody(int index) {
		return switch (index) {
			// forest = 3 4 6 7 19 20 ; woods = 2 5 8 18 ; jungle = 13 14 15 ; palms = 12
			case 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 18, 19, 20 -> true;
			default -> false; // 0 bare, 27-30 savana, 31-33 shadow_swamp
		};
	}

	/**
	 * The Civ4 feature a {@code trees.bmp} palette class implies — so the map's
	 * distinct tree classes become distinct features rather than collapsing onto one
	 * climate kind: {@code jungle}→jungle, {@code forest}/{@code woods}→forest,
	 * {@code palms}→oasis, {@code savana}→savanna, {@code shadow_swamp}→swamp; the
	 * bare index 0 (and anything else) maps to {@code null}. Transcribed from
	 * terrain.txt's {@code tree { }} block. The <em>key</em> is returned (not the
	 * {@link Feature}) so the caller can validity-gate it against the plot's terrain
	 * and fall back when the class is not a valid host (e.g. jungle over plains).
	 *
	 * @param index the {@code trees.bmp} palette index
	 * @return the Civ4 feature key, or {@code null} for bare/unmapped
	 */
	public static String treeFeatureKey(int index) {
		return switch (index) {
			case 13, 14, 15 -> "FEATURE_JUNGLE";           // jungle
			case 12 -> "FEATURE_OASIS";                    // palms (desert palms ≈ oasis)
			case 27, 28, 29, 30 -> "FEATURE_SAVANNA";      // savana
			case 31, 32, 33 -> "FEATURE_SWAMP";            // shadow_swamp
			case 2, 3, 4, 5, 6, 7, 8, 18, 19, 20 -> "FEATURE_FOREST"; // forest / woods
			default -> null;
		};
	}

	/**
	 * The Civ4 feature a {@code terrain.bmp} ground implies, for a cell the tree
	 * overlay leaves bare — so a treeless province still carries its biome's
	 * signature feature: {@code marsh}/{@code shadow_swamp_terrain}→swamp, {@code
	 * desert}/{@code coastal_desert}→cactus, {@code savannah}→savanna; every other
	 * index maps to {@code null}. The caller places these sparsely and validity-gates
	 * them against the plot's terrain/relief.
	 *
	 * @param index the {@code terrain.bmp} palette index
	 * @return the Civ4 feature key, or {@code null}
	 */
	public static String terrainFeatureKey(int index) {
		return switch (index) {
			case 9, 13 -> "FEATURE_SWAMP";        // marsh / shadow_swamp_terrain
			case 3, 7, 19 -> "FEATURE_CACTUS";    // desert / desert_low / coastal_desert
			case 20 -> "FEATURE_SAVANNA";         // savannah
			default -> null;
		};
	}
}
