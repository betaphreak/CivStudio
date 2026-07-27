package com.civstudio.geo.names;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.civstudio.geo.Province;
import com.civstudio.geo.Region;
import com.civstudio.geo.RegionEarthMap;
import com.civstudio.geo.TerrainRegistry;
import com.civstudio.geo.WorldMap;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.ProvincePlotStore;

/**
 * Bake-time pass that stamps real Earth place names onto the world's plots,
 * region by region, over the warmed plot cache.
 * <p>
 * For each mapped region it gathers that region's provinces' plots, computes the
 * region's {@link PixelBox pixel footprint}, and runs a {@link PlaceNamer} over
 * each province (position-preserving within the region box, unique within the
 * province). It is additive — it reads a province's plots from the cache, sets
 * names, and writes them back — so no map cache regeneration is required; a
 * partially-warmed cache simply names what is present.
 * <p>
 * Memory is bounded to one region's plots plus the pre-loaded gazetteers, since
 * regions are processed one at a time. The core ({@link #nameRegion} /
 * {@link #boxOf}) is pure and unit-tested; {@link #nameWorld} adds the cache IO.
 */
public final class PlaceNamingPass {

	private PlaceNamingPass() {
	}

	/** A province id paired with its (mutable) plots, so names can be written back. */
	public record ProvincePlots(int provinceId, List<Plot> plots) {
	}

	/**
	 * Name every land plot of one region's provinces in place — the largest-in-cell
	 * / nearest-unused / suffix rules of {@link PlaceNamer}, with a used-set reset
	 * per province. Plots with no raster position ({@code x < 0}) are left unnamed.
	 *
	 * @param box       the region's pixel footprint
	 * @param country   the gazetteer of the region's mapped Earth country
	 * @param provinces the region's provinces and their plots (mutated in place)
	 * @return the {@link PlaceNamer} used, carrying the region's unique/reused name tallies
	 */
	public static PlaceNamer nameRegion(PixelBox box, CountryGazetteer country, List<ProvincePlots> provinces) {
		PlaceNamer namer = new PlaceNamer(box, country);
		for (ProvincePlots pp : provinces) {
			namer.beginProvince();
			for (Plot p : pp.plots())
				if (p.x() >= 0)
					p.setPlaceName(namer.name(p.x(), p.y()));
		}
		return namer;
	}

	/**
	 * The pixel bounding box over a region's plots (positioned plots only).
	 *
	 * @throws IllegalStateException if no plot has a raster position
	 */
	public static PixelBox boxOf(List<ProvincePlots> provinces) {
		PixelBox.Builder b = new PixelBox.Builder();
		for (ProvincePlots pp : provinces)
			for (Plot p : pp.plots())
				if (p.x() >= 0)
					b.add(p.x(), p.y());
		return b.build();
	}

	/**
	 * Name the whole world from the warmed plot cache: for every mapped region,
	 * load its provinces' plots, name them, and save them back. Fail-fast on any
	 * unmapped live land region (via {@link RegionEarthMap#validateCoverage}).
	 *
	 * @param map        the world map
	 * @param registry   the terrain registry (to load/save plots)
	 * @param earth      the region→country mapping
	 * @param gazetteers per-country gazetteers (keys must cover {@code earth}'s
	 *                   countries)
	 * @return the number of provinces named
	 */
	public static int nameWorld(WorldMap map, TerrainRegistry registry, RegionEarthMap earth,
			Map<String, CountryGazetteer> gazetteers) {
		// fail-fast: every live land region must be mapped
		Set<String> landRegions = new HashSet<>();
		for (Province p : map.settleableProvinces())
			map.regionOf(p.id()).map(Region::rawKey).ifPresent(landRegions::add);
		earth.validateCoverage(landRegions);

		int provincesNamed = 0, regionsNamed = 0, emptyCountries = 0;
		long totalUnique = 0, totalReused = 0;
		for (Region region : map.regions()) {
			String iso = earth.countryOf(region.rawKey()).orElse(null);
			if (iso == null)
				continue; // ocean/unmapped region — no land plots to name
			CountryGazetteer country = gazetteers.get(iso);
			if (country == null || country.isEmpty()) {
				emptyCountries++;
				System.out.println("  WARN: no GeoNames places for " + iso + " ("
						+ region.rawKey() + ") — its plots stay nameless");
				continue;
			}
			List<ProvincePlots> provinces = new ArrayList<>();
			for (Province prov : map.provincesInRegion(region.rawKey())) {
				List<Plot> plots = ProvincePlotStore.load(prov.id(), registry);
				if (plots != null && !plots.isEmpty())
					provinces.add(new ProvincePlots(prov.id(), plots));
			}
			if (provinces.isEmpty())
				continue; // region not warmed in the cache yet
			PlaceNamer namer = nameRegion(boxOf(provinces), country, provinces);
			for (ProvincePlots pp : provinces) {
				ProvincePlotStore.saveKeepingEdge(pp.provinceId(), pp.plots());
				provincesNamed++;
			}
			regionsNamed++;
			totalUnique += namer.uniqueCount();
			totalReused += namer.reusedCount();
			// which Earth country named this region, and how well its place pool covered it: fresh
			// real names (unique) vs names recycled once the country ran out (reused, suffixed).
			int total = namer.uniqueCount() + namer.reusedCount();
			int reusePct = total == 0 ? 0 : (int) Math.round(100.0 * namer.reusedCount() / total);
			System.out.printf("  region %-26s → %-3s : %,7d unique, %,7d reused (%d%%), %d provinces%n",
					region.rawKey(), iso, namer.uniqueCount(), namer.reusedCount(), reusePct, provinces.size());
		}
		long totalNames = totalUnique + totalReused;
		int reusePct = totalNames == 0 ? 0 : (int) Math.round(100.0 * totalReused / totalNames);
		System.out.printf("  named %d provinces across %d regions: %,d names — %,d unique, %,d reused (%d%%)"
				+ " (%d countries had no places)%n",
				provincesNamed, regionsNamed, totalNames, totalUnique, totalReused, reusePct, emptyCountries);
		return provincesNamed;
	}
}
