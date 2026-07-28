package com.civstudio.server.town;

/**
 * The town layout's randomness — <b>keyed, not streamed</b> ({@code docs/towngen-port.md} §10, and
 * the T2 finding that made it necessary).
 * <p>
 * Every draw the layout makes is a pure function of {@code (site seed, plot)}. Nothing here holds
 * state, nothing advances, and there is no order to get wrong: a plot's jitter is the same whether
 * the town is generated whole, grown one plot at a time, or rebuilt from a file years later. That
 * matters concretely — {@link Footprint} returns its cells sorted by {@code (y, x)}, so a newly
 * built plot lands in the <em>middle</em> of the list and a stream-ordered draw would reshuffle
 * every seed after it, resettling wards nobody touched.
 * <p>
 * <b>Why this does not need an engine RNG stream.</b> The repo convention is that a new feature
 * never draws from the economic stream and gets its own salt instead ({@code RngSeed.Stream}). This
 * draws from <em>no</em> session generator at all: it hashes the session seed rather than consuming
 * from it, so it cannot perturb any existing sequence, and adding it changes no run's output. The
 * salts below serve the same decorrelation purpose as that enum's.
 */
public final class TownRng {

	private TownRng() {
	}

	/** Separates a town's keys from anything else derived off the same session seed. */
	private static final long TOWN_SALT = 0x54_4F_57_4E_47_45_4EL;      // "TOWNGEN"

	/** Decorrelates one site's layout from another's in the same session. */
	private static final long SITE_SALT = 0x9E3779B97F4A7C15L;

	/**
	 * The seed for one town <b>site</b> — a province, not a colony, because a layout outlives the
	 * settlement that raised it (§2a: a dead colony's town persists as a ruin, keyed by site).
	 *
	 * @param sessionSeed the session's seed
	 * @param provinceId  the province the town stands in
	 * @return that site's layout seed
	 */
	public static long siteSeed(long sessionSeed, int provinceId) {
		return mix(sessionSeed ^ TOWN_SALT ^ (SITE_SALT * provinceId));
	}

	/**
	 * The key for one plot of one site. Distinct plots give uncorrelated keys, and the same plot
	 * always gives the same key.
	 *
	 * @param siteSeed the site's seed from {@link #siteSeed}
	 * @param x        the plot's raster x
	 * @param y        the plot's raster y
	 * @return the mixed key
	 */
	public static long cellKey(long siteSeed, int x, int y) {
		// mix the coordinates into the seed before the finaliser rather than adding them after:
		// neighbouring plots differ by 1 in one coordinate, and only a full avalanche keeps their
		// keys from being visibly related — a mesh where every seed leans the same way is worse
		// than no jitter at all
		return mix(siteSeed ^ (0xD6E8FEB86659FD93L * x) ^ (0xA0761D6478BD642FL * y));
	}

	/**
	 * A key as a fraction in {@code [0, 1)} — the form a score nudge or a threshold wants.
	 * <p>
	 * Takes the <b>top</b> 53 bits, not the bottom ones: the low bits of a mixed word are the least
	 * well distributed, and a tie-break that leans one way is a town whose wards all cluster in the
	 * same corner.
	 *
	 * @param key a key from {@link #cellKey}
	 * @return the fraction
	 */
	public static double unit(long key) {
		return (key >>> 11) * 0x1.0p-53;
	}

	/**
	 * A generator for one plot of one site — for the block cutters, which take a {@code
	 * RandomGenerator} rather than a key.
	 * <p>
	 * <b>One generator per plot, never one per town.</b> A shared stream would make a patch's lots
	 * depend on how many patches were cut before it, so building on one side of town would re-cut
	 * every block on the other — the same order-sensitivity this whole class exists to avoid.
	 *
	 * @param key a key from {@link #cellKey}
	 * @return a generator seeded from it
	 */
	public static java.util.random.RandomGenerator generator(long key) {
		return new java.util.Random(key);
	}

	/** SplitMix64's finaliser — a full-avalanche 64-bit mix, in {@code long} arithmetic. */
	static long mix(long z) {
		z += 0x9E3779B97F4A7C15L;
		z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
		z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
		return z ^ (z >>> 31);
	}
}
