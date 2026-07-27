package com.civstudio.geo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.ProvincePlotField.ProvincePlot;
import com.civstudio.util.Rng;

/**
 * Phase-1 checks on the per-province plot field (see {@code
 * docs/province-plots.md}): the field is the province's real silhouette (one plot
 * per land pixel), is generated deterministically per seed, carries valid
 * relief/terrain on every plot, and the C2C-ported relief actually clusters.
 */
class ProvincePlotFieldTest {

	/** Dhenijansar (province 4411) — the default colony's coastal LAND province. */
	// a normal farming province (features, resources, relief) for the generation tests
	private static Province kaashesh() {
		return WorldMap.load().findByName("Kaashesh").orElseThrow();
	}

	// a river-bearing province for the raster/mask tests (Dhenijansar is city_terrain now, but the
	// mask reads the unchanged raster — its rivers exercise the adjacency mask)
	private static Province dhenijansar() {
		return WorldMap.load().findByName("Dhenijansar").orElseThrow();
	}

	@Test
	void fieldIsTheProvinceSilhouetteWithValidPlots() throws Exception {
		Province dh = kaashesh();
		ProvincePlotField field = ProvincePlotField.generate(
				dh, TerrainRegistry.load(), ProvinceRaster.load(), new Rng(42));

		// one plot per province land pixel
		assertEquals(dh.plots(), field.size(), "plot count == province.plots");

		// every plot has terrain + relief, and a unique raster position
		Set<Long> seen = new HashSet<>();
		for (ProvincePlot p : field.plots()) {
			assertNotNull(p.terrain(), "terrain");
			assertNotNull(p.plotType(), "relief");
			assertTrue(seen.add(((long) p.x() << 20) | (p.y() & 0xFFFFF)), "distinct position");
		}
	}

	/**
	 * The neighbour ring (MAP_VERSION 16): the halo cells just outside the province, shipped so a
	 * client blends the border on its FIRST bake. Its two load-bearing properties are that it is
	 * DISJOINT from the plots — nothing in the sim may read a neighbour's ground as this province's
	 * land — and that it actually touches the province, since a ring that missed would be pure payload.
	 */
	@Test
	void theNeighbourRingIsAdjacentGroundAndNeverThisProvincesLand() throws Exception {
		Province dh = kaashesh();
		ProvincePlotField field = ProvincePlotField.generate(
				dh, TerrainRegistry.load(), ProvinceRaster.load(), new Rng(42));

		assertFalse(field.edge().isEmpty(), "an inland province has neighbouring land to blend against");
		assertEquals(dh.plots(), field.size(), "the ring is NOT counted as plots");

		Set<Long> own = new HashSet<>();
		for (ProvincePlot p : field.plots())
			own.add(((long) p.x() << 20) | (p.y() & 0xFFFFF));

		Set<Long> ring = new HashSet<>();
		for (ProvincePlotField.EdgeCell e : field.edge()) {
			long k = ((long) e.x() << 20) | (e.y() & 0xFFFFF);
			assertFalse(own.contains(k), "a ring cell is never one of the province's own plots");
			assertTrue(ring.add(k), "ring cells are distinct");
			assertNotNull(e.terrain(), "a ring cell carries the terrain the blend asks it for");
			assertNotNull(e.plotType(), "…and its relief, because PEAK outranks every terrain");
		}

		// EIGHT-neighbourhood: a corner is shared by four plots, so the diagonal neighbour owns one
		// too. Every ring cell must touch own land, or it is payload nobody can use.
		for (ProvincePlotField.EdgeCell e : field.edge()) {
			boolean touches = false;
			for (int dy = -1; dy <= 1 && !touches; dy++)
				for (int dx = -1; dx <= 1 && !touches; dx++)
					if (!(dx == 0 && dy == 0)
							&& own.contains(((long) (e.x() + dx) << 20) | ((e.y() + dy) & 0xFFFFF)))
						touches = true;
			assertTrue(touches, "ring cell " + e.x() + "," + e.y() + " touches the province");
		}
	}

	@Test
	void plotsCarryHeightmapElevation() throws Exception {
		Province dh = kaashesh();
		ProvinceRaster raster = ProvinceRaster.load();
		ProvincePlotField field = ProvincePlotField.generate(
				dh, TerrainRegistry.load(), raster, new Rng(11));

		// every plot's elevation is exactly the heightmap.bmp value at its raster pixel
		// (the mask exposes it), and a real province carries non-trivial relief
		ProvinceMask mask = raster.mask(dh.id());
		int min = 255, max = 0;
		for (ProvincePlot p : field.plots()) {
			int lx = p.x() - mask.originX(), ly = p.y() - mask.originY();
			assertEquals(mask.elevation(lx, ly), p.elevation(),
					"plot elevation == heightmap at its pixel");
			min = Math.min(min, p.elevation());
			max = Math.max(max, p.elevation());
		}
		assertTrue(max > 0, "elevation populated from the heightmap (max=" + max + ")");
		assertTrue(max > min, "the province has elevation variation (" + min + ".." + max + ")");
	}

