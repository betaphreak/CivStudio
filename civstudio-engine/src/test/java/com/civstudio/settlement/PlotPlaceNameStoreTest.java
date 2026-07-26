package com.civstudio.settlement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.nio.file.Path;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.civstudio.geo.PlotGeo;
import com.civstudio.geo.PlotType;
import com.civstudio.geo.Terrain;
import com.civstudio.geo.TerrainRegistry;

/**
 * Verifies a plot's {@link Plot#placeName() place name} survives the round-trip
 * through the gzipped {@code .map} (the field the naming pass writes), and
 * that a plot generated without a name loads back as {@code null} — so a cache
 * written before the naming pass (or a plot the pass skipped) stays valid.
 */
class PlotPlaceNameStoreTest {

	@Test
	void placeNameRoundTripsThroughTheCache(@TempDir Path tmp) {
		TerrainRegistry reg = TerrainRegistry.load();
		Terrain desert = reg.terrain("TERRAIN_DESERT");
		Plot named = new Plot(new PlotGeo(10, 20, 0, 0, 0, 0), desert, PlotType.FLAT, null, null);
		named.setPlaceName("Kraków"); // UTF-8, exercises the encoding path
		Plot unnamed = new Plot(new PlotGeo(11, 21, 0, 0, 0, 0), desert, PlotType.FLAT, null, null);

		try {
			ProvincePlotStore.configure(tmp.toString());
			ProvincePlotStore.save(999_001, List.of(named, unnamed));
			List<Plot> loaded = ProvincePlotStore.load(999_001, reg);

			assertEquals(2, loaded.size());
			assertEquals("Kraków", loaded.get(0).placeName());
			assertNull(loaded.get(1).placeName(), "an unnamed plot round-trips as null");
		} finally {
			ProvincePlotStore.configure(".map"); // restore default for other tests in the JVM
		}
	}
}
