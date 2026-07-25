package com.civstudio.geo;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.civstudio.util.Rng;

/**
 * Grows wild vegetation across a province's land cells, porting the <b>seed-and-spread
 * feature stage</b> of the Caveman2Cosmos planet generator ({@code addFeatures},
 * {@code data/civ4/C2C_Planet_Generator_0_68.py} L2650–3075) to Java. Where the
 * relief stage ({@link ReliefGenerator}) clusters peaks and hills, this clusters
 * plants: vegetation <b>seeds</b> along water and peaks, then <b>spreads</b> cell to
 * cell as a random walk, its per-cell kind chosen by a weighted draw over the plot's
 * {@linkplain PyTerrain terrain category} and its {@linkplain WorldClimate temperature}.
 * See {@code docs/c2c-generator-port.md}.
 * <p>
 * <b>What is ported</b> (slices 1–3 of the port doc): the per-cell weighted feature
 * <em>choice</em> (jungle / forest / swamp / none, L2794–2900), the <b>jungle→forest
 * on cold terrain</b> substitution (L2967–2972, so no jungle ever lands on tundra /
 * permafrost / snow), peak seeding (L2902–2949), 8-connected spread (L2990) with the
 * {@linkplain #isRiverCrossing river-crossing block} (L3008/L3052), and the weighted
 * {@linkplain #spread stop-option} that terminates growth (L3071) in place of a hard
 * step cap.
 * <p>
 * <b>What is deliberately not ported.</b> Per the project decision (see {@code
 * docs/c2c-generator-port.md} §2, "feature consequences only"), the stage's <b>terrain
 * rewriting</b> — jungle greening a desert plot to grass, forest→plains, the neighbour
 * "greening" — is dropped: eos's ground is the real imported EU4 map and is left
 * intact. Only the feature-side consequence (the cold substitution) is kept.
 * Flood plains stay {@link ProvincePlotField}'s dedicated placement (a river feature
 * it has the relief to gate), so they are excluded from the choice here.
 * <p>
 * <b>Density and climate are per cell, not per province.</b> The amount of vegetation comes from
 * eos's real {@code trees.bmp} cover rather than the script's global humidity, and the
 * temperature/humidity the weights read come from the continuous {@link WorldClimate} field — all
 * three sampled <b>per cell</b> ({@link ProvinceMask#treeDensity}, bilinear over the coarse tree
 * overlay). Held per province, as they used to be, each of them stepped at every province border
 * and put a visible seam through the vegetation. Density drives the no-feature decay and the
 * peak-seed probability; humidity is used verbatim in the feature-kind weights. So a map-bare
 * stretch grows almost nothing while a wooded one greens densely along its water.
 * <p>
 * The returned grid is the C2C <em>intent</em> — {@link ProvincePlotField}
 * validity-gates each pick against eos's curated feature/terrain rules (jungle only
 * on grass/lush/muddy/marsh, forest off desert, …) and falls back for an invalid host.
 */
public final class FeatureGenerator {

	// feature-kind codes carried on a seed / spread candidate (a compact int so the
	// seed list is a plain int[] rather than an object; NONE = choose on arrival)
	private static final int NONE = 0, JUNGLE = 1, FOREST = 2, SWAMP = 3;

	// 8-connected neighbourhood (getTilesAround, L3242) — the spread topology
	private static final int[][] DIRS8 = {
			{ -1, 0 }, { -1, 1 }, { 0, 1 }, { 1, 1 }, { 1, 0 }, { 1, -1 }, { 0, -1 }, { -1, -1 } };

	private final ProvinceMask mask;
	private final Terrain[] terrain;   // row-major, mask-local (null off ground)
	private final PlotType[] relief;   // row-major, mask-local (composed relief)
	private final int w, h;
	// the per-cell climate: the C2C-scale tile temperature and the script's H, sampled from the
	// continuous WorldClimate field rather than held per province, so the vegetation weights vary
	// smoothly across a province border instead of stepping (see WorldClimate)
	private final double[] tempAt;
	private final double[] humidAt;
	// the per-cell wooded fraction (real trees.bmp, bilinear) → the script's density; likewise
	// continuous, where a per-province average made vegetation density jump at every seam
	private final double[] densityAt;
	private final Rng rng;

	private final Feature jungle, forest, swamp;
	private final Feature[] out;       // the placed vegetation grid (null = bare)

	// the spread frontier as a dedupe-by-position pool (the script's bArray seedList,
	// L2783): one entry per cell (re-seeding a cell overwrites), popped at random.
	private final List<int[]> seedPool = new ArrayList<>();      // {x, y, dist, featCode}
	private final Map<Integer, Integer> seedAt = new HashMap<>(); // cell idx → pool position

