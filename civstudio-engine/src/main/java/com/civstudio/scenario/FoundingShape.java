package com.civstudio.scenario;

/**
 * How a scenario founds its world — the branch a host takes when it reads a {@link ScenarioDef}.
 * Covers what the server actually founds today; the odd engine probes ({@code TwinSettlementEconomy}
 * building its own {@code GameSession}, {@code SmallOpenEconomy} skipping {@code foundStandardColony})
 * are deliberately <b>not</b> shapes — they stay code, per {@code docs/studio-control-plane-plan.md}
 * §B1's escape hatch.
 */
public enum FoundingShape {

	/** The standard ruler-bearing colony — {@code SimulationHarness.foundStandardColony}. */
	STANDARD_COLONY,

	/** Founds low as a foraging camp and climbs the tier ladder — {@code SimulationConfig.foundAtCamp}. */
	CAMP,

	/** A ranked Timeline: born empty, filled by joining players — {@code SessionHost.buildTimeline}. */
	TIMELINE,

	/**
	 * A <b>league</b> of cities founded together into one province — {@code SessionHost.buildLeague}.
	 * Several peer settlements around a shared site, which is what a large historical city actually
	 * is: {@code docs/city-and-league.md} settles that several settlements under one name are not
	 * quarters of one city but a {@code Rank.LEAGUE}, and {@code docs/towngen-port.md} §2c shows the
	 * case that motivated it — Nathalaire's ten named quarters around one bay.
	 */
	LEAGUE;

	/**
	 * Whether a headless calibration run can found and run this to a collapse horizon. Only {@link
	 * #STANDARD_COLONY} — a {@link #CAMP} boots its ruler economy late (its CSV printers need the
	 * boot callback a hosted render does not use) and a {@link #TIMELINE} is multiplayer and
	 * born-empty. So the calibration tools offer the standard shape; the host founds all three.
	 *
	 * @return {@code true} for the standard colony only
	 */
	public boolean headlessRunnable() {
		return this == STANDARD_COLONY;
	}
}
