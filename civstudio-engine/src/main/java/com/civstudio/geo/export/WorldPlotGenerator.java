package com.civstudio.geo.export;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.civstudio.data.GeoNamesFiles;
import com.civstudio.geo.Province;
import com.civstudio.geo.ProvincePlotField;
import com.civstudio.geo.ProvincePlotField.ProvincePlot;
import com.civstudio.geo.ProvinceRaster;
import com.civstudio.geo.RegionEarthMap;
import com.civstudio.geo.TerrainRegistry;
import com.civstudio.geo.WorldMap;
import com.civstudio.geo.names.CountryGazetteer;
import com.civstudio.geo.names.GeoNamesGazetteer;
import com.civstudio.geo.names.GeoNamesSubset;
import com.civstudio.geo.names.PlaceNamingPass;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.ProvincePlotStore;
import com.civstudio.util.Rng;
import com.civstudio.util.RngSeed;

/**
 * Dev tool: generate and persist the plot field of <b>every settleable land
 * province</b> into the shared plot cache ({@code .map/v<MAP_VERSION>/<id>.json.gz} by
 * default — the same cache the sim and the server's {@code PlotService} share), pre-warming
 * per-plot terrain for the whole world (not just the caravan-visited crop). The fields
 * are canonical/seed-independent (the {@linkplain RngSeed#forProvinceCanonical terrain
 * stream is seed-independent}), so this equals what any run would generate on demand;
 * it just pre-warms the whole map at once. Skips provinces already persisted. Run:
 *
 * <pre>
 * mvn -q compile exec:exec -Dsim.main=com.civstudio.geo.export.WorldPlotGenerator
 * pwsh tools/run.ps1 WorldPlotGenerator                          # same, but takes arguments
 * pwsh tools/run.ps1 WorldPlotGenerator lencenor_region          # bake ONE region (seconds)
 * </pre>
 *
 * <b>The region filter is the local feedback loop.</b> Baking the world takes minutes and writes
 * ~5000 files; when you are iterating on generation you want to look at <em>one</em> place in the
 * real viewer, not a PNG. Naming an area / region / super-region bakes just that slice into the
 * same versioned cache dir, so {@code tools/dev-local.ps1} serves it immediately. Because
 * generation is a pure function of world position and the province's own canonical stream (see
 * {@code docs/plot-generator.md} §Seamless generation), a slice baked this way is byte-identical to
 * the same provinces in a full-world bake — it is a prefix of the same work, not an approximation.
 * The place-naming pass runs only on a full bake (it is a whole-world pass over the region map).
 * <p>
 * The generated caches are large (hundreds of MB) and regenerable, so they are
 * gitignored — this tool is how a clone rebuilds them for the world map.
 */
public final class WorldPlotGenerator {

	private WorldPlotGenerator() {
	}

	public static void main(String[] args) throws Exception {
		WorldMap map = WorldMap.load();
		TerrainRegistry registry = TerrainRegistry.load();
		ProvinceRaster raster = ProvinceRaster.load();
		RngSeed rngSeed = new RngSeed(1); // canonical stream is seed-independent
		// the MAP_VERSION-versioned dir the store reads from — a generation bump warms a fresh dir
		File dir = ProvincePlotStore.writeDir();
		dir.mkdirs();

		// every non-RNW province: LAND + IMPASSABLE wasteland grow a land field, SEA/LAKE grow a
		// coastal-shelf water field (ProvincePlotField branches on type). RNW/Unused are already
		// dropped upstream (not in the WorldMap). A deep-ocean province with no shelf yields an
		// empty field and is not written (the web keeps drawing it as the open-sea ripple).
		String scope = args.length > 0 && !args[0].isBlank() ? args[0] : null;
		java.util.Collection<Province> all = scope == null ? map.provinces() : select(map, scope);
		if (scope != null) {
			if (all.isEmpty())
				throw new IllegalArgumentException("no provinces for '" + scope
						+ "' — expected an area / region / super-region raw_key (e.g. lencenor_region)");
			System.out.println("scope '" + scope + "' -> " + all.size() + " provinces (partial bake:"
					+ " no place-naming pass; re-run without a scope for the full world)");
		}
		int total = all.size(), gen = 0, skip = 0, empty = 0, fail = 0;
		long t0 = System.currentTimeMillis();
		System.out.println("generating plot fields for " + total + " provinces (land + coastal shelf)...");
		for (Province p : all) {
			if (new File(dir, p.id() + ".json.gz").exists()) {
				skip++;
				continue;
			}
			try {
				Rng rng = rngSeed.forProvinceCanonical(RngSeed.Stream.TERRAIN, p.id());
				ProvincePlotField field = ProvincePlotField.generate(p, registry, raster, rng);
				if (field.size() == 0) { // deep-water province with no coastal shelf — nothing to store
					empty++;
					continue;
				}
				List<Plot> plots = new ArrayList<>(field.size());
				for (ProvincePlot pp : field.plots()) {
					Plot plot = new Plot(pp.geo(), pp.terrain(), pp.plotType(), pp.feature(), pp.bonus());
					plot.setUrban(pp.urban());   // built-up overlay on natural terrain (retired TERRAIN_URBAN)
					plots.add(plot);
				}
				ProvincePlotStore.save(p.id(), plots, field.edge());
				gen++;
				if (gen % 200 == 0)
					System.out.printf("  generated %d (skipped %d, empty %d) of %d, %ds elapsed%n",
							gen, skip, empty, total, (System.currentTimeMillis() - t0) / 1000);
			} catch (Exception e) {
				fail++;
				if (fail <= 20)
					System.out.println("  skip province " + p.id() + ": " + e.getMessage());
			}
		}
		System.out.printf("done: %d generated, %d already present, %d empty (no shelf), %d failed, of %d provinces in %ds%n",
				gen, skip, empty, fail, total, (System.currentTimeMillis() - t0) / 1000);

		// The place-naming pass is a WHOLE-WORLD pass (it walks the region→country map and names by
		// region), so it only makes sense on a full bake. A scoped bake is for looking at terrain in
		// the viewer; its plots come out nameless, which the hover simply omits.
		if (scope == null)
			nameWorld(map, registry);
		else
			System.out.println("scoped bake: skipping the place-naming pass (whole-world only) —"
					+ " these plots will have no place names");
	}

