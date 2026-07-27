package com.civstudio.settlement;

/**
 * The rung a settlement occupies on the unified settle&hairsp;&rlarr;&hairsp;unsettle growth
 * ladder — the single source of truth for how settled/developed a band is, from the transient
 * camp a caravan sleeps in up to a full metropolis. A settlement founds low and climbs; on
 * decline it descends and, at the foot, departs as a wandering caravan again. See {@code
 * docs/settlement-tier-ladder-plan.md} and {@code docs/settlement-tiers.md}.
 * <p>
 * The rungs are ordered {@code CAMP < COTTAGE < HAMLET < SMALLHOLDING < TOWN < METROPOLIS}, and
 * {@link #atLeast(SettlementTier)} compares that order. The names are deliberately distinct from
 * the household-command {@link com.civstudio.agent.Rank} rungs — the old <em>Village</em> and
 * <em>City</em> rungs were renamed to {@link #SMALLHOLDING} and {@link #METROPOLIS} — so the two
 * axes never collide: this tier is the <em>place's</em> development, while the head household's
 * {@code Rank} (Captain&rarr;Ruler&rarr;Mayor) is <em>derived from</em> it.
 * <p>
 * Capability thresholds read off the order: a settlement {@linkplain Settlement#hasDistricts()
 * has districts} and is {@linkplain Settlement#isPermanent() permanent} from {@link #TOWN} up.
 * <p>
 * <b>Growth is food-driven (Civ4-style).</b> A settlement banks its daily net food surplus in a
 * {@linkplain Settlement#getFoodBox() food box}; when the box clears the current rung's {@link
 * #foodToChange()} it grows one rung (a sustained deficit that drains the box below {@code
 * -foodToChange()} shrinks it one rung — starvation). Two extra gates guard growth: a rung of
 * {@linkplain #size() size} <var>N</var> needs at least {@link #minHouseholds() N&sup2; households},
 * and reaching {@link #METROPOLIS} additionally needs &ge;&thinsp;{@value #METROPOLIS_POP_GATE}
 * people. The costs are size-scaled and deliberately <b>uncalibrated</b> (a tuning lever).
 * <p>
 * <b>Deferred.</b> {@code SUBURBS} (a province-level merge of several towns into one metropolis)
 * is a separate future operation, not a linear rung, so it is intentionally absent here.
 */
public enum SettlementTier {

	/** The transient plot a caravan sleeps in — no buildings; the ladder's foot. */
	CAMP,

	/** A camp that has put down its first building. */
	COTTAGE,

	/** A very limited settlement — a handful of buildings, still no districts. */
	HAMLET,

	/** A single-urban-plot centre with no districts (the old {@code Village}). */
	SMALLHOLDING,

	/** The first district-bearing rung — districts under a size cap. */
	TOWN,

	/**
	 * The top rung — uncapped districts and permanent; additionally gated on
	 * &ge;&thinsp;{@value #METROPOLIS_POP_GATE} people (see the growth advance). The old
	 * {@code City}.
	 */
	METROPOLIS;

	/**
	 * How large a share of a province's plots a settlement of this tier claims when it is
	 * <b>not alone in it</b> — the weight in the split described on {@link
	 * com.civstudio.settlement.PlotField#getMaxPlots()}.
	 * <p>
	 * Several settlements in one province are a {@code Rank.LEAGUE} ({@code
	 * docs/city-and-league.md}), and a league is not made of equals: its lead city is a metropolis
	 * and its members are towns and hamlets, so the ground divides in that proportion rather than
	 * evenly. The weights are deliberately coarse — a metropolis is worth eight hamlets, not 8.4 —
	 * because the split's job is to stop one city draining a province, not to be a land registry.
	 *
	 * @return this tier's share weight, always at least 1
	 */
	public int plotWeight() {
		return switch (this) {
			case CAMP, COTTAGE -> 1;
			case HAMLET -> 2;
			case SMALLHOLDING -> 3;
			case TOWN -> 5;
			case METROPOLIS -> 8;
		};
	}

	/**
	 * The people-count a {@link #TOWN} must reach before it can advance to {@link #METROPOLIS}
	 * (the population gate that makes a town a metropolis, beyond food and households alone).
	 */
	public static final int METROPOLIS_POP_GATE = 1000;

	// the food-to-grow curve, ported from C2C's CvPlayer::getGrowthThreshold —
	// threshold = BASE + (size-1) * MULTIPLIER, linear in size (C2C's is linear in population).
	// These are the stock C2C GlobalDefines.xml values (BASE_CITY_GROWTH_THRESHOLD /
	// CITY_GROWTH_MULTIPLIER); C2C then scales them by game-speed and era — that scale is our
	// deferred calibration lever. See docs/settlement-tier-ladder-plan.md, memory c2c-city-growth-mechanics.
	private static final int BASE_CITY_GROWTH_THRESHOLD = 130;
	private static final int CITY_GROWTH_MULTIPLIER = 25;

