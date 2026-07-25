package com.civstudio.geo;

import java.util.ArrayList;
import java.util.List;

import com.civstudio.util.Rng;

/**
 * Assigns each land cell of a {@link ProvinceMask} a relief ({@link PlotType}
 * flat/hill/peak), porting the Caveman2Cosmos planet generator's <b>spatially
 * coherent</b> peak/hill stage (its {@code addPeaks}/{@code addHills}) from
 * {@code data/C2C_Planet_Generator_0_68.py} to Java. Unlike a per-plot
 * independent draw, peaks and hills are <b>seeded then grown</b> into clusters
 * and ranges: a seed appears with its start probability, then spreads to a random
 * eligible neighbour with its grow probability up to {@code maxInRow} steps, so
 * the province reads as a real landscape (mountain spines, hill chains) rather
 * than scattered noise. See {@code docs/province-plots.md}.
 * <p>
 * The C2C generator's continent/ocean/latitude machinery is not relevant to a
 * single province (its shape is fixed and its climate uniform); only this per-tile
 * relief stage is ported. The start/grow/length {@link Params} are chosen from the
 * province (an {@link ProvinceType#IMPASSABLE} province is mountainous; others use
 * the C2C "some peaks / normal hills" defaults). Cells that are not dry land are
 * left {@code null} in the returned grid.
 * <p>
 * <b>Seams.</b> The stage runs over the mask's {@linkplain ProvinceMask#isGround ground} — this
 * province's land <em>and</em> the halo of neighbouring land — not over its own pixels alone.
 * That matters more here than anywhere else: {@link #canSeedPeak} requires all four orthogonal
 * neighbours to be flat land and {@link #peakBlocked} refuses to grow next to a non-land cell, so
 * against an own-pixels-only mask <em>no peak could ever seed or grow within a pixel of a province
 * border</em> — every province wore a flat ring, and mountain ranges were cut off at the seam.
 * With the halo the ranges run through the border; the halo cells are then discarded (only
 * {@link ProvinceMask#isLand} cells become plots). Two neighbouring provinces still grow their own
 * ranges independently, so a chain may differ by a few pixels across the seam — natural variation
 * rather than a straight edge. See {@code docs/plot-generator.md} §Seamless generation.
 */
public final class ReliefGenerator {

	/**
	 * The C2C peak/hill controls: each is a {@code (startProbability, growProbability,
	 * maxInRow)} triple, mirroring the generator's {@code peaks}/{@code hills} option
	 * presets. {@link #forProvince} selects a preset from the province.
	 */
	public record Params(double peakStart, double peakGrow, int maxPeaks,
			double hillStart, double hillGrow, int maxHills) {

		/** "Some peaks, groups up to 5" + "normal hills, groups up to 2" — C2C defaults. */
		public static final Params DEFAULT = new Params(0.067, 0.60, 5, 0.18, 0.50, 2);

		/** Mountainous: C2C "many peaks, groups up to 10" + longer hill chains. */
		public static final Params MOUNTAINOUS = new Params(0.175, 0.80, 10, 0.18, 0.55, 5);

		/** The relief controls for a province — mountainous if {@link ProvinceType#IMPASSABLE}. */
		public static Params forProvince(Province province) {
			return province.type() == ProvinceType.IMPASSABLE ? MOUNTAINOUS : DEFAULT;
		}
	}

	private ReliefGenerator() {
	}

	/**
	 * Generate the relief grid for a mask: one {@link PlotType} per cell — {@code
	 * null} for ocean (non-province) cells, {@code FLAT}/{@code HILL}/{@code PEAK}
	 * for land — drawn off the terrain {@code rng}.
	 *
	 * @param mask the province silhouette
	 * @param p    the start/grow/length controls
	 * @param rng  the dedicated terrain stream (not the economic one)
	 * @return a {@code width*height} relief grid (row-major; {@code null} = ocean)
	 */
	public static PlotType[] generate(ProvinceMask mask, Params p, Rng rng) {
		int w = mask.width(), h = mask.height();
		PlotType[] g = new PlotType[w * h];
		for (int ly = 0; ly < h; ly++)
			for (int lx = 0; lx < w; lx++)
				g[ly * w + lx] = mask.isGround(lx, ly) ? PlotType.FLAT : null;

		List<int[]> peaks = new ArrayList<>(); // {x, y, count}
		List<int[]> hills = new ArrayList<>();

		// --- seed (one pass; a cell seeds a peak OR a hill, not both) ---
		for (int ly = 0; ly < h; ly++) {
			for (int lx = 0; lx < w; lx++) {
				if (!mask.isGround(lx, ly))
					continue;
				if (p.peakStart() > 0 && canSeedPeak(g, w, h, lx, ly) && rng.uniform() < p.peakStart()) {
					g[ly * w + lx] = PlotType.PEAK;
					if (p.peakGrow() > 0)
						peaks.add(new int[] { lx, ly, 1 });
					continue;
				}
				if (p.hillStart() > 0 && g[ly * w + lx] == PlotType.FLAT
						&& !hillAdjacent(g, w, h, lx, ly, lx, ly) && rng.uniform() < p.hillStart()) {
					g[ly * w + lx] = PlotType.HILL;
					if (p.hillGrow() > 0)
						hills.add(new int[] { lx, ly, 1 });
				}
			}
		}

		grow(g, w, h, peaks, p.peakGrow(), p.maxPeaks(), true, rng);
		grow(g, w, h, hills, p.hillGrow(), p.maxHills(), false, rng);
		return g;
	}

