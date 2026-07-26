package com.civstudio.geo.export;

import com.civstudio.data.AnbennarFiles;
import com.civstudio.data.Exports;

import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.imageio.ImageIO;

import com.civstudio.geo.Adjacency;
import com.civstudio.geo.ProvinceType;
import tools.jackson.databind.ObjectMapper;

/**
 * Dev tool: exports the base {@code map/provinces.json} resource the core {@link
 * com.civstudio.geo.WorldMap} loads, reading the Anbennar EU4 map sources
 * committed under {@code data/} directly — no database. This keeps the running
 * simulation free of any database dependency: the export is a build-time/manual
 * step whose output is committed (the core never reads Postgres, and as of this
 * tool the export does not either).
 * <p>
 * It does a single pass over the two rasters:
 * <ul>
 * <li>{@code data/anbennar/provinces.bmp} (24-bit, one colour per province) — per-colour
 * pixel count ({@code plots}), bounding box (for the {@code lat}/{@code lon}
 * projection), and the colour-adjacency graph;</li>
 * <li>{@code data/anbennar/rivers.bmp} (a non-white pixel marks water) — per-colour water
 * pixel count ({@code waterPlots}).</li>
 * </ul>
 * resolving colours to province ids and names from {@code data/anbennar/definition.csv}
 * (skipping {@code RNW}/{@code Unused} placeholders) and {@code SEA}/{@code LAKE}
 * classification from {@code data/anbennar/default.map}. {@code latitude} is the
 * inverse-Mercator of the bounding-box vertical centre; {@code longitude} is a
 * linear map of the horizontal centroid over the global x extent. The
 * colour-adjacency graph is mapped to {@code province_id}s and materialized
 * symmetrically (it is already symmetric, being built from undirected pixel
 * neighbours).
 * <p>
 * The emitted rows carry the field set/order {@code id, name, lat, lon, plots,
 * waterPlots, type, region:null, area:null, neighbors} — the {@code region}/{@code
 * area} placeholders are filled in by {@link AreaExporter}, and {@code
 * continent}/{@code climate}/{@code winter}/{@code monsoon} are inserted by the
 * {@link ContinentExporter}/{@link ClimateExporter}, which run after this. Run via:
 *
 * <pre>
 * mvn compile exec:exec -Dsim.main=com.civstudio.geo.export.ProvinceExporter
 * </pre>
 *
 * then re-run the downstream stamp chain ({@link RegionExporter} &rarr; {@link
 * SuperRegionExporter} &rarr; {@link AreaExporter} &rarr; {@link
 * ContinentExporter} &rarr; {@link ClimateExporter}) to rebuild the full
 * resource. See {@code docs/geography.md}.
 */
public final class ProvinceExporter {

	private static final String DEFINITIONS = "map/definition.csv";
	private static final String DEFAULT_MAP = "map/default.map";
	private static final String PROVINCES_BMP = "map/provinces.bmp";
	private static final String RIVERS_BMP = "map/rivers.bmp";
	private static final String OUTPUT = "civstudio-engine/target/generated/map/provinces.json";

	/** Paradox uses pure white for a non-river pixel on {@code rivers.bmp}. */
	private static final int RIVER_NONE = 0xFFFFFF;

	/**
	 * Auto-placeholder name the Anbennar source gives an unnamed/unused province
	 * ({@code "Anbennar<id>"}). These are not real places — the prior Strapi
	 * pipeline excluded them, and every named province is kept — so they are
	 * dropped here too (alongside the {@code RNW}/{@code Unused} prefixes).
	 */
	private static final Pattern PLACEHOLDER_NAME = Pattern.compile("Anbennar\\d+");

	/** Anbennar's adjacency table, read here only to whitelist teleporter waypoints. */
	private static final String ADJACENCIES = "map/adjacencies.csv";

	/**
	 * The authored name given to a restored teleporter waypoint, suffixed {@code 1..N} in
	 * ascending id order. Deliberately not a GeoNames draw like every other land province
	 * ({@code docs/plot-place-naming.md}): a real Earth place name would be a lie here —
	 * this is space inside the portal, not a place on the map.
	 */
	private static final String WAYPOINT_NAME = "Portal ";

	private ProvinceExporter() {
	}

	public static void main(String[] args) throws Exception {
		Map<Integer, Def> defs = loadDefinitions(teleporterEndpoints());
		Set<Integer> seaIds = new HashSet<>();
		Set<Integer> lakeIds = new HashSet<>();
		loadTypes(seaIds, lakeIds);

		List<Map<String, Object>> rows = scanRaster(defs, seaIds, lakeIds);

		ObjectMapper mapper = new ObjectMapper();
		File out = Exports.outFile(OUTPUT);
		mapper.writerWithDefaultPrettyPrinter().writeValue(out, rows);
		System.out.println("wrote " + rows.size() + " provinces to " + out.getAbsolutePath());
	}

