package com.civstudio.geo;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * The world's climate as a <b>continuous field</b> over the raster, sampled per pixel — the
 * substrate that makes plot generation seamless across province borders.
 * <p>
 * Provinces are <b>reference biomes</b>, not cells: each land province paints its authored
 * Anbennar {@link Climate}/{@link WinterSeverity}/{@link Monsoon} (reduced to a C2C-scale
 * temperature and a humidity by {@link #controlTemperature}/{@link #controlHumidity}) onto a
 * coarse grid over its own pixels; water and unpainted cells are filled from the nearest painted
 * cell; then a few box-blur passes turn the province mosaic into a smooth field with a ~{@value
 * #BLEND_PIXELS}-pixel gradient at each border. Sampling is bilinear, so
 * {@link #temperature(double, double)} and {@link #humidity(double, double)} are <b>continuous
 * functions of world position</b> — two neighbouring plots on opposite sides of a province
 * border read almost the same climate, and the terrain pool they draw from no longer jumps.
 * <p>
 * This replaces the old per-province step function ({@code ClimateTerrainGenerator.temperature(
 * Province)} fed one pool per province), which was one of the five reasons the generated ground
 * broke at every province seam. See {@code docs/plot-generator.md} §Seamless generation.
 * <p>
 * <b>Temperature model.</b> Anbennar authors climate per province in {@code climate.txt}; the
 * province {@link Province#latitude() latitude} is an inverse-Mercator artifact of the EU4 map
 * (Cannor sits at |lat| 60–75°), so it is <b>not</b> a temperature proxy and is demoted to a
 * gentle high-latitude lapse. The authored climate is the authority; winter severity is a modest
 * modifier. The C2C band table the temperature feeds ({@link ClimateTerrainGenerator#pool}) is
 * unchanged — only the temperature handed to it is re-derived. See {@code docs/plot-generator.md}
 * §Temperature.
 * <p>
 * Built once per JVM (it is invariant world data — no seed, no rng) and cached.
 */
public final class WorldClimate {

	/** Raster pixels per grid cell — the field's resolution. */
	public static final int DOWNSAMPLE = 2;

	/** Box-blur passes (radius 1 grid cell) applied to the painted province mosaic. */
	private static final int BLUR_PASSES = 3;

	/** The resulting border gradient, in raster pixels ({@code BLUR_PASSES · DOWNSAMPLE}). */
	public static final int BLEND_PIXELS = BLUR_PASSES * DOWNSAMPLE;

	// --- the temperature model (see the class javadoc) -------------------------------------------

	/**
	 * The anchor temperature (°C, C2C band scale) of each authored Anbennar climate. Chosen so each
	 * band lands squarely in its intended C2C terrain range: {@code TROPICAL} inside the grass band
	 * (4..30 — jungle comes from the feature stage, not from ground desert, because eos does not port
	 * the C2C terrain rewriting that would green it back), {@code ARID} above the desert gate (&gt;30),
	 * {@code TEMPERATE} in grass/plains/marsh, {@code ARCTIC} in taiga/tundra/permafrost.
	 */
	private static double climateAnchor(Climate climate) {
		return switch (climate) {
			case TROPICAL -> 27.0;
			case ARID -> 32.0;
			case TEMPERATE -> 19.0;
			case ARCTIC -> -4.0;
		};
	}

	/**
	 * The terrain cooling (°C) from a province's Anbennar winter severity. Deliberately far milder
	 * than {@link LatitudeClimate#winterOffset} (which stays as it is for travel cost): a harsh
	 * winter makes a province boreal, it does not make it permafrost — Anbennar marks only 116
	 * provinces {@code arctic}, and everything else that reads frozen today was frozen by stacking
	 * this offset on the inflated latitude lapse.
	 */
	private static double winterCooling(WinterSeverity winter) {
		return switch (winter) {
			case NONE -> 0.0;
			case MILD -> 2.0;
			case NORMAL -> 5.0;
			case SEVERE -> 9.0;
		};
	}

	/** |latitude| below which the poleward lapse does not bite at all. */
	private static final double LAPSE_FREE_LATITUDE = 55.0;

	/** Poleward cooling per degree beyond {@link #LAPSE_FREE_LATITUDE} (°C/deg). */
	private static final double LAPSE_RATE = 0.25;

	/**
	 * The C2C-scale temperature a province contributes to the field: its authored climate anchor,
	 * cooled by winter severity and a gentle high-latitude lapse, plus the per-region lore offset.
	 * This is the <b>only</b> temperature in the generator — the terrain bands, the feature stage,
	 * the sea-ice model and the polar water variant all read the field it builds, so they agree
	 * (as they do in the C2C script, which has a single {@code getTileTemperature}).
	 */
	public static double controlTemperature(Province p) {
		double t = climateAnchor(p.climate());
		t -= winterCooling(p.winter());
		t -= Math.max(0, Math.abs(p.latitude()) - LAPSE_FREE_LATITUDE) * LAPSE_RATE;
		t += LatitudeClimate.regionTempOffset(p);   // lore anomalies (e.g. Yarikhoi runs warm)
		return t;
	}

	/** The humidity ({@code [0, 0.95]}) a province contributes: its climate wetness plus its monsoon. */
	public static double controlHumidity(Province p) {
		double h = switch (p.climate()) {
			case TROPICAL -> 0.70;
			case TEMPERATE -> 0.50;
			case ARCTIC -> 0.30;
			case ARID -> 0.10;
		};
		h += switch (p.monsoon()) {
			case NONE -> 0.0;
			case MILD -> 0.10;
			case NORMAL -> 0.20;
			case SEVERE -> 0.30;
		};
		return Math.min(0.95, h);
	}

	// --- the field -------------------------------------------------------------------------------

	private final int gw, gh;          // grid dimensions (raster / DOWNSAMPLE, rounded up)
	private final float[] temp;        // smoothed temperature per grid cell
	private final float[] humid;       // smoothed humidity per grid cell

	private WorldClimate(int gw, int gh, float[] temp, float[] humid) {
		this.gw = gw;
		this.gh = gh;
		this.temp = temp;
		this.humid = humid;
	}

	private static volatile WorldClimate cached;

	/**
	 * The world climate field, built on first use from the {@link WorldMap} and the province
	 * raster and cached for the JVM (invariant world data — no seed, no rng, so every session and
	 * every bake sees the same field).
	 */
	public static WorldClimate of(ProvinceRaster raster) throws IOException {
		WorldClimate c = cached;
		if (c != null)
			return c;
		synchronized (WorldClimate.class) {
			if (cached == null)
				cached = build(WorldMap.load(), raster);
			return cached;
		}
	}

	/** Drop the cached field (tests that swap the world data). */
	public static void reset() {
		synchronized (WorldClimate.class) {
			cached = null;
		}
	}

	/**
	 * Build the field: paint every land province's control values over its own pixels into a
	 * {@link #DOWNSAMPLE}-reduced grid, fill the unpainted (water / off-map) cells from their
	 * nearest painted neighbour, then blur. Deterministic and rng-free.
	 */
	public static WorldClimate build(WorldMap map, ProvinceRaster raster) throws IOException {
		int w = raster.rasterWidth(), h = raster.rasterHeight();
		int gw = (w + DOWNSAMPLE - 1) / DOWNSAMPLE, gh = (h + DOWNSAMPLE - 1) / DOWNSAMPLE;
		int n = gw * gh;
		float[] sumT = new float[n], sumH = new float[n];
		int[] count = new int[n];

		// per-province control values, looked up by id during the raster pass. Water provinces are
		// NOT control points — a sea cell takes the climate of the nearest land, which is exactly
		// what the sea-ice model wants (ice where the neighbouring coast is frozen, not by latitude).
		Map<Integer, float[]> control = new HashMap<>();
		for (Province p : map.provinces())
			if (p.type() != ProvinceType.SEA && p.type() != ProvinceType.LAKE)
				control.put(p.id(), new float[] { (float) controlTemperature(p), (float) controlHumidity(p) });

		raster.forEachPixel((x, y, provinceId) -> {
			float[] v = control.get(provinceId);
			if (v == null)
				return;
			int gi = (y / DOWNSAMPLE) * gw + (x / DOWNSAMPLE);
			sumT[gi] += v[0];
			sumH[gi] += v[1];
			count[gi]++;
		});

		float[] t = new float[n], hu = new float[n];
		boolean[] filled = new boolean[n];
		for (int i = 0; i < n; i++)
			if (count[i] > 0) {
				t[i] = sumT[i] / count[i];
				hu[i] = sumH[i] / count[i];
				filled[i] = true;
			}
		fillFromNearest(t, hu, filled, gw, gh);
		blur(t, gw, gh, BLUR_PASSES);
		blur(hu, gw, gh, BLUR_PASSES);
		return new WorldClimate(gw, gh, t, hu);
	}

	/**
	 * Multi-source BFS over the unpainted cells: every water / off-map cell takes the values of the
	 * nearest painted (land) cell, so the blur below has no holes to smear into and a sea province
	 * inherits its neighbouring coast's climate. 8-connected, so the frontier expands isotropically.
	 */
	private static void fillFromNearest(float[] t, float[] hu, boolean[] filled, int gw, int gh) {
		int n = gw * gh;
		int[] queue = new int[n];
		int head = 0, tail = 0;
		for (int i = 0; i < n; i++)
			if (filled[i])
				queue[tail++] = i;
		if (tail == 0)
			return;   // no land at all — leave the field flat
		while (head < tail) {
			int i = queue[head++];
			int x = i % gw, y = i / gw;
			for (int dy = -1; dy <= 1; dy++)
				for (int dx = -1; dx <= 1; dx++) {
					if (dx == 0 && dy == 0)
						continue;
					int nx = x + dx, ny = y + dy;
					if (nx < 0 || nx >= gw || ny < 0 || ny >= gh)
						continue;
					int ni = ny * gw + nx;
					if (filled[ni])
						continue;
					filled[ni] = true;
					t[ni] = t[i];
					hu[ni] = hu[i];
					queue[tail++] = ni;
				}
		}
	}

	/** Box blur, radius 1, {@code passes} times — the province mosaic becomes a smooth field. */
	private static void blur(float[] g, int gw, int gh, int passes) {
		float[] src = new float[g.length];
		for (int pass = 0; pass < passes; pass++) {
			System.arraycopy(g, 0, src, 0, g.length);
			for (int y = 0; y < gh; y++)
				for (int x = 0; x < gw; x++) {
					float sum = 0;
					int k = 0;
					for (int dy = -1; dy <= 1; dy++)
						for (int dx = -1; dx <= 1; dx++) {
							int nx = x + dx, ny = y + dy;
							if (nx < 0 || nx >= gw || ny < 0 || ny >= gh)
								continue;
							sum += src[ny * gw + nx];
							k++;
						}
					g[y * gw + x] = sum / k;
				}
		}
	}

	/** The C2C-scale temperature at a world raster position (bilinear, continuous). */
	public double temperature(double worldX, double worldY) {
		return sample(temp, worldX, worldY);
	}

	/** The humidity in {@code [0, 0.95]} at a world raster position (bilinear, continuous). */
	public double humidity(double worldX, double worldY) {
		return sample(humid, worldX, worldY);
	}

	private double sample(float[] g, double worldX, double worldY) {
		double gx = worldX / DOWNSAMPLE - 0.5, gy = worldY / DOWNSAMPLE - 0.5;
		int x0 = (int) Math.floor(gx), y0 = (int) Math.floor(gy);
		double fx = gx - x0, fy = gy - y0;
		double a = at(g, x0, y0), b = at(g, x0 + 1, y0);
		double c = at(g, x0, y0 + 1), d = at(g, x0 + 1, y0 + 1);
		return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
	}

	private double at(float[] g, int x, int y) {
		int cx = Math.max(0, Math.min(gw - 1, x));
		int cy = Math.max(0, Math.min(gh - 1, y));
		return g[cy * gw + cx];
	}
}
