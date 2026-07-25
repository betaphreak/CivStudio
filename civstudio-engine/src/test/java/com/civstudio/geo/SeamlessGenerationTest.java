package com.civstudio.geo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.ProvincePlotField.ProvincePlot;
import com.civstudio.util.Rng;
import com.civstudio.util.RngSeed;

/**
 * The province seam is gone: plot generation is a function of <b>world position</b>, not of which
 * province happens to be generating (see {@code docs/plot-generator.md} §Seamless generation).
 * <p>
 * Every one of these used to fail. Generation ran against a mask whose {@code isLand} meant "a
 * pixel of <em>this</em> province", so each stage treated a province border as ocean: the terrain
 * patch lattice and its displacement noise restarted in mask-local coordinates, the climate pool
 * stepped from one province's value to the next, de-speckling had no neighbours to smooth against,
 * peaks could neither seed nor grow within a pixel of the border, and the vegetation stage read
 * every border cell as coastline and seeded a ring of forest along the province outline.
 */
class SeamlessGenerationTest {

	// a cluster of adjacent land provinces — the seam only exists BETWEEN provinces, so every
	// check here needs neighbours generated alongside their neighbour
	private static List<Province> cluster(int size) {
		WorldMap map = WorldMap.load();
		Province seed = map.findByName("Kaashesh").orElseThrow();
		List<Province> out = new ArrayList<>();
		Set<Integer> seen = new HashSet<>();
		List<Integer> queue = new ArrayList<>(List.of(seed.id()));
		while (!queue.isEmpty() && out.size() < size) {
			int id = queue.remove(0);
			if (!seen.add(id))
				continue;
			Province p = map.province(id);
			if (p == null || p.type() != ProvinceType.LAND)
				continue;
			out.add(p);
			queue.addAll(p.neighbors());
		}
		return out;
	}

	private record Field(Map<Long, ProvincePlot> plots, Map<Long, Integer> owner) {

		static long key(int x, int y) {
			return ((long) x << 32) | (y & 0xFFFFFFFFL);
		}

		ProvincePlot at(int x, int y) {
			return plots.get(key(x, y));
		}

		Integer ownerAt(int x, int y) {
			return owner.get(key(x, y));
		}
	}

	private static Field generate(List<Province> provinces) throws Exception {
		TerrainRegistry registry = TerrainRegistry.load();
		ProvinceRaster raster = ProvinceRaster.load();
		RngSeed seed = new RngSeed(1);
		Map<Long, ProvincePlot> plots = new HashMap<>();
		Map<Long, Integer> owner = new HashMap<>();
		for (Province p : provinces) {
			Rng rng = seed.forProvinceCanonical(RngSeed.Stream.TERRAIN, p.id());
			for (ProvincePlot pp : ProvincePlotField.generate(p, registry, raster, rng).plots()) {
				plots.put(Field.key(pp.x(), pp.y()), pp);
				owner.put(Field.key(pp.x(), pp.y()), p.id());
			}
		}
		return new Field(plots, owner);
	}

	/** Walk every orthogonally adjacent plot pair, split by whether it crosses a province border. */
	private interface PairCheck {
		void accept(ProvincePlot a, ProvincePlot b, boolean crossesBorder);
	}

	private static void forEachAdjacentPair(Field f, PairCheck check) {
		for (Map.Entry<Long, Integer> e : f.owner().entrySet()) {
			int x = (int) (e.getKey() >> 32), y = (int) (long) e.getKey();
			for (int[] d : new int[][] { { 1, 0 }, { 0, 1 } }) {
				Integer nOwner = f.ownerAt(x + d[0], y + d[1]);
				if (nOwner == null)
					continue;
				check.accept(f.at(x, y), f.at(x + d[0], y + d[1]), !nOwner.equals(e.getValue()));
			}
		}
	}

	/**
	 * The headline invariant. Terrain changes no more often across a province border than it does
	 * between two plots of the same province — because the patch lattice and the climate field are
	 * both keyed on world position, so neither restarts at a border. The per-province generator
	 * scored ≈6× on this ratio over Anbennar's Lencenor; a ratio of 1 is a perfectly invisible seam.
	 * <p>
	 * The margin above 1 is left for the province types whose ground is a deliberate override with a
	 * genuinely sharp edge — the impassable wastelands, the caverns, and the special surface
	 * terrains (an ancient forest is <em>supposed</em> to stop at its own border).
	 */
	@Test
	void terrainDoesNotBreakAtProvinceBorders() throws Exception {
		Field f = generate(cluster(24));
		long[] cross = new long[2], inside = new long[2]; // {pairs, differing}
		forEachAdjacentPair(f, (a, b, crossesBorder) -> {
			long[] bucket = crossesBorder ? cross : inside;
			bucket[0]++;
			if (!a.terrain().type().equals(b.terrain().type()))
				bucket[1]++;
		});
		assertTrue(cross[0] > 200, "the cluster shares real borders: " + cross[0] + " crossing pairs");
		double crossRate = cross[1] / (double) cross[0], insideRate = inside[1] / (double) inside[0];
		assertTrue(crossRate < insideRate * 2.5,
				"terrain changes across a province border at a normal rate: cross " + crossRate
						+ " vs interior " + insideRate + " (seam score " + crossRate / insideRate + ")");
	}