	/**
	 * The provinces named by a scope: an <b>area</b>, <b>region</b> or <b>super-region</b>
	 * {@code raw_key}, or a comma-separated list of province ids. Matched in that order, so the
	 * unambiguous Anbennar keys work directly ({@code lencenor_region},
	 * {@code western_cannor_superregion}, {@code venail_area}).
	 */
	private static java.util.List<Province> select(WorldMap map, String scope) {
		if (scope.matches("\\d+(,\\d+)*")) {
			java.util.List<Province> byId = new ArrayList<>();
			for (String id : scope.split(","))
				byId.add(map.province(Integer.parseInt(id)));
			byId.removeIf(java.util.Objects::isNull);
			return byId;
		}
		return map.provinces().stream()
				.filter(p -> scope.equals(p.areaKey()) || scope.equals(p.regionKey())
						|| map.superRegionOf(p.id()).map(sr -> scope.equals(sr.rawKey())).orElse(false))
				.toList();
	}

	/**
	 * Stamp real Earth place names onto the warmed plot cache (see {@link PlaceNamingPass}). Additive
	 * over whatever is present, so it runs after generation with no cache regeneration. Skipped — with
	 * a note — when the GeoNames dump is absent, so a clone without it still gets a working (nameless)
	 * plot cache.
	 */
	private static void nameWorld(WorldMap map, TerrainRegistry registry) throws Exception {
		long t0 = System.currentTimeMillis();
		RegionEarthMap earth = RegionEarthMap.load();
		Set<String> countries = new HashSet<>(earth.countries());

		// Prefer the committed ~4 MB subset (GeoNamesSubset) — it ships in the jar, so ANY machine can
		// bake names (prod, CI, a fresh clone). The 372 MB full dump is only the fallback, used when the
		// subset resource is absent (e.g. re-baking the subset itself); if neither is present, skip.
		Map<String, CountryGazetteer> gazetteers;
		if (GeoNamesSubset.isAvailable()) {
			gazetteers = GeoNamesSubset.load(countries);
			System.out.println("naming plots: loaded the committed GeoNames subset for " + countries.size()
					+ " countries (" + GeoNamesSubset.RESOURCE + ")");
		} else if (GeoNamesFiles.isAvailable()) {
			System.out.println("naming plots: no committed subset — loading gazetteers for " + countries.size()
					+ " countries from the full dump (one pass)...");
			gazetteers = GeoNamesGazetteer.loadFromCache(countries);
		} else {
			System.out.println("GeoNames subset not on the classpath and no dump in "
					+ GeoNamesFiles.cacheDir().toAbsolutePath() + " — skipping plot naming (plots stay"
					+ " nameless). Build the subset with GeoNamesSubsetExporter, or see GeoNamesFiles.");
			return;
		}
		long places = gazetteers.values().stream().mapToLong(CountryGazetteer::size).sum();
		System.out.printf("  loaded %,d places across %d countries in %ds; naming by region...%n",
				places, gazetteers.size(), (System.currentTimeMillis() - t0) / 1000);
		int named = PlaceNamingPass.nameWorld(map, registry, earth, gazetteers);
		System.out.printf("naming done: %d provinces named in %ds%n",
				named, (System.currentTimeMillis() - t0) / 1000);
	}
}