	@Test
	void riverAdjacencyMaskMatchesRiverNeighbours() throws Exception {
		// the river code's thousands field is a 4-bit mask (1=E,2=W,4=S,8=N) of which orthogonal
		// neighbours are also river cells — the seam fix that lets the web ribbon link across
		// provinces. Verify it agrees with the actual neighbours the mask can see (in-bounds);
		// edge cells may set bits pointing into an adjacent province, which one mask cannot check.
		// NB the demask is %100, not %16: the mask reaches 15, so it spans the thousands AND
		// ten-thousands digits, and %16 would fold the class digit above it back in as garbage.
		ProvinceMask mask = ProvinceRaster.load().mask(dhenijansar().id());
		int[][] dirs = { { 1, 0, 1 }, { -1, 0, 2 }, { 0, 1, 4 }, { 0, -1, 8 } };   // dx, dy, bit
		int riverCells = 0;
		for (int ly = 0; ly < mask.height(); ly++)
			for (int lx = 0; lx < mask.width(); lx++) {
				int code = mask.riverCode(lx, ly);
				if (code == 0) continue;
				riverCells++;
				int adj = (code / 1000) % 100;
				for (int[] d : dirs) {
					int nx = lx + d[0], ny = ly + d[1];
					if (nx < 0 || nx >= mask.width() || ny < 0 || ny >= mask.height()) continue;
					boolean bitSet = (adj & d[2]) != 0;
					boolean nbRiver = mask.riverCode(nx, ny) != 0;
					assertEquals(nbRiver, bitSet,
							"adjacency bit " + d[2] + " at (" + lx + "," + ly + ") must match a river neighbour");
				}
			}
		assertTrue(riverCells > 0, "Dhenijansar carries river cells to exercise the mask");
	}

	@Test
	void riverCodeFieldsDoNotCollide() throws Exception {
		// the packing is decimal digits sharing one int, and the render class was added ABOVE a
		// two-digit adjacency mask — so every field must still demask to its own legal range. This
		// is the guard for exactly the class of bug the %16 demask was.
		ProvinceMask mask = ProvinceRaster.load().mask(dhenijansar().id());
		int classed = 0;
		for (int ly = 0; ly < mask.height(); ly++)
			for (int lx = 0; lx < mask.width(); lx++) {
				int code = mask.riverCode(lx, ly);
				if (code == 0) continue;
				int cls = (code / 100000) % 10, width = code % 10;
				int flow = (code / 10) % 10, node = (code / 100) % 10, adj = (code / 1000) % 100;
				assertTrue(cls >= 1 && cls <= 9, "render class 1..9 at (" + lx + "," + ly + "), got " + cls);
				assertTrue(width >= 1 && width <= 4, "authored width 1..4, got " + width);
				assertTrue(flow >= 0 && flow <= 8, "flow direction 0..8, got " + flow);
				assertTrue(node >= 0 && node <= 3, "node marker 0..3, got " + node);
				assertTrue(adj >= 0 && adj <= 15, "adjacency mask 0..15, got " + adj);
				assertTrue(cls >= width, "the class is floored by the authored width");
				classed++;
			}
		assertTrue(classed > 0, "Dhenijansar carries river cells to exercise the packing");
	}

	@Test
	void generationIsDeterministicPerSeed() throws Exception {
		Province dh = kaashesh();
		TerrainRegistry reg = TerrainRegistry.load();
		ProvinceRaster raster = ProvinceRaster.load();

		ProvincePlotField a = ProvincePlotField.generate(dh, reg, raster, new Rng(7));
		ProvincePlotField b = ProvincePlotField.generate(dh, reg, raster, new Rng(7));

		assertEquals(a.size(), b.size());
		for (int i = 0; i < a.size(); i++) {
			ProvincePlot pa = a.plots().get(i), pb = b.plots().get(i);
			assertEquals(pa.x(), pb.x());
			assertEquals(pa.y(), pb.y());
			assertSame(pa.plotType(), pb.plotType(), "same relief at " + i);
			assertEquals(pa.terrain().type(), pb.terrain().type(), "same terrain at " + i);
			assertEquals(featureType(pa), featureType(pb), "same feature at " + i);
			assertEquals(bonusType(pa), bonusType(pb), "same bonus at " + i);
		}
	}

