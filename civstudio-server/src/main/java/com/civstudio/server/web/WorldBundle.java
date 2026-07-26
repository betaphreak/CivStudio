package com.civstudio.server.web;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.GZIPOutputStream;

import com.civstudio.geo.Adjacency;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Assembles {@code window.BUNDLE} — the WorldMap's map/geo backbone the web viewer
 * (<a href="file:../../../../../../web/">web/</a>) loads at boot — and serves it from the
 * spectator server ({@code GET /api/bundle}, see {@link com.civstudio.server.http.FeedServer}).
 * <p>
 * This <b>replaces the old build-time {@code web/data.js}</b>. That file was a Node-built
 * ({@code web/build.mjs}) committed snapshot of the same data, which could silently drift from
 * the engine; making the server the single source of truth removes that drift. The bundle is a
 * pure function of committed map resources, so it is world- (not session-) level and cached once.
 * <p>
 * The bundle mixes two kinds of data, assembled here from two sources:
 * <ul>
 * <li><b>Engine-derived</b> — the ~2.2 MB bulk: {@code provinces} (core fields + polygon
 * {@code rings} + the curved label baseline {@code lab}), the geographic label tiers
 * {@code geo}, the {@code geoNames} crumb dictionaries, and {@code adjacencies}. Rebuilt here
 * from the committed raw resources ({@code /map/provinces.json}, {@code /map/borders.json},
 * {@code /map/adjacencies.json}, {@code /map/regions.json} / {@code superregions.json} /
 * {@code areas.json}) exactly as {@code build.mjs} did — reading the <em>raw</em> JSON (not the
 * typed {@link com.civstudio.geo.Province} layer) so the output is byte-parity with the old
 * {@code data.js} rather than drifting on enum defaults (e.g. {@code winter} NONE vs null).</li>
 * <li><b>Asset-coupled / art-derived</b> — the small remainder: the baked-asset descriptors
 * ({@code map}, {@code terrainTiles}, {@code river}, …), {@code terrainColors}/{@code seaBands},
 * {@code loading}, the {@code plotIndex} byte offsets into {@code plots.pack}, and the ring-less
 * provinces' cull {@code bboxes}. The server <em>cannot</em> regenerate these (they need the
 * Civ4 art and the plot grids, both absent from the server image), so {@code build.mjs} still
 * bakes them and emits {@code /map/web-asset-manifest.json}, which this class merges in.</li>
 * </ul>
 * The province rendering set matches {@code build.mjs}: every land-like province, plus the
 * SEA/LAKE provinces that generated a plot grid (i.e. that appear in {@code plotIndex}).
 */
public final class WorldBundle {

	private WorldBundle() {
	}

	private static final ObjectMapper MAPPER = new ObjectMapper();
	private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

	// the province types that ship and render as land (dry LAND + the four underground Dwarovar
	// types + the seven special Anbennar surface terrains) — mirrors web/build.mjs LANDLIKE and
	// docs/underworld.md. SEA/LAKE ship too, but only when they generated a plot grid.
	private static final Set<String> LANDLIKE = Set.of("LAND",
			"CAVERN", "DWARVEN_HOLD", "DWARVEN_HOLD_SURFACE", "DWARVEN_ROAD",
			"ANCIENT_FOREST", "GLADEWAY", "FEY_GLADEWAY", "BLOODGROVES", "MUSHROOM_FOREST",
			"SHADOW_SWAMP", "GLACIER");

	// continent raw_key -> Anbennar landmass display name; mirrors web/build.mjs CONTINENT_NAME
	// and Continent.java (both Americas are Aelantir and merge by name in the rollup). A plain
	// HashMap (not Map.of) so a null/absent continent key looks up to null instead of throwing.
	private static final Map<String, String> CONTINENT_NAME = new HashMap<>();
	static {
		CONTINENT_NAME.put("europe", "Cannor");
		CONTINENT_NAME.put("asia", "Haless");
		CONTINENT_NAME.put("africa", "Sarhal");
		CONTINENT_NAME.put("north_america", "Aelantir");
		CONTINENT_NAME.put("south_america", "Aelantir");
		CONTINENT_NAME.put("serpentspine", "Serpentspine");
		CONTINENT_NAME.put("oceania", "Hinuilands");
	}