	private FeatureGenerator(ProvinceMask mask, Terrain[] terrain, PlotType[] relief,
			WorldClimate climate, double fallbackDensity, TerrainRegistry reg, Rng rng) {
		this.mask = mask;
		this.terrain = terrain;
		this.relief = relief;
		this.w = mask.width();
		this.h = mask.height();
		this.rng = rng;
		this.jungle = reg.feature("FEATURE_JUNGLE");
		this.forest = reg.feature("FEATURE_FOREST");
		this.swamp = reg.feature("FEATURE_SWAMP");
		this.out = new Feature[w * h];
		this.tempAt = new double[w * h];
		this.humidAt = new double[w * h];
		this.densityAt = new double[w * h];
		for (int y = 0; y < h; y++)
			for (int x = 0; x < w; x++) {
				int i = y * w + x;
				double wx = mask.originX() + x, wy = mask.originY() + y;
				tempAt[i] = climate.temperature(wx, wy);
				humidAt[i] = climate.humidity(wx, wy);
				double d = mask.treeDensity(x, y);
				densityAt[i] = d >= 0 ? d : fallbackDensity;
			}
	}

	/**
	 * Generate the vegetation overlay for a province: one {@link Feature} per ground cell
	 * ({@code FEATURE_JUNGLE}/{@code FEATURE_FOREST}/{@code FEATURE_SWAMP} where
	 * vegetation grew, {@code null} elsewhere), the C2C seed-and-spread run off the
	 * terrain {@code rng}. The grid is the choice <em>intent</em>; the caller
	 * validity-gates it.
	 * <p>
	 * Runs over the mask's {@linkplain ProvinceMask#isGround ground} — the province's land plus
	 * its halo of neighbouring land — so vegetation seeds and spreads across a province seam; the
	 * halo cells are discarded by the caller.
	 *
	 * @param mask             the province silhouette (own land, halo, river / coast flags)
	 * @param terrain          the per-cell ground grid (row-major, mask-local; null off ground)
	 * @param relief           the per-cell composed relief grid (peaks drive peak-seeding)
	 * @param climate          the continuous world climate field (per-cell temperature/humidity)
	 * @param fallbackDensity  the wooded fraction to use where {@code trees.bmp} is absent
	 * @param registry         the curated feature definitions
	 * @param rng              the dedicated terrain stream (not the economic one)
	 * @return a {@code width*height} feature grid (row-major; {@code null} = bare)
	 */
	public static Feature[] generate(ProvinceMask mask, Terrain[] terrain, PlotType[] relief,
			WorldClimate climate, double fallbackDensity, TerrainRegistry registry, Rng rng) {
		return new FeatureGenerator(mask, terrain, relief, climate, fallbackDensity, registry, rng).run();
	}

	private Feature[] run() {
		seed();
		while (!seedPool.isEmpty()) {
			int[] s = popRandomSeed();
			process(s[0], s[1], s[2], s[3]);
		}
		return out;
	}

	// --- seeding (L2782): every peak, river (fresh water) and coastal land cell is a
	// seed at distance 1 with no preassigned feature (chosen on arrival). Coastal is the
	// REAL coastline (a sea/lake pixel touches the cell), not "a neighbour outside this
	// province" — the latter seeded a vegetation ring along every province outline. ---
	private void seed() {
		for (int y = 0; y < h; y++)
			for (int x = 0; x < w; x++)
				if (mask.isGround(x, y) && (isPeak(x, y) || mask.isRiver(x, y) || mask.isCoastal(x, y)))
					enqueue(x, y, 1, NONE);
	}

	// process one popped seed: peaks seed their neighbourhood; other seeds choose (or
	// carry) a feature, place it (with the cold substitution) and spread it one step
	private void process(int x, int y, int dist, int featCode) {
		if (isPeak(x, y)) {
			seedFromPeak(x, y);
			return;
		}
		int placed = featCode;
		if (placed == NONE && out[idx(x, y)] == null)
			placed = choose(x, y, dist);
		if (placed == NONE)
			return; // the no-feature outcome: this seed dies, no spread

		// jungle→forest on cold terrain (L2967–2972): the only kept terrain-side
		// consequence — keeps jungle off tundra/permafrost/snow
		if (placed == JUNGLE && PyTerrain.of(terrain[idx(x, y)]).isCold())
			placed = FOREST;

		if (out[idx(x, y)] == null)
			out[idx(x, y)] = feature(placed);
		spread(x, y, dist, placed);
	}