	/**
	 * The relief stage refuses to seed or grow a peak next to a non-land cell, so with an
	 * own-pixels-only mask every province wore a <b>flat ring</b>: no plot within a pixel of a
	 * border could ever be a hill or a peak. With the halo the ranges run through the border.
	 */
	@Test
	void provinceBordersAreNotFlatRings() throws Exception {
		Field f = generate(cluster(24));
		int borderPlots = 0, borderRough = 0, interiorPlots = 0, interiorRough = 0;
		for (Map.Entry<Long, Integer> e : f.owner().entrySet()) {
			int x = (int) (e.getKey() >> 32), y = (int) (long) e.getKey();
			boolean onBorder = false;
			for (int[] d : new int[][] { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) {
				Integer nOwner = f.ownerAt(x + d[0], y + d[1]);
				if (nOwner != null && !nOwner.equals(e.getValue()))
					onBorder = true;
			}
			boolean rough = f.at(x, y).plotType() != PlotType.FLAT;
			if (onBorder) {
				borderPlots++;
				if (rough) borderRough++;
			} else {
				interiorPlots++;
				if (rough) interiorRough++;
			}
		}
		assertTrue(borderPlots > 100, "the cluster has border plots: " + borderPlots);
		double borderRate = borderRough / (double) borderPlots;
		double interiorRate = interiorRough / (double) interiorPlots;
		// measured over Anbennar's Lencenor: 0.78 of the interior rate before, 0.96 after
		assertTrue(borderRate > interiorRate * 0.88,
				"relief survives the border: " + borderRate + " rough on the border vs "
						+ interiorRate + " inside");
	}

	/**
	 * Vegetation seeds on the <b>real</b> coastline. Approximating "coastal" as "a neighbour outside
	 * this province" made every province outline a seed line, so border plots came out markedly more
	 * wooded than the interior — the province polygons were legible in the vegetation alone.
	 */
	@Test
	void vegetationDoesNotRingProvinceOutlines() throws Exception {
		Field f = generate(cluster(24));
		int borderPlots = 0, borderVeg = 0, interiorPlots = 0, interiorVeg = 0;
		for (Map.Entry<Long, Integer> e : f.owner().entrySet()) {
			int x = (int) (e.getKey() >> 32), y = (int) (long) e.getKey();
			boolean onBorder = false, onCoast = f.at(x, y).coast() != 0;
			for (int[] d : new int[][] { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) {
				Integer nOwner = f.ownerAt(x + d[0], y + d[1]);
				if (nOwner != null && !nOwner.equals(e.getValue()))
					onBorder = true;
			}
			if (onCoast)
				continue;   // a real coast legitimately seeds vegetation — measure inland only
			boolean wooded = f.at(x, y).feature() != null;
			if (onBorder) {
				borderPlots++;
				if (wooded) borderVeg++;
			} else {
				interiorPlots++;
				if (wooded) interiorVeg++;
			}
		}
		assertTrue(borderPlots > 100, "the cluster has inland border plots: " + borderPlots);
		double borderRate = borderVeg / (double) borderPlots;
		double interiorRate = interiorVeg / (double) interiorPlots;
		// measured over Anbennar's Lencenor: 1.99x the interior rate before, 0.97x after
		assertTrue(borderRate < interiorRate * 1.4,
				"no vegetation ring on the province outline: " + borderRate + " featured on the border vs "
						+ interiorRate + " inside");
	}

	/**
	 * The mask carries a halo of the <b>neighbouring</b> provinces' land, and still emits exactly its
	 * own pixels as plots — the two land senses that make the stages above work.
	 */
	@Test
	void theMaskCarriesNeighbouringLandButEmitsOnlyItsOwn() throws Exception {
		Province p = WorldMap.load().findByName("Kaashesh").orElseThrow();
		ProvinceMask mask = ProvinceRaster.load().mask(p.id());

		int own = 0, ground = 0;
		for (int y = 0; y < mask.height(); y++)
			for (int x = 0; x < mask.width(); x++) {
				if (mask.isLand(x, y)) {
					own++;
					assertTrue(mask.isGround(x, y), "own land is ground");
				}
				if (mask.isGround(x, y))
					ground++;
			}
		assertEquals(p.plots(), own, "own land cells == province.plots (the emission set)");
		assertTrue(ground > own, "the frame carries neighbouring land too: " + ground + " ground vs " + own + " own");
	}
}