	// realm raw_key -> display name, read straight from the engine's Realm enum (the single source of
	// truth) rather than re-listed here — the frontend gets its realm names from this dictionary and
	// never re-derives continent->realm, the fourth-copy trap docs/realms.md §Drift warning guards.
	private static final Map<String, String> REALM_NAME = new HashMap<>();
	static {
		for (com.civstudio.geo.Realm r : com.civstudio.geo.Realm.values())
			if (r.rawKey() != null) // NONE is an absent realm, not a named one
				REALM_NAME.put(r.rawKey(), r.displayName());
	}

	// cached serialized forms (the bundle is world-level and immutable per deploy)
	private static volatile byte[] jsonBytes;
	private static volatile byte[] gzipBytes;

	/** The assembled bundle as UTF-8 JSON, built once and cached. */
	public static byte[] json() {
		ensureCached();
		return jsonBytes;
	}

	/** The assembled bundle gzip-compressed, built once and cached (for {@code Accept-Encoding: gzip}). */
	public static byte[] gzip() {
		ensureCached();
		return gzipBytes;
	}

	private static synchronized void ensureCached() {
		if (jsonBytes != null)
			return;
		try {
			byte[] j = MAPPER.writeValueAsBytes(assemble());
			ByteArrayOutputStream bos = new ByteArrayOutputStream(j.length / 4);
			try (GZIPOutputStream gz = new GZIPOutputStream(bos)) {
				gz.write(j);
			}
			gzipBytes = bos.toByteArray();
			jsonBytes = j; // publish last: json() non-null guards both
		} catch (IOException e) {
			throw new UncheckedIOException("assembling the world bundle", e);
		}
	}