	/**
	 * Whether this tier is at least {@code other} on the ladder — i.e. this rung is {@code other}
	 * or higher. The capability tests key off this (districts and permanence begin at {@link
	 * #TOWN}).
	 *
	 * @param other
	 *            the rung to compare against
	 * @return {@code true} if this tier is {@code other} or higher
	 */
	public boolean atLeast(SettlementTier other) {
		return ordinal() >= other.ordinal();
	}

	/**
	 * This rung's <b>size</b> — its 1-based position on the ladder ({@link #CAMP} = 1 &hellip;
	 * {@link #METROPOLIS} = 6). Drives the size-scaled {@link #minHouseholds()} and {@link
	 * #foodToChange()}.
	 *
	 * @return the tier's size (1..6)
	 */
	public int size() {
		return ordinal() + 1;
	}

	/**
	 * The minimum number of <b>households</b> a settlement must hold to reach (or hold) this rung
	 * — {@link #size() size}&sup2; (Civ4-flavoured: bigger places demand quadratically more
	 * households). A growth advance is gated on the <em>target</em> rung's value.
	 *
	 * @return the household floor for this rung
	 */
	public int minHouseholds() {
		return size() * size();
	}

	/**
	 * The food (net-surplus units) that <b>changing</b> this rung costs — the {@linkplain
	 * Settlement#getFoodBox() food box} must clear {@code +foodToChange()} to grow out of this
	 * rung, and on starving down a rung the box climbs back by the lower rung's value. Ported
	 * from C2C's growth threshold {@code BASE + (size-1) × MULTIPLIER} (= {@code 130 + (size-1)×25}):
	 * {@code CAMP} 130, {@code COTTAGE} 155, &hellip;, {@code METROPOLIS} 255. Uncalibrated (C2C's
	 * game-speed/era multiplier is the deferred scale).
	 *
	 * @return the food cost to grow past / starve out of this rung
	 */
	public int foodToChange() {
		return BASE_CITY_GROWTH_THRESHOLD + (size() - 1) * CITY_GROWTH_MULTIPLIER;
	}

	/**
	 * The most <b>buildings</b> a settlement at this rung may raise at its city centre — a camp
	 * has none, a cottage its one building, a hamlet a small handful, and a {@link #SMALLHOLDING}
	 * or larger an unrestricted centre. Gates the auto-build placement chokepoint.
	 *
	 * @return the building cap for this rung ({@link Integer#MAX_VALUE} = unrestricted)
	 */
	public int maxBuildings() {
		return switch (this) {
			case CAMP -> 0;
			case COTTAGE -> 1;
			case HAMLET -> 3;
			default -> Integer.MAX_VALUE; // SMALLHOLDING and up: unrestricted centre
		};
	}

	/**
	 * The {@link com.civstudio.agent.Rank Rank} the settlement's <b>head household</b> commands at
	 * this rung — the single source of truth from which the head's rank is derived (the reconciled
	 * decision, {@code docs/settlement-tier-ladder-plan.md} / {@code docs/rank-ladder-improvements.md}
	 * R2): the foraging camp tiers ({@link #CAMP}/{@link #COTTAGE}/{@link #HAMLET}) are led by a
	 * <b>Captain</b> ({@link com.civstudio.agent.Rank#CARAVAN CARAVAN}); a settled
	 * {@link #SMALLHOLDING}/{@link #TOWN} by a <b>Ruler</b>
	 * ({@link com.civstudio.agent.Rank#VILLAGE VILLAGE}); a {@link #METROPOLIS} by a <b>Mayor</b>
	 * ({@link com.civstudio.agent.Rank#CITY CITY}). Crossing a boundary between these bands reforms
	 * the head into the type realizing the new rank (up: Captain&rarr;Ruler&rarr;Mayor; the
	 * symmetric demotion on descent is R4).
	 *
	 * @return the head household's rank at this tier
	 */
	public com.civstudio.agent.Rank headRank() {
		return switch (this) {
			case CAMP, COTTAGE, HAMLET -> com.civstudio.agent.Rank.CARAVAN;
			case SMALLHOLDING, TOWN -> com.civstudio.agent.Rank.VILLAGE;
			case METROPOLIS -> com.civstudio.agent.Rank.CITY;
		};
	}

	/**
	 * The rung one step up the ladder, or empty at the terminal {@link #METROPOLIS}.
	 *
	 * @return the next-higher tier, or empty at the top
	 */
	public java.util.Optional<SettlementTier> next() {
		SettlementTier[] all = values();
		return ordinal() + 1 < all.length ? java.util.Optional.of(all[ordinal() + 1])
				: java.util.Optional.empty();
	}

	/**
	 * The rung one step down the ladder, or empty at the foot {@link #CAMP}.
	 *
	 * @return the next-lower tier, or empty at the bottom
	 */
	public java.util.Optional<SettlementTier> previous() {
		return ordinal() > 0 ? java.util.Optional.of(values()[ordinal() - 1])
				: java.util.Optional.empty();
	}
}
