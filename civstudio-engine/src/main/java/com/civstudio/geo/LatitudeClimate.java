package com.civstudio.geo;

import java.util.Map;

/**
 * The <b>travel-cost</b> cold model, plus the per-region lore temperature offsets — what is left of
 * the original latitude→temperature→cold-terrain port once terrain generation moved to
 * {@link WorldClimate}.
 * <p>
 * <b>This is not the terrain climate model.</b> Generation reads exactly one temperature,
 * {@link WorldClimate#controlTemperature}, anchored on Anbennar's authored {@code climate.txt}. What
 * remains here is {@link #effectiveTemperature}/{@link #coldFraction}, which {@link LandRouter} uses
 * to price land travel (cold country is slower), and {@link #regionTempOffset}, which
 * {@code WorldClimate} still reads for the authored lore anomalies.
 * <p>
 * The latitude term below is the C2C generator's tent ({@code getTileTemperature}, its defaults:
 * {@code climateTemperature = 40} at the equator, {@code climateVariation = 0.4} so the poles reach
 * {@code (40+50)*0.4 - 50 = -14}; linear in the distance from the equator). <b>Caveat:</b> Anbennar's
 * latitudes are inverse-Mercator over the whole 2048-row raster, so temperate Cannor reads |lat|
 * 60–75° and this model prices it as near-arctic terrain. That is the same inflation that used to
 * cover the map in snow (see {@code docs/plot-generator.md} §Temperature); it was left in place here
 * because changing it changes caravan routing, not the map.
 */
public final class LatitudeClimate {

	private LatitudeClimate() {
	}

	// C2C planet-generator climate constants (its module globals)
	private static final double CLIMATE_TEMPERATURE = 40.0; // equator
	private static final double CLIMATE_VARIATION = 0.4;
	private static final double LOWEST_TEMPERATURE =
			(CLIMATE_TEMPERATURE + 50) * CLIMATE_VARIATION - 50; // -14 at the poles

	/** Temperature at |lat|=0 vs 90°, linear (the generator's {@code getTileTemperature}). */
	public static double temperature(double latitude) {
		double f = Math.min(1.0, Math.abs(latitude) / 90.0);
		return CLIMATE_TEMPERATURE + (LOWEST_TEMPERATURE - CLIMATE_TEMPERATURE) * f;
	}

	/**
	 * Extra cooling (°C) from the province's Anbennar winter severity, on the travel-cost scale — a
	 * harsher winter reads colder than latitude alone. Terrain generation uses its own, much milder
	 * winter modifier ({@link WorldClimate#controlTemperature}); these two are deliberately separate.
	 */
	public static double winterOffset(WinterSeverity winter) {
		return switch (winter) {
			case NONE -> 0.0;
			case MILD -> 5.0;
			case NORMAL -> 10.0;
			case SEVERE -> 16.0;
		};
	}

	/**
	 * The <b>effective</b> travel-cost temperature: latitude temperature minus the winter cooling.
	 * This is what {@link #coldFraction} should be given.
	 */
	public static double effectiveTemperature(double latitude, WinterSeverity winter) {
		return temperature(latitude) - winterOffset(winter);
	}

	// Per-region relative temperature modifier (°C), added to a province's effective temperature on
	// top of its latitude + winter — so permafrost/taiga/glaciation all follow from the shifted
	// temperature. A CivStudio climate knob, not an EU4 concept (Anbennar's climate is per-province
	// in climate.txt, with no regional offset): a lore anomaly where a region runs warmer (positive)
	// or colder (negative) than its latitude dictates. Keyed on the region raw_key that
	// Province#regionKey carries (from region.txt); a region absent from the map reads 0.
	//
	// North + South Yarikhoi (in the Forbidden Lands) run 20°C warm, a temperate pocket in the
	// deep north.
	private static final Map<String, Double> REGION_TEMP_OFFSET = Map.of(
			"north_yarikhoi_region", 20.0,
			"south_yarikhoi_region", 20.0);

	/** The relative temperature modifier (°C) for a province's region — 0 if its region has none. */
	public static double regionTempOffset(Province province) {
		Double off = province.regionKey() == null ? null : REGION_TEMP_OFFSET.get(province.regionKey());
		return off == null ? 0.0 : off;
	}

	// the temperature at which country starts reading as cold going (first hint of boreal), and the
	// temperature at/below which it is fully frozen. coldFraction ramps between.
	private static final double COLD_START = 12.0;   // ~|lat| 47°
	private static final double COLD_FULL = -6.0;    // ~|lat| 77°

	/** How cold the going is, 0 in the temperate zone → 1 in the deep cold ({@link LandRouter}). */
	public static double coldFraction(double temperature) {
		if (temperature >= COLD_START)
			return 0.0;
		if (temperature <= COLD_FULL)
			return 1.0;
		return (COLD_START - temperature) / (COLD_START - COLD_FULL);
	}
}
