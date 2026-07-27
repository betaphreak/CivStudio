package com.civstudio.server;

/**
 * The identity and founding parameters of a hosted session — the <b>savegame key</b>.
 * Because the engine is seed-reproducible, a session's whole run is a pure function of
 * this spec and its ordered {@link com.civstudio.server.command.CommandLog command log}
 * (see {@code docs/client-server.md}): the same spec replays deterministically, so the
 * spec + log <em>is</em> the resume format. The {@code seed} is the reproducibility root;
 * the {@code scenario} + {@code provinceId} pin the founding so two clients asking for the
 * same spec land in the same world.
 *
 * @param seed       the random-number seed — the run's reproducibility root
 * @param scenario   the founding scenario id (see {@link #CARAVAN_DEMO})
 * @param provinceId the world-map province the demo colony founds into
 */
public record SessionSpec(long seed, String scenario, int provinceId) {

	/** The Phase-A demo scenario: one standard colony plus six directed caravans. */
	public static final String CARAVAN_DEMO = "caravan-demo";

	/**
	 * The <b>league demo</b>: several peer cities founded into one province — the lead city and its
	 * vassal mayors, whose rulers take the lead's ruler as liege. See {@code docs/city-and-league.md}
	 * for why several settlements under one name are a {@code Rank.LEAGUE} rather than quarters of
	 * one city, and {@code docs/towngen-port.md} §2c for the case that motivated it.
	 */
	public static final String LEAGUE_DEMO = "league-demo";

	/**
	 * The ranked <b>Timeline</b>: one shared world many players found into, ticking in lockstep,
	 * last colony standing (see {@code docs/spectator-lobby.md}). Unlike every other scenario it
	 * founds <b>no colony</b> — a Timeline is born empty and fills as players join, which is why
	 * it opens in {@link HostedSession.State#CREATED} and only starts once the gun fires.
	 */
	public static final String TIMELINE = "timeline";

	public SessionSpec {
		if (scenario == null || scenario.isBlank())
			throw new IllegalArgumentException("a session spec needs a scenario id");
	}

	/** Whether this spec founds a shared ranked Timeline rather than a colony of its own. */
	public boolean isTimeline() {
		return TIMELINE.equals(scenario);
	}

	/**
	 * The ranked Timeline at the given seed. The {@code provinceId} is the <b>anchor</b>: the site
	 * the first player to join founds into, from which later joiners are spread across the map.
	 * Naming it (rather than picking at random) keeps a Timeline's roster reproducible.
	 *
	 * @param seed     the shared world's seed — the same for every player in this Timeline
	 * @param anchorProvinceId the province the first joiner founds into
	 * @return the Timeline spec
	 */
	public static SessionSpec timeline(long seed, int anchorProvinceId) {
		return new SessionSpec(seed, TIMELINE, anchorProvinceId);
	}

	/**
	 * The stable, human-readable session id derived from this spec ({@code
	 * <scenario>-<seed>}) — the key the {@link SessionHost} registers under and a client
	 * subscribes to.
	 *
	 * @return the session id
	 */
	public String id() {
		return scenario + "-" + seed;
	}

	/** The Phase-A caravan demo spec at the given seed and founding province. */
	public static SessionSpec caravanDemo(long seed, int provinceId) {
		return new SessionSpec(seed, CARAVAN_DEMO, provinceId);
	}

	/**
	 * The <b>league demo</b>: the lead city and its vassal mayors founded together into one
	 * province — what a large historical city actually is (docs/city-and-league.md). This is what
	 * the live demo deals, at Nathalaire.
	 *
	 * @param seed       the run's seed
	 * @param provinceId the province the league founds into
	 * @return the league spec
	 */
	public static SessionSpec leagueDemo(long seed, int provinceId) {
		return new SessionSpec(seed, LEAGUE_DEMO, provinceId);
	}
}