	/** A province colour's id/name/rgb, parsed from {@code definition.csv}. */
	private record Def(int id, String name, int color) {
	}

	/**
	 * The province ids referenced by a <b>teleporter</b> adjacency row (@link
	 * Adjacency#teleporter()} — the Deepwoods gladeway mesh, the fey portals and the
	 * Domandrod seasonal gates). Parsed straight from Anbennar's CSV rather than from the
	 * generated {@code adjacencies.json}, so this exporter keeps no ordering dependency on
	 * {@link AdjacencyExporter} (which reads <em>this</em> exporter's output).
	 */
	private static Set<Integer> teleporterEndpoints() throws Exception {
		Set<Integer> ids = new HashSet<>();
		for (String raw : Files.readAllLines(AnbennarFiles.get(ADJACENCIES))) {
			String line = raw.trim();
			if (line.isEmpty() || line.startsWith("#") || line.startsWith("-1"))
				continue;
			String[] f = line.split(";", -1);
			if (f.length < 9 || !f[0].matches("-?\\d+") || !f[1].matches("-?\\d+"))
				continue;
			if (new Adjacency(0, 0, "", f[8].trim()).teleporter()) {
				ids.add(Integer.parseInt(f[0]));
				ids.add(Integer.parseInt(f[1]));
			}
		}
		return ids;
	}

	/**
	 * Parse {@code definition.csv} into a colour&rarr;{@link Def} map, skipping
	 * {@code RNW}/{@code Unused} placeholder rows. The CSV is {@code
	 * id;r;g;b;Name_#hex;...}; the colour key is {@code (r<<16)|(g<<8)|b}.
	 * <p>
	 * <b>Except teleporter waypoints.</b> Anbennar uses placeholder-<em>named</em> provinces
	 * as functional gladeway hubs — the name is filler, the role is not — so a row whose id
	 * appears in {@code teleporters} is kept despite its name and given an authored {@code
	 * Portal N}. Without this the name filter silently severs the portal graph: four ids
	 * (7025/7027/7030/7033) are dropped and 41 of the 92 teleporter rows lose an endpoint.
	 * The whitelist is deliberately narrow — loosening the name filter itself would drag in
	 * all ~1400 RNW/unnamed-ocean placeholders.
	 */
	private static Map<Integer, Def> loadDefinitions(Set<Integer> teleporters) throws Exception {
		Map<Integer, Def> defs = new HashMap<>();
		Map<Integer, Def> waypoints = new TreeMap<>();   // id-ordered, so Portal N is deterministic
		try (BufferedReader br = new BufferedReader(new InputStreamReader(
				Files.newInputStream(AnbennarFiles.get(DEFINITIONS)), StandardCharsets.UTF_8))) {
			br.readLine(); // header
			String line;
			while ((line = br.readLine()) != null) {
				line = line.trim();
				if (line.isEmpty() || line.startsWith("#"))
					continue;
				String[] parts = line.split(";", -1);
				if (parts.length < 5)
					continue;
				try {
					int id = Integer.parseInt(parts[0].trim());
					int r = Integer.parseInt(parts[1].trim());
					int g = Integer.parseInt(parts[2].trim());
					int b = Integer.parseInt(parts[3].trim());
					int color = (r << 16) | (g << 8) | b;
					String rawName = parts[4].trim();
					boolean placeholder = rawName.startsWith("RNW") || rawName.startsWith("Unused");
					String name = rawName.split("_#")[0].replace('_', ' ').trim();
					placeholder |= PLACEHOLDER_NAME.matcher(name).matches();
					if (placeholder) {
						if (teleporters.contains(id))
							waypoints.put(id, new Def(id, null, color));   // named below, in id order
						continue;   // an unnamed/unused placeholder province
					}
					defs.put(color, new Def(id, name, color));
				} catch (NumberFormatException ignored) {
					// malformed line — skip
				}
			}
		}
		int n = 0;
		for (Def d : waypoints.values()) {
			Def named = new Def(d.id(), WAYPOINT_NAME + (++n), d.color());
			defs.put(d.color(), named);
			System.out.println("restored teleporter waypoint " + d.id() + " as " + named.name());
		}
		return defs;
	}

