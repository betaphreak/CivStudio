package com.civstudio.geo.names;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.PlotGeo;
import com.civstudio.geo.PlotType;
import com.civstudio.geo.TerrainRegistry;
import com.civstudio.geo.names.PlaceNamingPass.ProvincePlots;
import com.civstudio.settlement.Plot;

/**
 * Verifies the {@link PlaceNamingPass} core: the region box is the union of its
 * provinces' plot pixels, naming is position-preserving and per-province unique,
 * and unpositioned plots are left unnamed.
 */
class PlaceNamingPassTest {

	private static CountryGazetteer corners() {
		return CountryGazetteer.of("XX", List.of(
				new GeoNamesPlace(1, "Northwest", 20, 10, 100, 'P'),
				new GeoNamesPlace(2, "Northeast", 20, 20, 100, 'P'),
				new GeoNamesPlace(3, "Southwest", 10, 10, 100, 'P'),
				new GeoNamesPlace(4, "Southeast", 10, 20, 100, 'P'),
				new GeoNamesPlace(5, "Center", 15, 15, 100, 'P')));
	}

	private static Plot plotAt(TerrainRegistry reg, int x, int y) {
		return new Plot(new PlotGeo(x, y, 0, 0, 0, 0), reg.terrain("TERRAIN_DESERT"), PlotType.FLAT, null, null);
	}

	@Test
	void boxUnionAndPerProvinceNaming() {
		TerrainRegistry reg = TerrainRegistry.load();
		Plot unpositioned = plotAt(reg, -1, -1); // PlotGeo.NONE-style; must stay unnamed
		List<ProvincePlots> region = List.of(
				new ProvincePlots(1, List.of(plotAt(reg, 0, 0), plotAt(reg, 1, 1), unpositioned)),
				new ProvincePlots(2, List.of(plotAt(reg, 8, 8), plotAt(reg, 9, 9))));

		// box is the union of positioned plots across both provinces
		assertEquals(new PixelBox(0, 0, 9, 9), PlaceNamingPass.boxOf(region));

		PlaceNamingPass.nameRegion(PlaceNamingPass.boxOf(region), corners(), region);

		// the plot processed first near a corner claims it (deterministic, unique)
		assertEquals("Northwest", region.get(0).plots().get(0).placeName()); // province 1, pixel (0,0)
		assertEquals("Southeast", region.get(1).plots().get(0).placeName()); // province 2, pixel (8,8)
		// unpositioned plot skipped
		assertNull(unpositioned.placeName());
		// every positioned plot named, and unique within its province
		assertNotNull(region.get(1).plots().get(1).placeName());
		assertNotEquals(region.get(1).plots().get(0).placeName(),
				region.get(1).plots().get(1).placeName());
	}
}
