package com.civstudio.geo.export;

import com.civstudio.data.Exports;

import java.io.File;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.civstudio.geo.Continent;
import com.civstudio.geo.Realm;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * Dev tool: resolves each province's {@link Realm} and stamps it onto {@code
 * map/provinces.json} as the {@code realm} key ({@link com.civstudio.geo.Province#realm()}).
 * Unlike its sibling stampers ({@link ProvinceHistoryExporter} et al.) it reads no external
 * source — realm is a <b>pure function of the already-exported map</b>, so this re-reads and
 * re-writes the committed {@code provinces.json} in place. Runs at the <em>end</em> of the stamp
 * chain (after {@link ContinentExporter} and the Phase 0 portal whitelist), since it depends on
 * every province's {@code continent} and {@code neighbors} already being present:
 *
 * <pre>
 * mvn -pl civstudio-engine compile exec:exec -Dsim.main=com.civstudio.geo.export.RealmExporter
 * </pre>
 *
 * <h2>The four resolution rules (docs/realms.md §The model)</h2>
 * <ol>
 * <li><b>Quirks → {@link Realm#NONE}.</b> Three provinces are dropped from their realm: the two
 *     antimeridian projection artifacts (the Toreiels) and the Antarctic ice shelf (Ekyunimoy).
 *     They have continents, so this override comes first.</li>
 * <li><b>Land → by {@link Continent}.</b> Any non-water province: {@link
 *     Realm#fromContinent(Continent)} (both Americas → Aelantir, {@code oceania} → Hinuilands, the
 *     rest → Halcann; a continent-less land province → {@link Realm#NONE}).</li>
 * <li><b>Water → adjacent land.</b> A {@code SEA}/{@code LAKE} province takes the realm of the
 *     non-water land it touches. Assigned by adjacency, never by continent (≈50 sea/lake provinces
 *     carry a continent and must be ignored). The data has <b>zero conflicts</b> — no water province
 *     touches land in more than one realm — which this exporter asserts.</li>
 * <li><b>Deep ocean → {@link Realm#NONE}.</b> Water that touches no land (99 provinces) → fog.</li>
 * </ol>
 *
 * <p>Plus an <b>assertion</b> (not a rule): the Phase 0 portal waypoints ({@link #PORTAL_WAYPOINTS})
 * must resolve to {@link Realm#HALCANN} and agree with their adjacency endpoints — the guess an
 * earlier design draft made a fourth rule out of, kept here as the cheap check it should have been.
 */
public final class RealmExporter {

	private static final String PROVINCES = "civstudio-engine/target/generated/map/provinces.json";

	/**
	 * The three deliberate quirks dropped from their realm (docs/realms.md §Three quirk provinces):
	 * 6237/6238 = South/North Toreiel (antimeridian projection artifacts), 1808 = Ekyunimoy (the
	 * Antarctic ice shelf). They have continents but belong to no realm.
	 */
	private static final Set<Integer> QUIRKS = Set.of(6237, 6238, 1808);

	/**
	 * Phase 0 portal waypoints — placeholder-named hubs Anbennar uses as teleporter anchors. Rule 2
	 * lands them in Halcann via their {@code europe} continent; the assertion below checks their
	 * adjacency endpoints agree.
	 */
	private static final Set<Integer> PORTAL_WAYPOINTS = Set.of(7025, 7027, 7030, 7033);

	private final ObjectMapper mapper = new ObjectMapper();

	public static void main(String[] args) throws Exception {
		new RealmExporter().stamp();
	}

	private void stamp() throws Exception {
		File file = Exports.outFile(PROVINCES);
		List<Map<String, Object>> rows = mapper.readValue(file,
				new TypeReference<List<Map<String, Object>>>() {
				});

		Map<Integer, Map<String, Object>> byId = new HashMap<>();
		for (Map<String, Object> row : rows)
			byId.put(id(row), row);

		Map<Integer, Realm> realm = resolve(rows, byId);

		// rebuild each row, dropping any stale realm and re-inserting it right after "continent"
		List<Map<String, Object>> out = new ArrayList<>(rows.size());
		for (Map<String, Object> row : rows) {
			String key = realm.get(id(row)).rawKey(); // null for NONE — an absent realm
			Map<String, Object> rebuilt = new LinkedHashMap<>();
			boolean placed = false;
			for (Map.Entry<String, Object> e : row.entrySet()) {
				if (e.getKey().equals("realm"))
					continue; // drop any stale value; re-added in the canonical slot
				rebuilt.put(e.getKey(), e.getValue());
				if (e.getKey().equals("continent")) {
					rebuilt.put("realm", key);
					placed = true;
				}
			}
			if (!placed) // no continent key (shouldn't happen) — append at end
				rebuilt.put("realm", key);
			out.add(rebuilt);
		}

		mapper.writerWithDefaultPrettyPrinter().writeValue(file, out);
		report(realm, byId, file);
	}

	private Map<Integer, Realm> resolve(List<Map<String, Object>> rows,
			Map<Integer, Map<String, Object>> byId) {
		Map<Integer, Realm> realm = new HashMap<>();

		// pass 1 — quirks → NONE, all non-water land → by continent
		for (Map<String, Object> row : rows) {
			int id = id(row);
			if (QUIRKS.contains(id)) {
				realm.put(id, Realm.NONE);
				continue;
			}
			if (isWater(row))
				continue; // resolved in pass 2
			realm.put(id, Realm.fromContinent(Continent.fromKey((String) row.get("continent"))));
		}

		// pass 2 — water → the realm of the non-water land it touches (0 → deep ocean, 1 → that
		// realm, ≥2 → conflict). Depends only on pass 1, so no fixpoint is needed.
		int conflicts = 0;
		for (Map<String, Object> row : rows) {
			int id = id(row);
			if (QUIRKS.contains(id) || !isWater(row))
				continue;
			EnumSet<Realm> touched = EnumSet.noneOf(Realm.class);
			for (int nb : neighbors(row)) {
				Map<String, Object> n = byId.get(nb);
				if (n == null || isWater(n) || QUIRKS.contains(nb))
					continue;
				Realm r = realm.get(nb);
				if (r != null && r != Realm.NONE)
					touched.add(r);
			}
			if (touched.size() == 1) {
				realm.put(id, touched.iterator().next());
			} else {
				realm.put(id, Realm.NONE);
				if (touched.size() > 1) {
					conflicts++;
					System.out.println("  WATER CONFLICT " + id + " " + row.get("name") + " " + touched);
				}
			}
		}
		if (conflicts != 0)
			throw new IllegalStateException(conflicts + " water provinces touch more than one realm"
					+ " — the partition is not clean (docs/realms.md §The ocean splits cleanly)");

		// pass 3 — LAKES that rule 3 could not place, by NEAREST LAND.
		//
		// Rule 4 sends water touching no land to NONE, and for open ocean that is the whole point.
		// For a LAKE it is simply wrong: a lake is enclosed by land by definition, so it is never
		// "deep ocean", and a realm-less province is dropped from every realm view — no polygon, no
		// plots, an invisible hole in the map. Eight lakes were in that state, and the failure is
		// silent, which is how one of them (6762 Humacs Island, in the Gulf of Ouord) survived
		// unnoticed until someone looked hard at that coastline.
		//
		// They fail rule 3 for two different reasons, and neither is recoverable from adjacency:
		// three (1884 Taspasu, 6068 Elsine, 6087 Isles of Dha) have an EMPTY neighbour list, and the
		// rest touch exactly one SEA and no land at all — two of those a deep-ocean sea that is
		// itself NONE. So this falls back to geometry, which is always available: the nearest land
		// province by great-circle-ish lat/lon distance. For a lake that is the land enclosing it.
		//
		// LAKES ONLY, deliberately. Applying the same fallback to SEA would give every deep-ocean
		// province a realm and pull ~2.7M plots into views that currently skip them — rule 4 exists
		// to prevent exactly that.
		for (Map<String, Object> row : rows) {
			int id = id(row);
			if (!"LAKE".equals(row.get("type")) || realm.get(id) != Realm.NONE || QUIRKS.contains(id))
				continue;
			int best = -1;
			double bestD = Double.MAX_VALUE;
			for (Map<String, Object> cand : rows) {
				if (isWater(cand))
					continue;
				Realm r = realm.get(id(cand));
				if (r == null || r == Realm.NONE)
					continue;
				double d = dist2(row, cand);
				// ties break on the lower id, so the stamp is stable across runs
				if (d < bestD || (d == bestD && id(cand) < best)) {
					bestD = d;
					best = id(cand);
				}
			}
			if (best < 0)
				throw new IllegalStateException("lake " + id + " " + row.get("name")
						+ " has no land province to inherit a realm from");
			realm.put(id, realm.get(best));
			System.out.printf("  LAKE %d %s → %s (nearest land %d %s, %.2f°)%n", id, row.get("name"),
					realm.get(best), best, byId.get(best).get("name"), Math.sqrt(bestD));
		}
		// every lake now belongs somewhere — the invariant this pass exists to establish
		for (Map<String, Object> row : rows)
			if ("LAKE".equals(row.get("type")) && realm.get(id(row)) == Realm.NONE)
				throw new IllegalStateException("lake " + id(row) + " " + row.get("name")
						+ " is still realm-less — it would be invisible in every realm view");

		// assertion — portal waypoints resolve to Halcann and agree with their endpoints
		for (int id : PORTAL_WAYPOINTS) {
			Map<String, Object> row = byId.get(id);
			if (row == null)
				continue;
			Realm r = realm.get(id);
			if (r != Realm.HALCANN)
				throw new IllegalStateException("portal waypoint " + id + " resolved to " + r
						+ ", expected HALCANN (docs/realms.md §The model)");
			for (int nb : neighbors(row)) {
				Realm nr = realm.get(nb);
				if (nr != null && nr != Realm.NONE && nr != r)
					throw new IllegalStateException("portal waypoint " + id + " realm " + r
							+ " disagrees with endpoint " + nb + " realm " + nr);
			}
		}
		return realm;
	}

	private void report(Map<Integer, Realm> realm, Map<Integer, Map<String, Object>> byId, File file) {
		Map<Realm, int[]> tally = new HashMap<>(); // [land, water]
		for (Realm r : Realm.values())
			tally.put(r, new int[2]);
		for (Map.Entry<Integer, Realm> e : realm.entrySet())
			tally.get(e.getValue())[isWater(byId.get(e.getKey())) ? 1 : 0]++;
		System.out.println("stamped realm onto " + realm.size() + " provinces in " + file.getAbsolutePath());
		for (Realm r : Realm.values()) {
			int[] t = tally.get(r);
			System.out.printf("  %-10s land %4d  water %4d  total %4d%n", r, t[0], t[1], t[0] + t[1]);
		}
	}

	private static int id(Map<String, Object> row) {
		return ((Number) row.get("id")).intValue();
	}

	/**
	 * Squared angular distance between two provinces' centres, with the longitude difference taken
	 * the short way round. Squared because only the ORDER matters here, and no realm boundary is
	 * anywhere near tight enough for the flat-earth approximation to pick the wrong continent.
	 */
	private static double dist2(Map<String, Object> a, Map<String, Object> b) {
		double dLat = num(a, "lat") - num(b, "lat");
		double dLon = Math.abs(num(a, "lon") - num(b, "lon"));
		if (dLon > 180)
			dLon = 360 - dLon;
		return dLat * dLat + dLon * dLon;
	}

	private static double num(Map<String, Object> row, String key) {
		Object v = row.get(key);
		return v instanceof Number n ? n.doubleValue() : 0;
	}

	private static boolean isWater(Map<String, Object> row) {
		Object t = row == null ? null : row.get("type");
		return "SEA".equals(t) || "LAKE".equals(t);
	}

	@SuppressWarnings("unchecked")
	private static List<Integer> neighbors(Map<String, Object> row) {
		Object nb = row.get("neighbors");
		if (!(nb instanceof List<?> list))
			return List.of();
		List<Integer> out = new ArrayList<>(list.size());
		for (Object o : list)
			out.add(((Number) o).intValue());
		return out;
	}
}
