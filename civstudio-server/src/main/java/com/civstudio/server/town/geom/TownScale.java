package com.civstudio.server.town.geom;

/**
 * The town generator's <b>unit scale</b> and the constants derived from it — {@code
 * docs/towngen-port.md} §3, fixed here in T1 because "every ward tuning number depends on it".
 * <p>
 * <b>One plot is 1.0.</b> The reference generator works in a space where one patch is roughly
 * 10–30 units across, so its authored numbers (street widths 2.0 / 1.0 / 0.6, block size targets
 * around 10–110) are ~20–25× ours. The values here are re-derived at our scale rather than divided
 * across, and they are expected to be re-tuned once T6 puts real blocks on screen — treat them as
 * a starting point with the right order of magnitude, not as settled.
 * <p>
 * <b>Lots are symbolic</b> (plan §3, owner decision): a plot is a Civ4-scale tile, so a literally
 * scaled town would be a smudge in the corner of one. Lot sizes are chosen to <em>read</em> — the
 * tuning target is "how many blocks look right in a patch", never metres.
 */
public final class TownScale {

	private TownScale() {
	}

	/** One plot. The unit of everything in this package. */
	public static final double PLOT = 1.0;

	/** A main avenue — the artery from a gate to the plaza. */
	public static final double STREET_MAIN = 0.09 * PLOT;

	/** An ordinary street. */
	public static final double STREET_REGULAR = 0.045 * PLOT;

	/** An alley between blocks within a ward. */
	public static final double STREET_ALLEY = 0.025 * PLOT;

	/**
	 * The seed jitter radius, in plots — where the mesh's irregularity comes from (§4.1). Must
	 * stay below {@link #JITTER_MAX} or the plot ↔ patch bijection stops holding by construction.
	 */
	public static final double JITTER_R = 0.35 * PLOT;

	/**
	 * The hard ceiling on the jitter radius: at half a plot, a seed can be as close to a
	 * neighbouring plot's centre as to its own, and the bijection proof (§4.1) fails. {@link
	 * Lloyd#clamp} enforces this, and no tuning may raise {@link #JITTER_R} past it.
	 */
	public static final double JITTER_MAX = 0.5 * PLOT;

	/**
	 * How many Lloyd passes the mesh runs — <b>one</b>. Relaxation <em>spends</em> irregularity
	 * (it converges toward a honeycomb), so it is dosed to remove slivers and no further; see
	 * §4.1, which is the whole argument for this being 1 and not 10.
	 */
	public static final int LLOYD_PASSES = 1;

	/**
	 * The smallest block worth subdividing further, in square plots. Below this a block becomes a
	 * lot rather than being cut again.
	 */
	public static final double MIN_BLOCK_AREA = 0.010 * PLOT * PLOT;

	/**
	 * The compactness ({@link Poly#compactness()}) below which a block is too thin to build on and
	 * a cutter should try a different cut. A square is ~0.785, so this rejects roughly anything
	 * more than about four times as long as it is wide.
	 */
	public static final double MIN_BLOCK_COMPACTNESS = 0.20;
}