	@Test
	void resourcesArePlacedOnlyWhereTheirConstraintsAllow() throws Exception {
		Province dh = kaashesh();
		TerrainRegistry reg = TerrainRegistry.load();
		ProvinceRaster raster = ProvinceRaster.load();

		// every placed bonus must satisfy its own placement constraints on its plot
		int placed = 0;
		for (int seed = 0; seed < 12; seed++) {
			ProvincePlotField field = ProvincePlotField.generate(dh, reg, raster, new Rng(seed));
			for (ProvincePlot p : field.plots())
				if (p.bonus() != null) {
					placed++;
					assertTrue(
							BonusGenerator.eligible(p.bonus(), p.terrain(), p.plotType(),
									p.feature(), dh.latitude()),
							p.bonus().type() + " placed on an ineligible plot");
				}
		}
		// a tropical coastal province has many eligible (jungle/lush) resources — some land
		assertTrue(placed > 0, "expected some resources placed across the seed sweep");
	}

	private static String bonusType(ProvincePlot p) {
		return p.bonus() == null ? "none" : p.bonus().type();
	}

	@Test
	void wastelandsCarryNoResources() throws Exception {
		// an IMPASSABLE province is barren wasteland worked by no one — the bonus stage is skipped
		// entirely, so no plot carries a resource (across a seed sweep, since placement is stochastic).
		Province waste = WorldMap.load().findByName("Ruby Mountains").orElseThrow();
		assertSame(ProvinceType.IMPASSABLE, waste.type(), "Ruby Mountains is a wasteland");
		TerrainRegistry reg = TerrainRegistry.load();
		ProvinceRaster raster = ProvinceRaster.load();
		for (int seed = 0; seed < 8; seed++)
			for (ProvincePlot p : ProvincePlotField.generate(waste, reg, raster, new Rng(seed)).plots())
				assertNull(p.bonus(), "wasteland plot carries a resource: " + bonusType(p));
	}

	/**
	 * The feature stage places <b>diverse, valid</b> features drawn from the real map:
	 * the tree class and the ground each imply a feature (forest/jungle/savanna/cactus/
	 * swamp/…), every one validity-gated against its plot's terrain & relief, plus
	 * river flood plains. Dhenijansar — real plains/grassland with a desert fringe,
	 * wooded and wet — grows more than one feature type, where the old single-climate
	 * kind gave only one.
	 */
	@Test
	void featureStagePlacesDiverseValidFeaturesAndFloodPlains() throws Exception {
		Province dh = kaashesh();
		ProvincePlotField field = ProvincePlotField.generate(
				dh, TerrainRegistry.load(), ProvinceRaster.load(), new Rng(3));

		Set<String> kinds = new HashSet<>();
		int featured = 0, flood = 0;
		for (ProvincePlot p : field.plots()) {
			if (p.feature() == null)
				continue;
			featured++;
			kinds.add(p.feature().type());
			// every placed feature must be a valid host of its plot's terrain & relief
			assertTrue(p.feature().validTerrains().contains(p.terrain().type()),
					p.feature().type() + " placed on invalid terrain " + p.terrain().type());
			if (p.feature().requiresFlatlands())
				assertEquals(PlotType.FLAT, p.plotType(),
						p.feature().type() + " requires flat ground");
			if ("FEATURE_FLOOD_PLAINS".equals(p.feature().type())) {
				flood++;
				assertTrue(p.river() && p.plotType() == PlotType.FLAT,
						"flood plains only on flat river plots");
			}
		}
		assertTrue(featured > 0, "expected some features placed");
		assertTrue(kinds.size() >= 2, "expected diverse features from the real map, got " + kinds);
		assertTrue(flood > 0, "expected flood plains on its flat river plots");
	}

	private static String featureType(ProvincePlot p) {
		return p.feature() == null ? "none" : p.feature().type();
	}

	@Test
	void reliefClustersRatherThanScattering() throws Exception {
		Province dh = kaashesh();
		ProvincePlotField field = ProvincePlotField.generate(
				dh, TerrainRegistry.load(), ProvinceRaster.load(), new Rng(1));

		// index plots by position to test neighbour adjacency
		Set<Long> hills = new HashSet<>();
		int hillCount = 0;
		for (ProvincePlot p : field.plots())
			if (p.plotType() == PlotType.HILL) {
				hills.add(key(p.x(), p.y()));
				hillCount++;
			}

		// with hills present, at least one hill should touch another (a chain) —
		// the C2C grow stage produces adjacency that independent draws would not
		int adjacentHills = 0;
		for (long k : hills) {
			int x = (int) (k >> 20), y = (int) (k & 0xFFFFF);
			for (int dx = -1; dx <= 1; dx++)
				for (int dy = -1; dy <= 1; dy++)
					if ((dx != 0 || dy != 0) && hills.contains(key(x + dx, y + dy))) {
						adjacentHills++;
					}
		}
		// only assert clustering when the province actually grew hills
		if (hillCount >= 4)
			assertTrue(adjacentHills > 0, "hills should cluster (got " + hillCount + " hills, none adjacent)");
	}

	private static long key(int x, int y) {
		return ((long) x << 20) | (y & 0xFFFFF);
	}

}