	// --- 4a: the weighted feature choice for a fresh land seed (L2794–2900), floods
	// and terrain rewrites removed. Returns a feature code (NONE = leave bare). ---
	private int choose(int x, int y, int dist) {
		PyTerrain cat = PyTerrain.of(terrain[idx(x, y)]);
		WeightedPick<Integer> pick = new WeightedPick<>();
		double temp = tempAt[idx(x, y)], humidity = humidAt[idx(x, y)], density = densityAt[idx(x, y)];

		// no-feature decay — density (from trees.bmp) in place of the script's humidity
		pick.add(dist * 14 * (1 - density), NONE);
		if (temp > 28)
			pick.add((dist / 3.0 + (temp - 22) / 2.0) * (1 - density * 0.5 - 0.5), NONE);

		// features implied by the initial terrain (name-swapped categories)
		switch (cat) {
			case DESERT -> pick.add(1, JUNGLE);                 // jungle-on-sand
			case GRASS -> {
				if (temp > 20)
					pick.add(1, JUNGLE);
				pick.add(3, FOREST);                            // most forest on grass
			}
			case PLAINS -> {
				if (temp > 25)
					pick.add(2, JUNGLE);
				pick.add(3, FOREST);
			}
			case MARSH -> pick.add(3, SWAMP);                   // some swamp in marsh
			case TUNDRA -> pick.add(3, FOREST);                 // more forest in tundra (eos TAIGA)
			case PERMAFROST -> pick.add(3, FOREST);             // some forest on permafrost
			default -> { /* snow / other: only the temperature weights below */ }
		}
		// any non-cold, very hot tile gets extra jungle (H the eos humidity, verbatim)
		if (!cat.isCold() && temp > 30) {
			pick.add(1, JUNGLE);
			if (humidity > 0.8)
				pick.add(1, JUNGLE);
		}

		// features from temperature (L2886) — with the default tent forest w2 is the
		// baseline everywhere, jungle(>40)/swamp(-10..5) only at the extremes
		if (temp > 40)
			pick.add(2, JUNGLE);
		else if (temp < 5 && temp > -10)
			pick.add(2, SWAMP);
		else if (temp > -20)
			pick.add(2, FOREST);
		else
			pick.add(1, FOREST);

		Integer feat = pick.randomItem(rng);
		return feat == null ? NONE : feat;
	}

	// --- 4b: a peak scores its 5×5 neighbourhood and, if hospitable, seeds its 8
	// neighbours with a temperature-preassigned feature at distance 2 (L2902–2949) ---
	private void seedFromPeak(int x, int y) {
		int score = 80;
		for (int[] t : tilesAround(x, y, 2)) {
			int ti = idx(t[0], t[1]);
			if (out[ti] != null)
				score -= 20;
			if (PyTerrain.of(terrain[ti]) != PyTerrain.DESERT)
				score -= 5;
			if (mask.isRiver(t[0], t[1]))
				score -= 20;
			// (no in-province water cells reach here — tilesAround already keeps land)
			if (isPeak(t[0], t[1]))
				score += 7;
			if (score < 0)
				break;
		}
		if (score <= 0)
			return;
		for (int[] t : tilesAround(x, y, 1)) {
			int tx = t[0], ty = t[1];
			if (isPeak(tx, ty))
				continue;
			if (rng.uniform() < (0.1 + densityAt[idx(x, y)] * 0.6))
				enqueue(tx, ty, 2, peakSeedFeature(x, y));
		}
	}

	// the feature a peak preassigns to a neighbour by temperature (L2931–2949)
	private int peakSeedFeature(int x, int y) {
		double temp = tempAt[idx(x, y)];
		if (temp > 40)
			return JUNGLE;
		if (temp > 35)
			return rng.uniform() > 0.6 ? JUNGLE : FOREST;
		if (temp > 28)
			return rng.uniform() > 0.8 ? JUNGLE : FOREST;
		if (temp > 24)
			return rng.uniform() > 0.95 ? JUNGLE : FOREST;
		return FOREST;
	}

	// --- 6: spread the placed feature to at most one eligible neighbour, chosen by a
	// weighted draw with a stop-option; terrain rewrites removed (L2990–3074) ---
	private void spread(int x, int y, int dist, int featCode) {
		WeightedPick<int[]> posList = new WeightedPick<>();
		for (int[] d : DIRS8) {
			int nx = x + d[0], ny = y + d[1];
			if (!mask.isGround(nx, ny) || isPeak(nx, ny))
				continue; // "not water and not peak"
			int ni = idx(nx, ny);
			PyTerrain ncat = PyTerrain.of(terrain[ni]);
			boolean bare = out[ni] == null;
			if (featCode == JUNGLE) {
				if (bare) {
					if (isFlat(nx, ny))
						posList.add(1, seedArr(nx, ny, dist + 1, JUNGLE));
					if (!isRiverCrossing(x, y, nx, ny) && ncat != PyTerrain.SNOW && ncat != PyTerrain.TUNDRA) {
						if (ncat == PyTerrain.DESERT)
							posList.add(1, seedArr(nx, ny, dist + 1, JUNGLE));
						else
							posList.add(2, seedArr(nx, ny, dist + 1, JUNGLE));
					}
				}
			} else if (featCode == FOREST) {
				if (bare) {
					if (isFlat(nx, ny))
						posList.add(1, seedArr(nx, ny, dist + 1, FOREST));
					if (!isRiverCrossing(x, y, nx, ny) && ncat != PyTerrain.DESERT) {
						if (ncat == PyTerrain.PLAINS)
							posList.add(1, seedArr(nx, ny, dist + 1, FOREST));
						else
							posList.add(2, seedArr(nx, ny, dist + 1, FOREST));
					}
				}
			}
			// SWAMP does not spread in the script (no branch) — placed on seed cells only
		}
		// probabilistic termination: a no-spread option weighted by half the candidate
		// count (L3071), then pick exactly one outcome
		posList.add(posList.size() / 2, null);
		int[] next = posList.randomItem(rng);
		if (next != null)
			enqueue(next[0], next[1], next[2], next[3]);
	}

