package com.civstudio.geo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * The one temperature model the generator has, and the continuous field it builds from it (see
 * {@code docs/plot-generator.md} §Temperature / §Seamless generation).
 * <p>
 * The model exists because the previous one stacked an Anbennar climate base, a winter-severity
 * cooling of up to 16&nbsp;°C, and a poleward lapse of 0.4&nbsp;°C/deg on top of a latitude that is
 * an <b>inverse-Mercator artifact</b> of the EU4 map — which puts Anbennar's temperate Cannor at
 * |lat| 60–75°. The result was <b>1542 of 4121 land provinces below 0&nbsp;°C</b>, i.e. drawing
 * from the tundra/permafrost bands: 82% of Western Cannor, 95% of Escann, 83% of Kheionai, 51% of
 * Taychend. Anbennar itself marks only 116 provinces {@code arctic}.
 */
class WorldClimateTest {

	private static List<Province> landProvinces() {
		return WorldMap.load().provinces().stream()
				.filter(p -> p.type() == ProvinceType.LAND)
				.toList();
	}

	private static List<Province> inSuperRegion(String key) {
		WorldMap map = WorldMap.load();
		return map.provincesInSuperRegion(key).stream()
				.filter(p -> p.type() == ProvinceType.LAND)
				.toList();
	}

	/**
	 * The authored climate is the authority: a province Anbennar does <b>not</b> mark arctic never
	 * lands in the sub-zero bands, whatever its Mercator latitude and winter severity say.
	 */
	@Test
	void onlyArcticProvincesDrawFromTheFrozenBands() {
		long frozenNonArctic = landProvinces().stream()
				.filter(p -> p.climate() != Climate.ARCTIC)
				.filter(p -> WorldClimate.controlTemperature(p) < 0)
				.count();
		assertEquals(0, frozenNonArctic,
				"no non-arctic land province is sub-zero (was 1542 of 4121 across all climates)");
	}

	/** Cannor — Anbennar's temperate heartland, and the region the over-snowing was reported on. */
	@Test
	void cannorIsTemperate() {
		List<Province> cannor = inSuperRegion("western_cannor_superregion");
		assertTrue(cannor.size() > 300, "the fixture has Western Cannor: " + cannor.size());
		for (Province p : cannor) {
			double t = WorldClimate.controlTemperature(p);
			assertTrue(t > 0, p.name() + " is not frozen (" + t + " °C)");
			assertTrue(t < 30, p.name() + " is not a desert (" + t + " °C)");
		}
	}

	/** …and the genuinely cold and hot places stay that way — the fix is calibration, not a flattening. */
	@Test
	void theArcticAndTheTropicsKeepTheirCharacter() {
		for (Province p : landProvinces()) {
			double t = WorldClimate.controlTemperature(p);
			if (p.climate() == Climate.ARCTIC && p.winter() == WinterSeverity.SEVERE)
				assertTrue(t < -10, p.name() + " (arctic, severe winter) is deep cold: " + t);
			if (p.climate() == Climate.ARID)
				// arid reaches desert through eos's dryness gate (h < 0.25) rather than the script's
				// temperature-only one, so a HIGH-LATITUDE arid province is still a cold steppe desert
				assertTrue(ClimateTerrainGenerator.pool(t, WorldClimate.controlHumidity(p))
						.containsKey("TERRAIN_DESERT"), p.name() + " (arid) still deserts at " + t + " °C");
		}
		// each anchor lands in the C2C band it is meant to: tropical inside the grass band (4..30,
		// so the ground greens and the feature stage supplies the jungle), arid above the desert
		// gate (>30), temperate in grass/plains/marsh, arctic in the cold bands
		assertTrue(ClimateTerrainGenerator.pool(27, 0.7).containsKey("TERRAIN_GRASSLAND"), "tropical greens");
		assertTrue(ClimateTerrainGenerator.pool(32, 0.1).containsKey("TERRAIN_DESERT"), "arid deserts");
		assertTrue(ClimateTerrainGenerator.pool(19, 0.5).containsKey("TERRAIN_GRASSLAND"), "temperate greens");
		assertTrue(ClimateTerrainGenerator.pool(-4, 0.3).containsKey("TERRAIN_TUNDRA"), "arctic freezes");
		assertTrue(ClimateTerrainGenerator.pool(19, 0.5).keySet().stream().noneMatch(
				k -> k.equals("TERRAIN_TUNDRA") || k.equals("TERRAIN_PERMAFROST")), "temperate does not freeze");
	}