	// the 8 neighbour offsets
	private static final int[][] DIRS = {
			{ -1, 0 }, { -1, -1 }, { 0, -1 }, { 1, -1 }, { 1, 0 }, { 1, 1 }, { 0, 1 }, { -1, 1 } };

	/** A peak seeds only on flat interior land (all 4 orthogonal flat, no diagonal peak). */
	private static boolean canSeedPeak(PlotType[] g, int w, int h, int x, int y) {
		return isFlat(g, w, h, x, y)
				&& isFlat(g, w, h, x - 1, y) && isFlat(g, w, h, x + 1, y)
				&& isFlat(g, w, h, x, y - 1) && isFlat(g, w, h, x, y + 1)
				&& !isPeak(g, w, h, x - 1, y - 1) && !isPeak(g, w, h, x + 1, y - 1)
				&& !isPeak(g, w, h, x - 1, y + 1) && !isPeak(g, w, h, x + 1, y + 1);
	}

	/** Grow a seed list into clusters: pop a random seed, spread it to one eligible neighbour. */
	private static void grow(PlotType[] g, int w, int h, List<int[]> seeds,
			double growProb, int maxInRow, boolean peak, Rng rng) {
		while (!seeds.isEmpty()) {
			int[] s = seeds.remove(rng.uniform(seeds.size()));
			int x = s[0], y = s[1], count = s[2];
			if (count >= maxInRow)
				continue;
			List<int[]> candidates = new ArrayList<>();
			for (int[] d : DIRS) {
				int nx = x + d[0], ny = y + d[1];
				boolean ok = peak
						? isLandCell(g, w, h, nx, ny) && !isPeak(g, w, h, nx, ny)
								&& !peakBlocked(g, w, h, nx, ny, x, y)
						: isFlat(g, w, h, nx, ny) && !hillAdjacent(g, w, h, nx, ny, x, y);
				if (ok)
					candidates.add(new int[] { nx, ny });
			}
			if (candidates.isEmpty())
				continue;
			int[] t = candidates.get(rng.uniform(candidates.size()));
			if (rng.uniform() < growProb) {
				g[t[1] * w + t[0]] = peak ? PlotType.PEAK : PlotType.HILL;
				seeds.add(new int[] { t[0], t[1], count + 1 });
			}
		}
	}

	/** A peak candidate is blocked if a neighbour (other than its parent) is a peak or ocean. */
	private static boolean peakBlocked(PlotType[] g, int w, int h, int x, int y, int ox, int oy) {
		for (int[] d : DIRS) {
			int nx = x + d[0], ny = y + d[1];
			if (nx == ox && ny == oy)
				continue;
			if (!isLandCell(g, w, h, nx, ny) || isPeak(g, w, h, nx, ny))
				return true;
		}
		return false;
	}

	/** Whether any neighbour (other than the parent) is already a hill — spaces hill chains. */
	private static boolean hillAdjacent(PlotType[] g, int w, int h, int x, int y, int ox, int oy) {
		for (int[] d : DIRS) {
			int nx = x + d[0], ny = y + d[1];
			if (nx == ox && ny == oy)
				continue;
			if (isHill(g, w, h, nx, ny))
				return true;
		}
		return false;
	}

	private static PlotType at(PlotType[] g, int w, int h, int x, int y) {
		if (x < 0 || x >= w || y < 0 || y >= h)
			return null;
		return g[y * w + x];
	}

	private static boolean isLandCell(PlotType[] g, int w, int h, int x, int y) {
		return at(g, w, h, x, y) != null;
	}

	private static boolean isFlat(PlotType[] g, int w, int h, int x, int y) {
		return at(g, w, h, x, y) == PlotType.FLAT;
	}

	private static boolean isHill(PlotType[] g, int w, int h, int x, int y) {
		return at(g, w, h, x, y) == PlotType.HILL;
	}

	private static boolean isPeak(PlotType[] g, int w, int h, int x, int y) {
		return at(g, w, h, x, y) == PlotType.PEAK;
	}
}
