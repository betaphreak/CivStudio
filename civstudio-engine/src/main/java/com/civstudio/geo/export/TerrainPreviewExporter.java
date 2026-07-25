package com.civstudio.geo.export;

import java.awt.image.BufferedImage;
import java.io.File;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

import javax.imageio.ImageIO;

import com.civstudio.geo.Province;
import com.civstudio.geo.ProvincePlotField;
import com.civstudio.geo.ProvincePlotField.ProvincePlot;
import com.civstudio.geo.ProvinceRaster;
import com.civstudio.geo.ProvinceType;
import com.civstudio.geo.TerrainRegistry;
import com.civstudio.geo.WorldMap;
import com.civstudio.util.Rng;
import com.civstudio.util.RngSeed;

/**
 * Dev tool: render the generated plot field of a <b>region</b> straight to a PNG, so terrain
 * generation can be eyeballed (and diffed) without a full-world rebake, a server, or the web
 * viewer. This is the check that catches <b>province seams</b> — a discontinuity at a border is
 * obvious in a region render and invisible in a single-province test.
 *
 * <pre>
 * mvn -q -pl civstudio-engine compile exec:exec \
 *   -Dsim.main=com.civstudio.geo.export.TerrainPreviewExporter -Dexec.args="lencenor_region out.png"
 * </pre>
 *
 * Arguments: {@code <region-or-superregion-key> <output.png> [scale]}. Every land province of the
 * region is generated (canonical, seed-independent stream — the same field the cache holds) and
 * painted at 1 plot = {@code scale} pixels, coloured by terrain; the console reports the terrain
 * mix and the <b>seam score</b> (see {@link #seamScore}).
 */
public final class TerrainPreviewExporter {

	private TerrainPreviewExporter() {
	}

	public static void main(String[] args) throws Exception {
		String regionKey = args.length > 0 ? args[0] : "lencenor_region";
		File out = new File(args.length > 1 ? args[1] : "terrain-preview.png");
		int scale = args.length > 2 ? Integer.parseInt(args[2]) : 2;

		WorldMap map = WorldMap.load();
		TerrainRegistry registry = TerrainRegistry.load();
		ProvinceRaster raster = ProvinceRaster.load();
		RngSeed seed = new RngSeed(1);

		java.util.List<Province> region = map.provinces().stream()
				.filter(p -> regionKey.equals(p.regionKey()) || regionKey.equals(p.areaKey())
						|| regionKey.equals(superRegionOf(map, p)))
				.filter(p -> p.type() != ProvinceType.SEA && p.type() != ProvinceType.LAKE)
				.toList();
		if (region.isEmpty())
			throw new IllegalArgumentException("no land provinces for '" + regionKey + "'");
		System.out.println("rendering " + region.size() + " provinces of " + regionKey + "...");

		// one pass to size the canvas, one to paint
		int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE, maxX = 0, maxY = 0;
		Map<Integer, java.util.List<ProvincePlot>> fields = new HashMap<>();
		Map<Long, String> terrainAt = new HashMap<>();   // packed (x,y) -> terrain, for the seam score
		Map<String, Integer> mix = new TreeMap<>();
		long t0 = System.currentTimeMillis();
		for (Province p : region) {
			Rng rng = seed.forProvinceCanonical(RngSeed.Stream.TERRAIN, p.id());
			ProvincePlotField field = ProvincePlotField.generate(p, registry, raster, rng);
			fields.put(p.id(), field.plots());
			for (ProvincePlot pp : field.plots()) {
				minX = Math.min(minX, pp.x());
				maxX = Math.max(maxX, pp.x());
				minY = Math.min(minY, pp.y());
				maxY = Math.max(maxY, pp.y());
				terrainAt.put(((long) pp.x() << 32) | (pp.y() & 0xFFFFFFFFL), pp.terrain().type());
				mix.merge(pp.terrain().type(), 1, Integer::sum);
			}
		}
		System.out.printf("generated in %.1fs%n", (System.currentTimeMillis() - t0) / 1000.0);

		int w = (maxX - minX + 1) * scale, h = (maxY - minY + 1) * scale;
		BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
		for (java.util.List<ProvincePlot> plots : fields.values())
			for (ProvincePlot pp : plots) {
				int rgb = color(pp.terrain().type(), pp.plotType().name(),
						pp.feature() == null ? null : pp.feature().type());
				for (int dy = 0; dy < scale; dy++)
					for (int dx = 0; dx < scale; dx++)
						img.setRGB((pp.x() - minX) * scale + dx, (pp.y() - minY) * scale + dy, rgb);
			}
		ImageIO.write(img, "png", out);

		int total = mix.values().stream().mapToInt(Integer::intValue).sum();
		System.out.println("wrote " + out + " (" + w + "x" + h + ", " + total + " plots)");
		mix.entrySet().stream()
				.sorted((a, b) -> b.getValue() - a.getValue())
				.limit(12)
				.forEach(e -> System.out.printf("  %-26s %6d  %4.1f%%%n",
						e.getKey(), e.getValue(), 100.0 * e.getValue() / total));
		double cold = mix.entrySet().stream()
				.filter(e -> e.getKey().equals("TERRAIN_PERMAFROST") || e.getKey().equals("TERRAIN_TUNDRA")
						|| e.getKey().equals("TERRAIN_TAIGA"))
				.mapToInt(Map.Entry::getValue).sum();
		System.out.printf("cold ground (taiga+tundra+permafrost): %.1f%%%n", 100.0 * cold / total);
		System.out.printf("seam score: %.4f (border mismatch / interior mismatch; 1.0 = seamless)%n",
				seamScore(fields, terrainAt));
		borderProfile(fields);
	}