	/**
	 * Build the full bundle fresh from the committed resources (no caching). Exposed for tests
	 * (golden parity against the old {@code data.js}); the server uses {@link #json()}/{@link #gzip()}.
	 *
	 * @return the {@code window.BUNDLE} object as a Jackson tree
	 */
	public static ObjectNode assemble() {
		JsonNode manifest = load("/map/web-asset-manifest.json");
		JsonNode allProv = load("/map/provinces.json");
		JsonNode borders = load("/map/borders.json");
		JsonNode adjacenciesRaw = load("/map/adjacencies.json");

		// polygon outlines by id (null for the few provinces the border exporter skips)
		Map<Integer, JsonNode> ringsById = new HashMap<>();
		for (JsonNode b : borders)
			ringsById.put(b.get("id").asInt(), b.get("rings"));

		// Ship EVERY province. Plots are generated per-province on demand by the server
		// (GET /api/plots/{id}, docs/plot-serving.md), so there is no plot-presence gating any more:
		// the ~176 deep-ocean provinces with no shelf just yield an empty grid (open sea). `sub` is
		// the land-like subset the geographic label rollups run over.
		List<JsonNode> shipped = new ArrayList<>(allProv.size());
		List<JsonNode> sub = new ArrayList<>();
		Set<Integer> shippedIds = new HashSet<>();
		for (JsonNode p : allProv) {
			shipped.add(p);
			shippedIds.add(p.get("id").asInt());
			if (LANDLIKE.contains(p.get("type").asText()))
				sub.add(p);
		}

		JsonNode bboxes = manifest.get("bboxes");
		Map<Integer, double[]> latLon = new HashMap<>(); // rounded lat/lon, for the adjacency teleport test

		ArrayNode provinces = NODES.arrayNode(shipped.size());
		for (JsonNode p : shipped) {
			int id = p.get("id").asInt();
			double lat = round3(p.get("lat").asDouble());
			double lon = round3(p.get("lon").asDouble());
			latLon.put(id, new double[] { lat, lon });
			JsonNode rings = ringsById.get(id);

			ObjectNode o = NODES.objectNode();
			o.put("id", id);
			o.put("name", p.get("name").asText());
			o.put("lat", lat);
			o.put("lon", lon);
			o.put("plots", p.get("plots").asInt());
			o.put("waterPlots", p.hasNonNull("waterPlots") ? p.get("waterPlots").asInt() : 0);
			o.put("type", p.get("type").asText());
			// EU4 development (ADM+DIP+MIL) and the city flag drive the urban plot's city
			// sprite size and the city info panel (see docs/urban-plots.md)
			int dev = devOf(p, "base_tax") + devOf(p, "base_production") + devOf(p, "base_manpower");
			o.put("dev", dev);
			if (p.path("city").asBoolean(false))
				o.put("city", true);
			putKeyOrNull(o, "region", p, "region");
			putKeyOrNull(o, "area", p, "area");
			putKeyOrNull(o, "continent", p, "continent");
			putKeyOrNull(o, "realm", p, "realm");
			putKeyOrNull(o, "winter", p, "winter");
			ArrayNode nb = o.putArray("nb");
			if (p.hasNonNull("neighbors"))
				for (JsonNode n : p.get("neighbors"))
					if (shippedIds.contains(n.asInt()))
						nb.add(n.asInt());
			if (rings != null)
				o.set("rings", rings);
			else
				o.putNull("rings");
			ObjectNode lab = labelBaseline(rings);
			if (lab != null)
				o.set("lab", lab);
			else
				o.putNull("lab");
			if (bboxes != null && bboxes.has(String.valueOf(id)))
				o.set("bbox", bboxes.get(String.valueOf(id)));
			provinces.add(o);
		}

		// ---- geographic name dictionaries (from the committed hierarchy) ----
		Map<String, String> srNameByRegion = new HashMap<>(); // region key -> super-region display name
		Map<String, String> srKeyByRegion = new HashMap<>();  // region key -> super-region raw key
		for (JsonNode s : load("/map/superregions.json"))
			for (JsonNode rk : s.get("regions")) {
				srNameByRegion.put(rk.asText(), s.get("name").asText());
				srKeyByRegion.put(rk.asText(), s.get("key").asText());
			}
		Map<String, String> regionDisplayName = keyName(load("/map/regions.json"));
		Map<String, String> areaDisplayName = keyName(load("/map/areas.json"));

		// ---- geo: plot-weighted label-tier centroids over the land-like provinces ----
		ObjectNode geo = NODES.objectNode();
		geo.set("continents", rollupTier(sub, p -> CONTINENT_NAME.get(text(p, "continent"))));
		geo.set("superRegions", rollupTier(sub, p -> srNameByRegion.get(text(p, "region"))));
		geo.set("regions", rollupTier(sub, p -> regionDisplayName.get(text(p, "region"))));

		// ---- geoNames: the display-name dictionaries trimmed to the keys shipped provinces use ----
		Set<String> usedRegions = usedKeys(shipped, "region");
		Set<String> usedAreas = usedKeys(shipped, "area");
		Set<String> usedContinents = usedKeys(shipped, "continent");
		Set<String> usedRealms = usedKeys(shipped, "realm");
		ObjectNode geoNames = NODES.objectNode();
		geoNames.set("continent", pickKeys(CONTINENT_NAME, usedContinents));
		geoNames.set("realm", pickKeys(REALM_NAME, usedRealms));
		geoNames.set("region", pickKeys(regionDisplayName, usedRegions));
		geoNames.set("area", pickKeys(areaDisplayName, usedAreas));
		geoNames.set("superByRegion", pickKeys(srNameByRegion, usedRegions));
		geoNames.set("superKeyByRegion", pickKeys(srKeyByRegion, usedRegions));

		// ---- adjacencies: [from, to, type, teleport], both endpoints shipped ----
		// `teleport` is read from the row's source comment (Adjacency.teleporter()) — it is data, not
		// a distance guess. It used to be `gcKm > 800`, which was wrong in both directions: Anbennar's
		// gladeways sit close together, so it missed all 92 real teleporters while firing on four
		// ordinary long sea/canal links.
		ArrayNode adjacencies = NODES.arrayNode();
		for (JsonNode a : adjacenciesRaw) {
			int from = a.get("from").asInt(), to = a.get("to").asInt();
			if (!shippedIds.contains(from) || !shippedIds.contains(to))
				continue;
			String type = a.hasNonNull("type") ? a.get("type").asText() : "";
			String comment = a.hasNonNull("comment") ? a.get("comment").asText() : "";
			ArrayNode row = adjacencies.addArray();
			row.add(from);
			row.add(to);
			row.add(type);
			row.add(new Adjacency(from, to, type, comment).teleporter() ? 1 : 0);
		}

		// ---- assemble: engine-derived data + the asset descriptors merged from the manifest ----
		ObjectNode root = NODES.objectNode();
		ObjectNode meta = root.putObject("meta");
		meta.set("seed", manifest.get("seed"));
		root.set("provinces", provinces);
		// "fow" is the Civ6 fog-of-war art (docs/explorer-caravan.md §8) — baked and shipped ahead of
		// the RevealedMap that will consume it, so it is absent from an un-rebaked manifest and simply
		// arrives null (nothing renders it yet).
		for (String k : List.of("map", "realms", "terrainColors", "terrainLayer", "terrainTiles", "river",
				"sea", "shore", "ice", "bonusIcons", "trees", "routes", "featureOverlays", "improvementOverlays",
				"districtTiles", "fow", "seaBands", "beach", "foam", "loading"))
			root.set(k, manifest.get(k));
		root.set("geo", geo);
		root.set("adjacencies", adjacencies);
		root.set("geoNames", geoNames);
		// the map version — the plot-generation version of the imported world. The client appends it
		// to /api/plots/{id}?v= so a generation change busts the (now immutable) browser cache; MCP
		// (get_map_version) and API consumers read the same value. See ProvincePlotStore.MAP_VERSION.
		root.put("mapVersion", com.civstudio.settlement.ProvincePlotStore.MAP_VERSION);
		return root;
	}

