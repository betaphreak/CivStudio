package com.civstudio.geo;

/**
 * <b>One province's</b> climate reduced to the two scalars the Caveman2Cosmos planet generator's
 * per-tile stage reads: a <b>temperature</b> (its terrain/feature thresholds — {@code > 30} clears
 * the desert gate, {@code < 0} reaches the frozen terrains) and a <b>humidity</b> in {@code [0, 1]}
 * (how readily plants grow). Both come from the province's authored
 * {@link Climate}/{@link WinterSeverity}/{@link Monsoon} via {@link WorldClimate}, which owns the
 * model. See {@code docs/plot-generator.md} §Temperature.
 * <p>
 * <b>Generation samples the field, not this.</b> {@link WorldClimate} blends these per-province
 * control values into a continuous field and the stages read it per cell, so the terrain pool does
 * not step at a province border. This record remains the province-level view — for the
 * membership-driven ground overrides (cavern / barren / special-terrain filler, whose borders are
 * deliberately sharp), for reporting, and for tests.
 *
 * @param temperature the C2C-scale temperature (≈ {@code -20..35})
 * @param humidity    the wetness in {@code [0, 0.95]}
 */
public record ClimateProfile(double temperature, double humidity) {

	/**
	 * The climate profile of a province — now the same values {@link WorldClimate} builds its field
	 * from, so the province-level view and the per-cell field agree. There used to be a third,
	 * separate temperature scale here (tropical 45 … arctic 0, minus a winter and latitude term of
	 * its own); the generator now has exactly one temperature model, as the C2C script does.
	 */
	public static ClimateProfile of(Province p) {
		return new ClimateProfile(WorldClimate.controlTemperature(p), WorldClimate.controlHumidity(p));
	}

	/** Whether it is hot enough for jungle rather than forest (the C2C jungle band, on this scale). */
	public boolean isHot() {
		return temperature > 24;
	}

	/**
	 * The C2C map option {@code temperature} — the equator temperature of the
	 * {@link #pyTemperature(double) latitudinal tent} ({@code getTileTemperature},
	 * L3301). The default the script falls back to when the option is unset.
	 */
	public static final double CLIMATE_TEMPERATURE = 40.0;

	/**
	 * The C2C map option {@code variation} — how far the poles cool below the
	 * {@linkplain #CLIMATE_TEMPERATURE equator} (default; L387/L3296).
	 */
	public static final double CLIMATE_VARIATION = 0.4;

	/**
	 * The pole temperature of the tent: {@code (climateTemperature + 50)·variation − 50}
	 * (L3304). With the defaults this is {@code (90·0.4) − 50 = −14}.
	 */
	public static final double LOWEST_TEMPERATURE = (CLIMATE_TEMPERATURE + 50.0) * CLIMATE_VARIATION - 50.0;

	/**
	 * The C2C per-tile temperature on the <b>Python scale</b> for a latitude, porting
	 * {@code getTileTemperature(y, h)} (L3301–3310). The script keys its terrain and
	 * feature weights off this value — a latitudinal tent from {@link
	 * #CLIMATE_TEMPERATURE} at the equator down to {@link #LOWEST_TEMPERATURE} at the
	 * poles — so its thresholds ({@code > 30}, {@code > 40}, {@code 5..−10}, {@code
	 * < −20}, …) only transfer verbatim when the temperature is on the same scale.
	 * This reproduces the tent from the province latitude (rather than the eos
	 * {@link #temperature()} scale) so the ported feature weights apply unchanged.
	 * <p>
	 * The tent is linear in the distance from the equator: {@code y > half} and
	 * {@code y < half} are symmetric about the equator in the script, so here the
	 * absolute latitude (equator {@code 0} … pole {@code ±90}) drives it directly.
	 *
	 * @param latitude the plot/province latitude in decimal degrees (north positive)
	 * @return the C2C-scale temperature (≈ {@code −14 … 40} with the defaults)
	 */
	public static double pyTemperature(double latitude) {
		double fractionToPole = Math.min(1.0, Math.abs(latitude) / 90.0);
		return CLIMATE_TEMPERATURE + (LOWEST_TEMPERATURE - CLIMATE_TEMPERATURE) * fractionToPole;
	}
}