	/**
	 * Border-vs-interior rates for the two artifacts a province-local mask produces beyond the
	 * terrain seam: a <b>flat ring</b> (the relief stage cannot seed or grow a peak next to a cell
	 * it reads as ocean) and a <b>vegetation ring</b> (the feature stage reads every border cell as
	 * coastline and seeds there). Both ratios should sit near 1.
	 */
	private static void borderProfile(Map<Integer, java.util.List<ProvincePlot>> fields) {
		Map<Long, Integer> ownerAt = new HashMap<>();
		Map<Long, ProvincePlot> plotAt = new HashMap<>();
		for (Map.Entry<Integer, java.util.List<ProvincePlot>> e : fields.entrySet())
			for (ProvincePlot pp : e.getValue()) {
				long k = ((long) pp.x() << 32) | (pp.y() & 0xFFFFFFFFL);
				ownerAt.put(k, e.getKey());
				plotAt.put(k, pp);
			}
		int[] bPeak = new int[2], iPeak = new int[2], bVeg = new int[2], iVeg = new int[2];
		for (Map.Entry<Long, Integer> e : ownerAt.entrySet()) {
			int x = (int) (e.getKey() >> 32), y = (int) (long) e.getKey();
			boolean onBorder = false;
			for (int[] d : new int[][] { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) {
				Integer n = ownerAt.get(((long) (x + d[0]) << 32) | ((y + d[1]) & 0xFFFFFFFFL));
				if (n != null && !n.equals(e.getValue()))
					onBorder = true;
			}
			ProvincePlot pp = plotAt.get(e.getKey());
			int[] peak = onBorder ? bPeak : iPeak, veg = onBorder ? bVeg : iVeg;
			peak[0]++;
			if (pp.plotType() != com.civstudio.geo.PlotType.FLAT)
				peak[1]++;
			if (pp.coast() == 0) {   // inland only — a real coast legitimately seeds vegetation
				veg[0]++;
				if (pp.feature() != null)
					veg[1]++;
			}
		}
		System.out.printf("border relief:     %.3f on border vs %.3f inside  (ratio %.2f, 1.0 = no flat ring)%n",
				rate(bPeak), rate(iPeak), rate(bPeak) / rate(iPeak));
		System.out.printf("border vegetation: %.3f on border vs %.3f inside  (ratio %.2f, 1.0 = no green ring)%n",
				rate(bVeg), rate(iVeg), rate(bVeg) / rate(iVeg));
	}

	private static double rate(int[] pair) {
		return pair[0] == 0 ? 0 : pair[1] / (double) pair[0];
	}

	/**
	 * How much more often terrain changes <b>across a province border</b> than it does between two
	 * plots of the same province. Both are measured over orthogonally adjacent plot pairs, so the
	 * ratio is 1.0 when generation is genuinely seamless and rises the harder the seam is (the
	 * per-province generator scored ≈2–3× because the patch lattice, the noise field and the
	 * climate pool all restarted at every border).
	 */
	private static double seamScore(Map<Integer, java.util.List<ProvincePlot>> fields, Map<Long, String> terrainAt) {
		Map<Long, Integer> ownerAt = new HashMap<>();
		for (Map.Entry<Integer, java.util.List<ProvincePlot>> e : fields.entrySet())
			for (ProvincePlot pp : e.getValue())
				ownerAt.put(((long) pp.x() << 32) | (pp.y() & 0xFFFFFFFFL), e.getKey());
		long sameProv = 0, sameProvDiff = 0, crossProv = 0, crossProvDiff = 0;
		for (Map.Entry<Long, Integer> e : ownerAt.entrySet()) {
			int x = (int) (e.getKey() >> 32), y = (int) (long) e.getKey();
			for (int[] d : new int[][] { { 1, 0 }, { 0, 1 } }) {
				long nk = ((long) (x + d[0]) << 32) | ((y + d[1]) & 0xFFFFFFFFL);
				Integer nOwner = ownerAt.get(nk);
				if (nOwner == null)
					continue;
				boolean differs = !terrainAt.get(e.getKey()).equals(terrainAt.get(nk));
				if (nOwner.equals(e.getValue())) {
					sameProv++;
					if (differs) sameProvDiff++;
				} else {
					crossProv++;
					if (differs) crossProvDiff++;
				}
			}
		}
		if (sameProv == 0 || crossProv == 0 || sameProvDiff == 0)
			return Double.NaN;
		return (crossProvDiff / (double) crossProv) / (sameProvDiff / (double) sameProv);
	}

	private static String superRegionOf(WorldMap map, Province p) {
		return map.superRegionOf(p.id()).map(sr -> sr.rawKey()).orElse(null);
	}

	// a rough terrain palette — enough to read biomes and spot a seam
	private static int color(String terrain, String relief, String feature) {
		int base = switch (terrain) {
			case "TERRAIN_GRASSLAND" -> 0x5C8A3C;
			case "TERRAIN_LUSH" -> 0x3F8A26;
			case "TERRAIN_MUDDY" -> 0x6E7A44;
			case "TERRAIN_PLAINS" -> 0x9AA45A;
			case "TERRAIN_BARREN" -> 0xB0A87A;
			case "TERRAIN_ROCKY" -> 0x8C8272;
			case "TERRAIN_JAGGED" -> 0x6E6458;
			case "TERRAIN_MARSH" -> 0x4E6B4A;
			case "TERRAIN_DESERT" -> 0xD9C27E;
			case "TERRAIN_DUNES" -> 0xE0CE92;
			case "TERRAIN_SALT_FLATS" -> 0xEDE6CE;
			case "TERRAIN_SCRUB" -> 0xBCB070;
			case "TERRAIN_BADLAND" -> 0xB08050;
			case "TERRAIN_TAIGA" -> 0x4A6B58;
			case "TERRAIN_TUNDRA" -> 0x9AA8A0;
			case "TERRAIN_PERMAFROST" -> 0xE8EEF2;      // the "snow" this change is about
			case "TERRAIN_GLACIER" -> 0xD2E8F4;
			case "TERRAIN_CAVERN" -> 0x3A3038;
			case "TERRAIN_COAST", "TERRAIN_COAST_TROPICAL" -> 0x3E7A9C;
			case "TERRAIN_COAST_POLAR" -> 0x8FB6C8;
			case "TERRAIN_SEA", "TERRAIN_SEA_TROPICAL" -> 0x27567A;
			case "TERRAIN_SEA_POLAR" -> 0x7AA0B4;
			case "TERRAIN_LAKE", "TERRAIN_LAKE_SHORE" -> 0x3A7FA8;
			default -> 0x7A6E86;                        // the special/fey terrains
		};
		if ("FEATURE_FOREST".equals(feature) || "FEATURE_JUNGLE".equals(feature))
			base = blend(base, 0x24501E, 0.45);         // vegetation darkens the ground
		if ("FEATURE_ICE".equals(feature))
			base = blend(base, 0xFFFFFF, 0.7);
		if ("PEAK".equals(relief))
			base = blend(base, 0x2A2622, 0.55);
		else if ("HILL".equals(relief))
			base = blend(base, 0x2A2622, 0.22);
		return base;
	}

	private static int blend(int a, int b, double t) {
		int r = (int) (((a >> 16) & 0xFF) * (1 - t) + ((b >> 16) & 0xFF) * t);
		int g = (int) (((a >> 8) & 0xFF) * (1 - t) + ((b >> 8) & 0xFF) * t);
		int bl = (int) ((a & 0xFF) * (1 - t) + (b & 0xFF) * t);
		return (r << 16) | (g << 8) | bl;
	}
}