	/**
	 * Whether a river runs between two orthogonally-adjacent cells — the eos analogue
	 * of Civ4's {@code isRiverCrossing} (L3179), which blocks jungle/forest from
	 * spreading across a river. eos models rivers as through-cell flags with a 4-bit
	 * adjacency mask (the thousands digit of {@link ProvinceMask#riverCode}: 1=E, 2=W,
	 * 4=S, 8=N — the neighbours that are also river cells), so a "crossing" is
	 * approximated as a river channel linking the two cells: both are river cells and
	 * {@code a}'s adjacency bit points at {@code b}. Diagonal steps never cross.
	 */
	private boolean isRiverCrossing(int ax, int ay, int bx, int by) {
		int dx = bx - ax, dy = by - ay;
		int bit;
		if (dx == 1 && dy == 0)
			bit = 1; // E
		else if (dx == -1 && dy == 0)
			bit = 2; // W
		else if (dx == 0 && dy == 1)
			bit = 4; // S
		else if (dx == 0 && dy == -1)
			bit = 8; // N
		else
			return false; // diagonal — no shared edge
		int code = mask.riverCode(ax, ay);
		if (code == 0 || mask.riverCode(bx, by) == 0)
			return false;
		// %100, not %16: the adjacency mask reaches 15, so it spans two decimal digits and a %16
		// would fold the render-class digit above it back in as garbage (see Plot.riverAdj)
		return (((code / 1000) % 100) & bit) != 0;
	}

	// --- seed pool (dedupe-by-position; the script's bArray keyed by world offset) ---

	private void enqueue(int x, int y, int dist, int featCode) {
		int key = idx(x, y);
		int[] entry = { x, y, dist, featCode };
		Integer pos = seedAt.get(key);
		if (pos != null)
			seedPool.set(pos, entry); // re-seed overwrites, as bArray __setitem__ does
		else {
			seedAt.put(key, seedPool.size());
			seedPool.add(entry);
		}
	}

	private int[] popRandomSeed() {
		int pos = rng.uniform(seedPool.size());
		int[] entry = seedPool.get(pos);
		int last = seedPool.size() - 1;
		int[] moved = seedPool.remove(last);
		seedAt.remove(idx(entry[0], entry[1]));
		if (pos != last) {
			seedPool.set(pos, moved);
			seedAt.put(idx(moved[0], moved[1]), pos);
		}
		return entry;
	}

	// the mask-local cells within Chebyshev `distance` of (x,y), excluding the centre
	// and any non-land cell (getTilesAroundDistance, L3258)
	private List<int[]> tilesAround(int x, int y, int distance) {
		List<int[]> l = new ArrayList<>();
		for (int by = -distance; by <= distance; by++)
			for (int bx = -distance; bx <= distance; bx++) {
				if (bx == 0 && by == 0)
					continue;
				int ax = x + bx, ay = y + by;
				if (mask.isGround(ax, ay))
					l.add(new int[] { ax, ay });
			}
		return l;
	}

	private static int[] seedArr(int x, int y, int dist, int featCode) {
		return new int[] { x, y, dist, featCode };
	}

	private Feature feature(int code) {
		return switch (code) {
			case JUNGLE -> jungle;
			case FOREST -> forest;
			case SWAMP -> swamp;
			default -> null;
		};
	}

	private int idx(int x, int y) {
		return y * w + x;
	}

	private boolean isPeak(int x, int y) {
		PlotType r = at(x, y);
		return r == PlotType.PEAK;
	}

	private boolean isFlat(int x, int y) {
		return at(x, y) == PlotType.FLAT;
	}

	private PlotType at(int x, int y) {
		if (x < 0 || x >= w || y < 0 || y >= h)
			return null;
		return relief[idx(x, y)];
	}
}