	/**
	 * Parse {@code default.map} for the {@code sea_starts} and {@code lakes}
	 * province-id blocks (every other province is {@code LAND}). Blocks may span
	 * many lines; ids are collected while inside a block and the block resets on
	 * its closing brace.
	 */
	private static void loadTypes(Set<Integer> seaIds, Set<Integer> lakeIds) throws Exception {
		Pattern id = Pattern.compile("\\d+");
		try (InputStream in = Files.newInputStream(AnbennarFiles.get(DEFAULT_MAP));
				BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
			String line;
			Set<Integer> current = null;
			while ((line = br.readLine()) != null) {
				int hash = line.indexOf('#');
				if (hash != -1)
					line = line.substring(0, hash);
				line = line.trim();
				if (line.isEmpty())
					continue;
				if (line.contains("sea_starts"))
					current = seaIds;
				else if (line.contains("lakes"))
					current = lakeIds;
				if (current != null) {
					Matcher m = id.matcher(line);
					while (m.find())
						current.add(Integer.parseInt(m.group()));
				}
				if (line.contains("}"))
					current = null;
			}
		}
	}

	/**
	 * Single pass over the two rasters: accumulate per-province pixel/water counts,
	 * bounding box and colour adjacency, then finalize each province with pixels
	 * into an output row (sorted by id). Provinces in {@code definition.csv} that
	 * never appear on the map (0 pixels) are dropped.
	 */
	private static List<Map<String, Object>> scanRaster(
			Map<Integer, Def> defs, Set<Integer> seaIds, Set<Integer> lakeIds) throws Exception {
		BufferedImage img = ImageIO.read(AnbennarFiles.get(PROVINCES_BMP).toFile());
		BufferedImage rImg = ImageIO.read(AnbennarFiles.get(RIVERS_BMP).toFile());
		int w = img.getWidth();
		int h = img.getHeight();
		if (w != rImg.getWidth() || h != rImg.getHeight())
			throw new IllegalStateException("province/river raster dimensions differ");

		int[] pixels = img.getRGB(0, 0, w, h, null, 0, w);
		img = null; // release before the second large array
		int[] river = rImg.getRGB(0, 0, w, h, null, 0, w);
		rImg = null;
		// terrain.bmp's palette INDICES, to corroborate the flooding auto-correct (see classify).
		// Optional: absent → the auto-correct is disabled rather than run on the river mask alone.
		int[] terrain = loadTerrainIndices(w, h);

		Map<Integer, Acc> acc = new HashMap<>();
		Map<Integer, Set<Integer>> colorAdj = new HashMap<>();

		for (int y = 0; y < h; y++) {
			for (int x = 0; x < w; x++) {
				int i = y * w + x;
				int color = pixels[i] & 0xFFFFFF;
				Def def = defs.get(color);
				if (def == null)
					continue;
				Acc a = acc.computeIfAbsent(color, k -> new Acc());
				a.pixels++;
				if ((river[i] & 0xFFFFFF) != RIVER_NONE)
					a.water++;
				if (terrain != null && !OCEAN_TERRAIN.contains(terrain[i]))
					a.dryTerrain++;
				if (x < a.minX)
					a.minX = x;
				if (x > a.maxX)
					a.maxX = x;
				if (y < a.minY)
					a.minY = y;
				if (y > a.maxY)
					a.maxY = y;
				if (x < w - 1) {
					int right = pixels[i + 1] & 0xFFFFFF;
					if (right != color)
						registerAdjacency(colorAdj, color, right);
				}
				if (y < h - 1) {
					int bottom = pixels[i + w] & 0xFFFFFF;
					if (bottom != color)
						registerAdjacency(colorAdj, color, bottom);
				}
			}
		}

		// global x extent over all provinces with pixels, for the longitude map
		long xmin = Long.MAX_VALUE;
		long xmax = Long.MIN_VALUE;
		for (Map.Entry<Integer, Acc> e : acc.entrySet()) {
			xmin = Math.min(xmin, e.getValue().minX);
			xmax = Math.max(xmax, e.getValue().maxX);
		}

		// id -> colour, so adjacency (kept by colour) can be mapped to province ids
		Map<Integer, Integer> colorById = new HashMap<>();
		for (Map.Entry<Integer, Acc> e : acc.entrySet())
			colorById.put(defs.get(e.getKey()).id(), e.getKey());

		List<Map<String, Object>> rows = new ArrayList<>(acc.size());
		// emit sorted by province id
		Set<Integer> ids = new TreeSet<>(colorById.keySet());
		for (int id : ids) {
			int color = colorById.get(id);
			Def def = defs.get(color);
			Acc a = acc.get(color);

			ProvinceType type = classify(id, a, seaIds, lakeIds);

			double cx = (a.minX + a.maxX) / 2.0;
			double lon = round2((cx - xmin) / (double) (xmax - xmin) * 360.0 - 180.0);
			double lat = round2(mercatorLatitude(a.minY, a.maxY, h));

			List<Integer> neighbors = new ArrayList<>();
			Set<Integer> nbrColors = colorAdj.get(color);
			if (nbrColors != null) {
				Set<Integer> nbrIds = new TreeSet<>();
				for (int nc : nbrColors) {
					Def nd = defs.get(nc);
					if (nd != null && acc.containsKey(nc))
						nbrIds.add(nd.id());
				}
				neighbors.addAll(nbrIds);
			}

			Map<String, Object> row = new LinkedHashMap<>();
			row.put("id", id);
			row.put("name", def.name());
			row.put("lat", lat);
			row.put("lon", lon);
			row.put("plots", a.pixels);
			row.put("waterPlots", a.water);
			row.put("type", type.name());
			row.put("region", null);
			row.put("area", null);
			row.put("neighbors", neighbors);
			rows.add(row);
		}
		return rows;
	}