	// ------------------------------------------------------------------ helpers

	private static JsonNode load(String resource) {
		try (InputStream in = com.civstudio.data.WorldSources.current().open(resource)) {
			if (in == null)
				throw new IllegalStateException("bundle resource not found on classpath: " + resource
						+ (resource.endsWith("web-asset-manifest.json")
								? " (run `node web/build.mjs` to generate it)" : ""));
			return MAPPER.readTree(in);
		} catch (IOException e) {
			throw new UncheckedIOException("reading " + resource, e);
		}
	}

	// raw string field, or null when absent/null (mirrors build.mjs `p.field || null`)
	private static String text(JsonNode p, String field) {
		return p.hasNonNull(field) ? p.get(field).asText() : null;
	}

	private static void putKeyOrNull(ObjectNode o, String out, JsonNode p, String field) {
		if (p.hasNonNull(field))
			o.put(out, p.get(field).asText());
		else
			o.putNull(out);
	}

	// one development component (base_tax/base_production/base_manpower), 0 if absent
	private static int devOf(JsonNode p, String field) {
		return p.hasNonNull(field) ? p.get(field).asInt() : 0;
	}

	private static Map<String, String> keyName(JsonNode list) {
		Map<String, String> m = new HashMap<>();
		for (JsonNode e : list)
			m.put(e.get("key").asText(), e.get("name").asText());
		return m;
	}

	private static Set<String> usedKeys(List<JsonNode> provs, String field) {
		Set<String> s = new HashSet<>();
		for (JsonNode p : provs)
			if (p.hasNonNull(field))
				s.add(p.get(field).asText());
		return s;
	}

	// {k: src[k]} for the requested keys that resolve to a value (build.mjs pickKeys)
	private static ObjectNode pickKeys(Map<String, String> src, Set<String> keys) {
		ObjectNode o = NODES.objectNode();
		for (String k : keys) {
			String v = src.get(k);
			if (v != null)
				o.put(k, v);
		}
		return o;
	}

	// round to 3 decimals as web/build.mjs's `+x.toFixed(3)` does (inputs are pre-rounded map
	// coordinates / plot-weighted means, so ties are not a practical concern)
	private static double round3(double v) {
		return Math.round(v * 1000.0) / 1000.0;
	}