	/**
	 * The field is <b>continuous</b>: sampling across the map, the temperature never jumps the way a
	 * per-province step function does. This is what stops the terrain pool — and so the ground —
	 * from breaking at a province border.
	 */
	@Test
	void theFieldIsContinuousAcrossProvinceBorders() throws Exception {
		ProvinceRaster raster = ProvinceRaster.load();
		WorldClimate climate = WorldClimate.of(raster);
		int w = raster.rasterWidth();
		double worstStep = 0, sumStep = 0;
		long pairs = 0, sharpPairs = 0;
		// a few long horizontal transects across the inhabited band, which cross many borders
		for (int y = 300; y < 1200; y += 97) {
			double prev = climate.temperature(0, y);
			for (int x = 1; x < w; x++) {
				double t = climate.temperature(x, y);
				double step = Math.abs(t - prev);
				worstStep = Math.max(worstStep, step);
				sumStep += step;
				pairs++;
				if (step > 2.0)
					sharpPairs++;
				prev = t;
			}
		}
		// The step function is gone: the per-province model jumped by its full climate difference at
		// EVERY border (an arid neighbour of an arctic province stepped ~45 °C in one pixel), so a
		// transect crossed dozens of sharp steps. The field spreads each transition over
		// WorldClimate.BLEND_PIXELS, leaving a bounded gradient — steepest where Anbennar genuinely
		// abuts a desert on a frozen waste, which should read as a fast transition, not a flat one.
		assertTrue(sumStep / pairs < 0.10,   // measured 0.057 °C per plot
				"the field is smooth on average (" + sumStep / pairs + " °C per pixel)");
		assertTrue(sharpPairs / (double) pairs < 0.002,
				"sharp steps are rare (" + 100.0 * sharpPairs / pairs + "% of pixel pairs step > 2 °C)");
		assertTrue(worstStep < 8.0,
				"and bounded even at the harshest climate boundary (worst " + worstStep + " °C)");
	}

	/**
	 * Water bands on the temperature it inherits from its nearest coast, not on |latitude|. The old
	 * {@code |lat| >= 66} rule drew polar sea — and started the ice cap — all around Cannor, which the
	 * EU4 projection puts at |lat| 60–75.
	 */
	@Test
	void cannorsSeasAreNotPolar() throws Exception {
		ProvinceRaster raster = ProvinceRaster.load();
		WorldClimate climate = WorldClimate.of(raster);
		TerrainRegistry reg = TerrainRegistry.load();
		WorldMap map = WorldMap.load();

		for (Province p : inSuperRegion("western_cannor_superregion")) {
			ProvinceMask mask = raster.mask(p.id());
			double t = climate.temperature(mask.originX() + mask.width() / 2.0,
					mask.originY() + mask.height() / 2.0);
			Terrain coast = MapTerrainCodec.water(false, 1, t, reg);
			assertTrue(coast != null && !coast.type().endsWith("_POLAR"),
					"the sea off " + p.name() + " (|lat| " + Math.abs(p.latitude()) + ") is not polar: "
							+ (coast == null ? "null" : coast.type()));
		}

		// …while a genuinely arctic shore still freezes
		Province arctic = map.provinces().stream()
				.filter(q -> q.type() == ProvinceType.LAND && q.climate() == Climate.ARCTIC
						&& q.winter() == WinterSeverity.SEVERE)
				.findFirst().orElseThrow();
		ProvinceMask am = raster.mask(arctic.id());
		double at = climate.temperature(am.originX() + am.width() / 2.0, am.originY() + am.height() / 2.0);
		Terrain arcticCoast = MapTerrainCodec.water(false, 1, at, reg);
		assertTrue(arcticCoast != null && arcticCoast.type().endsWith("_POLAR"),
				"the sea off arctic " + arctic.name() + " is polar: "
						+ (arcticCoast == null ? "null" : arcticCoast.type()));
	}

	/** The field is world data: no seed, no rng, same answer every build. */
	@Test
	void theFieldIsDeterministic() throws Exception {
		ProvinceRaster raster = ProvinceRaster.load();
		WorldClimate a = WorldClimate.build(WorldMap.load(), raster);
		WorldClimate b = WorldClimate.build(WorldMap.load(), raster);
		for (int y = 200; y < 1400; y += 211)
			for (int x = 100; x < 5000; x += 307) {
				assertEquals(a.temperature(x, y), b.temperature(x, y), 0.0, "temperature at " + x + "," + y);
				assertEquals(a.humidity(x, y), b.humidity(x, y), 0.0, "humidity at " + x + "," + y);
			}
	}
}