	/**
	 * Classify a province as {@code SEA}/{@code LAKE} (from {@code default.map}) or
	 * {@code LAND}, with the flooding auto-correct: a nominally-LAND province that
	 * is entirely water pixels is reclassified to {@code LAKE} (a map-source bug).
	 *
	 * <p><b>BOTH RASTERS HAVE TO AGREE.</b> The auto-correct used to read {@code rivers.bmp} alone,
	 * and that raster is not a river map: index 254 (grey) is EU4's water MASK and 255 (white) its
	 * land marker, so "no dry pixels" means only that the mask covers the province — which it also
	 * does over small ISLANDS. Measured, that misfired badly: 6762 Humacs Island in the Gulf of Ouord
	 * is fully masked, but {@code terrain.bmp} puts 31 of its 43 pixels at index 0, the same land
	 * index that dominates a known land province, against index 17 for the sea all around it. It was
	 * reclassified LAKE, and a lake that is really an island renders as a hole in the map.
	 *
	 * <p>So the correction now also requires the TERRAIN raster to call the province ocean. Absent
	 * {@code terrain.bmp} the auto-correct is disabled outright rather than run on the mask alone —
	 * a province that {@code default.map} does not list is LAND by EU4's own rule, and overriding
	 * that needs corroboration, not a single ambiguous signal.
	 */
	private static ProvinceType classify(int id, Acc a, Set<Integer> seaIds, Set<Integer> lakeIds) {
		if (seaIds.contains(id))
			return ProvinceType.SEA;
		if (lakeIds.contains(id))
			return ProvinceType.LAKE;
		if (a.pixels - a.water < 1 && a.dryTerrain * 2 < a.pixels) {
			System.out.println("flooding auto-correct: province " + id + " -> LAKE");
			return ProvinceType.LAKE;
		}
		return ProvinceType.LAND;
	}

	/** terrain.bmp's ocean indices — EU4 {@code ocean} (15) and {@code inland_ocean} (17). */
	private static final Set<Integer> OCEAN_TERRAIN = Set.of(15, 17);

	/**
	 * terrain.bmp's raw palette indices (not RGB), or null when the file is absent or its dimensions
	 * do not match the province raster — in which case the flooding auto-correct simply does not run.
	 */
	private static int[] loadTerrainIndices(int w, int h) throws Exception {
		Optional<java.nio.file.Path> f = AnbennarFiles.getOptional("map/terrain.bmp");
		if (f.isEmpty())
			return null;
		BufferedImage img = ImageIO.read(f.get().toFile());
		if (img == null || img.getWidth() != w || img.getHeight() != h)
			return null;
		int[] out = new int[w * h];
		java.awt.image.Raster r = img.getRaster();
		for (int y = 0; y < h; y++)
			for (int x = 0; x < w; x++)
				out[y * w + x] = r.getSample(x, y, 0);
		return out;
	}

	private static void registerAdjacency(Map<Integer, Set<Integer>> adj, int a, int b) {
		adj.computeIfAbsent(a, k -> new HashSet<>()).add(b);
		adj.computeIfAbsent(b, k -> new HashSet<>()).add(a);
	}

	/** Inverse-Mercator latitude of a province's bounding-box vertical centre. */
	private static double mercatorLatitude(int minY, int maxY, int mapHeight) {
		double yCenter = (minY + maxY) / 2.0;
		double latRad = 2.0 * Math.atan(Math.exp(Math.PI * (1.0 - (2.0 * yCenter / mapHeight))))
				- (Math.PI / 2.0);
		return Math.toDegrees(latRad);
	}

	/** Round to two decimals, half-up (matching the prior numeric(10,2) storage). */
	private static double round2(double v) {
		return BigDecimal.valueOf(v).setScale(2, RoundingMode.HALF_UP).doubleValue();
	}

	/** Mutable per-province accumulator during the raster scan. */
	private static final class Acc {
		int pixels;
		int water;
		int dryTerrain;   // pixels terrain.bmp does NOT call ocean — see classify
		int minX = Integer.MAX_VALUE;
		int minY = Integer.MAX_VALUE;
		int maxX = Integer.MIN_VALUE;
		int maxY = Integer.MIN_VALUE;
	}
}