	/** Names a shipped province gets bucketed under for a label tier, or null to skip it. */
	private interface TierName {
		String of(JsonNode province);
	}

	// plot-weighted lon/lat centroid of the land-like provinces a nameFn buckets together, sorted
	// largest-first (label priority). Mirrors web/build.mjs rollupTier.
	private static ArrayNode rollupTier(List<JsonNode> landlike, TierName nameFn) {
		Map<String, double[]> acc = new LinkedHashMap<>(); // name -> {sx, sy, w}
		for (JsonNode p : landlike) {
			String name = nameFn.of(p);
			if (name == null)
				continue;
			double w = p.has("plots") ? Math.max(0, p.get("plots").asInt()) : 0;
			if (w == 0)
				w = 1; // build.mjs `p.plots || 1`
			double[] a = acc.computeIfAbsent(name, k -> new double[3]);
			a[0] += p.get("lon").asDouble() * w;
			a[1] += p.get("lat").asDouble() * w;
			a[2] += w;
		}
		List<Map.Entry<String, double[]>> entries = new ArrayList<>(acc.entrySet());
		entries.sort((x, y) -> Double.compare(y.getValue()[2], x.getValue()[2]));
		ArrayNode out = NODES.arrayNode(entries.size());
		for (Map.Entry<String, double[]> e : entries) {
			double[] a = e.getValue();
			ObjectNode t = out.addObject();
			t.put("name", e.getKey());
			t.put("lon", round3(a[0] / a[2]));
			t.put("lat", round3(a[1] / a[2]));
			t.put("w", (long) a[2]);
		}
		return out;
	}

	// ----------------------------------------------------- label baseline (medial spine)

