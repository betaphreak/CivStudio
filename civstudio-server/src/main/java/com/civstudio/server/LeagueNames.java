package com.civstudio.server;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.civstudio.settlement.GameSession;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.ProvincePlotPool;

/**
 * Names for the cities of a league — taken from the <b>real place names its province's plots already
 * carry</b>, not invented.
 * <p>
 * Every land plot is stamped with a GeoNames place name at bake time ({@code
 * docs/plot-place-naming.md}), which the web already shows on hover. A league's vassal cities are
 * named for the localities they grew out of, which is how a conurbation's quarters get their names
 * in the first place — Nathalaire's Fish Island and Smugglersbay are the same idea, and where a
 * specific authored name is wanted, the settlement store's name overrides supply it
 * ({@code docs/towngen-port.md} §3a.1).
 * <p>
 * Names are drawn <b>spread across the province</b> rather than in raster order, so a league's
 * cities are not all named after one corner of it, and the pick is deterministic: same province,
 * same seed, same names.
 */
public final class LeagueNames {

	private LeagueNames() {
	}

	/**
	 * A name dispenser for a league founding across several provinces — one name per city, drawn
	 * from the province that city stands in, and never the same name twice.
	 *
	 * @param session     the session
	 * @param provinceIds the provinces the league may found into
	 * @return the dispenser
	 */
	public static Pool pool(GameSession session, List<Integer> provinceIds) {
		return new Pool(session, provinceIds);
	}

	/**
	 * Hands out city names, one province at a time. Names are resolved lazily, because a province's
	 * plot pool does not exist until something claims in it.
	 */
	public static final class Pool {

		private final GameSession session;
		private final java.util.Map<Integer, java.util.Deque<String>> byProvince =
				new java.util.LinkedHashMap<>();
		private final Set<String> used = new LinkedHashSet<>();
		private int served;

		private Pool(GameSession session, List<Integer> provinceIds) {
			this.session = session;
			for (int id : provinceIds) {
				byProvince.put(id, new java.util.ArrayDeque<>());
			}
		}

		/**
		 * The next unused name for a city founding in {@code provinceId}.
		 *
		 * @param provinceId where the city stands
		 * @return a place name from that province, or a numbered fallback when the map has none left
		 */
		public String next(int provinceId) {
			java.util.Deque<String> queue = byProvince.computeIfAbsent(provinceId,
					k -> new java.util.ArrayDeque<>());
			if (queue.isEmpty()) {
				ProvincePlotPool pool = session.plotPoolIfPresent(provinceId);
				if (pool != null) {
					for (String name : placeNames(pool, 16)) {
						if (!used.contains(name)) {
							queue.add(name);
						}
					}
				}
			}
			served++;
			String name = queue.poll();
			if (name == null || !used.add(name)) {
				com.civstudio.geo.Province p = session.getWorldMap().province(provinceId);
				name = (p == null ? "Quarter" : p.name()) + " " + served;
				used.add(name);
			}
			return name;
		}
	}

	/**
	 * Up to {@code count} distinct place names, spread over the province: the plots are ordered by
	 * distance from the province's centroid and sampled at a stride, so the names come from all
	 * over rather than from one corner.
	 */
	private static List<String> placeNames(ProvincePlotPool pool, int count) {
		List<Plot> plots = new ArrayList<>(pool.plots());
		int cx = pool.centroidX(), cy = pool.centroidY();
		plots.sort(Comparator
				.comparingLong((Plot p) -> (long) (p.x() - cx) * (p.x() - cx)
						+ (long) (p.y() - cy) * (p.y() - cy))
				.thenComparingInt(Plot::y).thenComparingInt(Plot::x));
		Set<String> seen = new LinkedHashSet<>();
		int stride = Math.max(1, plots.size() / Math.max(1, count));
		for (int pass = 0; pass < stride && seen.size() < count; pass++) {
			for (int i = pass; i < plots.size() && seen.size() < count; i += stride) {
				String name = plots.get(i).placeName();
				if (name != null && !name.isBlank()) {
					seen.add(name);
				}
			}
		}
		return List.copyOf(seen);
	}
}