	/**
	 * The curved spine a province name is laid along — a faithful Java port of
	 * {@code web/build.mjs labelBaseline}: scanline-rasterise the polygon interior, take its
	 * principal (PCA) axis, bin the interior along that axis and take each bin's mean
	 * perpendicular offset as a spine point, and ship the smoothed spine only when it actually
	 * bends (a straight/convex province is served identically by the client's own principal-axis
	 * fallback). Returns {@code {t: <thickness px>, p: [[x,y],…]}} in source pixels, or null.
	 * <p>
	 * Transcendental-function results can differ from V8 in the last ULP, so a handful of
	 * provinces near the rounding or the "does it bend" cutoff may land ±1px or flip null vs a
	 * baseline; the client falls back to the straight axis when null, so either is fine.
	 */
	private static ObjectNode labelBaseline(JsonNode rings) {
		if (rings == null || rings.isNull() || rings.size() == 0)
			return null;
		double x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
		List<double[]> edges = new ArrayList<>(); // [ax, ay, bx, by]
		for (JsonNode ring : rings) {
			int m = ring.size();
			for (int i = 0; i < m; i++) {
				JsonNode a = ring.get(i), b = ring.get((i + 1) % m);
				double ax = a.get(0).asDouble(), ay = a.get(1).asDouble();
				double bx = b.get(0).asDouble(), by = b.get(1).asDouble();
				edges.add(new double[] { ax, ay, bx, by });
				if (ax < x0) x0 = ax;
				if (ax > x1) x1 = ax;
				if (ay < y0) y0 = ay;
				if (ay > y1) y1 = ay;
			}
		}
		double W = x1 - x0, H = y1 - y0;
		if (W < 3 || H < 3)
			return null;
		double step = Math.max(1, Math.round(Math.max(W, H) / 110.0)); // ~110 samples across the long side

		// scanline fill (even-odd) -> interior sample points
		List<double[]> pts = new ArrayList<>();
		for (double y = y0 + step / 2; y < y1; y += step) {
			List<Double> xs = new ArrayList<>();
			for (double[] e : edges) {
				double ay = e[1], by = e[3];
				if ((ay <= y) != (by <= y))
					xs.add(e[0] + (y - ay) / (by - ay) * (e[2] - e[0]));
			}
			xs.sort(Double::compare);
			for (int i = 0; i + 1 < xs.size(); i += 2)
				for (double x = xs.get(i) + step / 2; x < xs.get(i + 1); x += step)
					pts.add(new double[] { x, y });
		}
		int n = pts.size();
		if (n < 8)
			return null;

		// PCA over the interior samples -> principal direction u, perpendicular v
		double cx = 0, cy = 0;
		for (double[] q : pts) {
			cx += q[0];
			cy += q[1];
		}
		cx /= n;
		cy /= n;
		double sxx = 0, syy = 0, sxy = 0;
		for (double[] q : pts) {
			double dx = q[0] - cx, dy = q[1] - cy;
			sxx += dx * dx;
			syy += dy * dy;
			sxy += dx * dy;
		}
		double ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
		double ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;

		// bin the interior by axis coordinate t; each bin's mean perpendicular s is a spine point
		double tmin = 1e9, tmax = -1e9;
		double[] T = new double[n];
		for (int i = 0; i < n; i++) {
			double t = (pts.get(i)[0] - cx) * ux + (pts.get(i)[1] - cy) * uy;
			T[i] = t;
			if (t < tmin) tmin = t;
			if (t > tmax) tmax = t;
		}
		int K = 8;
		double span = (tmax - tmin) != 0 ? (tmax - tmin) : 1;
		double[] sum = new double[K], smin = new double[K], smax = new double[K];
		int[] cnt = new int[K];
		java.util.Arrays.fill(smin, 1e9);
		java.util.Arrays.fill(smax, -1e9);
		for (int i = 0; i < n; i++) {
			int k = Math.max(0, Math.min(K - 1, (int) Math.floor((T[i] - tmin) / span * K)));
			double s = (pts.get(i)[0] - cx) * vx + (pts.get(i)[1] - cy) * vy;
			sum[k] += s;
			cnt[k]++;
			if (s < smin[k]) smin[k] = s;
			if (s > smax[k]) smax[k] = s;
		}
		Double[] mean = new Double[K];
		List<Double> widths = new ArrayList<>();
		for (int k = 0; k < K; k++)
			if (cnt[k] > 0) {
				mean[k] = sum[k] / cnt[k];
				widths.add(smax[k] - smin[k]);
			} else {
				mean[k] = null;
			}
		if (widths.size() < 2)
			return null;

		// smooth the spine (moving average over filled bins) -> one control point per filled bin
		List<int[]> out = new ArrayList<>();
		for (int k = 0; k < K; k++) {
			if (mean[k] == null)
				continue;
			double acc = 0;
			int m = 0;
			for (int d = -1; d <= 1; d++) {
				int kk = k + d;
				if (kk >= 0 && kk < K && mean[kk] != null) {
					acc += mean[kk];
					m++;
				}
			}
			double s = acc / m, t = tmin + (k + 0.5) / K * span;
			out.add(new int[] { (int) Math.round(cx + t * ux + s * vx), (int) Math.round(cy + t * uy + s * vy) });
		}
		if (out.size() < 2)
			return null;
		widths.sort(Double::compare);
		double thick = widths.get(widths.size() >> 1); // thickness = median slice width

		// only ship a curved baseline when the spine actually bends (max deviation of the spine
		// from its end-to-end chord >= ~a fifth of the width); else the client's straight-axis
		// fallback serves it identically.
		int[] a = out.get(0), b = out.get(out.size() - 1);
		double cl = Math.hypot(b[0] - a[0], b[1] - a[1]);
		if (cl == 0)
			cl = 1;
		double maxDev = 0;
		for (int i = 1; i < out.size() - 1; i++) {
			double d = Math.abs((b[0] - a[0]) * (double) (a[1] - out.get(i)[1])
					- (a[0] - out.get(i)[0]) * (double) (b[1] - a[1])) / cl;
			if (d > maxDev)
				maxDev = d;
		}
		if (maxDev < thick * 0.22)
			return null;

		ObjectNode result = NODES.objectNode();
		result.put("t", (int) Math.round(thick));
		ArrayNode p = result.putArray("p");
		for (int[] pt : out) {
			ArrayNode pair = p.addArray();
			pair.add(pt[0]);
			pair.add(pt[1]);
		}
		return result;
	}
}
