package com.civstudio.server;

/**
 * What <em>kind</em> of run a hosted session is — the <b>auth / visibility category</b>, and the one
 * axis that decides who may see and control it. Named explicitly (and {@linkplain
 * com.civstudio.server.registry.SessionRecord persisted}) rather than inferred from {@code (owner ==
 * null, scenario)}, which was a load-bearing coincidence: "demo = unowned" broke the moment a public
 * sandbox or a tutorial existed. See {@code docs/session-management.md}.
 *
 * <p>Kind is the <em>category</em>; the specific variant within it is the open-set {@code mode} string
 * (e.g. {@code "sandbox"}, {@code "royale"}), and the challenge is {@code difficulty} (a Civ4 handicap
 * key). Those are additive — new modes / difficulties need no new enum value here.
 *
 * <ul>
 * <li>{@link #DEMO} — the unowned shop-window run anyone may watch (the server-seeded caravan demo).</li>
 * <li>{@link #SINGLE_PLAYER} — an owned save slot; private to its owner.</li>
 * <li>{@link #MULTIPLAYER} — a shared, non-ranked run (co-op / free-play modes to come). Reserved; no
 *     founding path creates one yet.</li>
 * <li>{@link #TIMELINE} — the shared ranked Timeline (a last-colony-standing royale). Public to watch;
 *     its clock is admins-only, and its seats are owned per colony.</li>
 * </ul>
 */
public enum SessionKind {

	DEMO,
	SINGLE_PLAYER,
	MULTIPLAYER,
	TIMELINE;

	/**
	 * The kind of a run founded with this {@code owner} and {@code spec} — the single place the rule
	 * lives. A Timeline scenario is a {@link #TIMELINE} whoever owns it (the house owns the run, the
	 * seats are owned per colony); an unowned run is the {@link #DEMO}; anything else owned is a
	 * {@link #SINGLE_PLAYER} save slot. {@link #MULTIPLAYER} is not derived — it is reserved for the
	 * modes still to come, and is chosen explicitly when they land.
	 *
	 * @param owner the owning {@code app_user} id, or {@code null} for an unowned/public run
	 * @param spec  the founding spec
	 * @return the run's kind
	 */
	public static SessionKind of(String owner, SessionSpec spec) {
		if (spec != null && spec.isTimeline())
			return TIMELINE;
		return owner == null || owner.isBlank() ? DEMO : SINGLE_PLAYER;
	}

	/**
	 * The kind for a persisted {@code kind} string, tolerant of legacy rows: an unknown or absent value
	 * falls back to a derivation from {@code scenario} + {@code owner} so a row written before this
	 * column existed still classifies correctly.
	 *
	 * @param kind     the stored kind, or {@code null}
	 * @param scenario the run's scenario (the legacy signal for a Timeline)
	 * @param owner    the run's owner (the legacy signal for the demo)
	 * @return the resolved kind
	 */
	public static SessionKind fromRecord(String kind, String scenario, String owner) {
		if (kind != null && !kind.isBlank())
			try {
				return valueOf(kind);
			} catch (IllegalArgumentException ignored) {
				// an unrecognised stored value — fall through to the legacy derivation
			}
		if (SessionSpec.TIMELINE.equals(scenario))
			return TIMELINE;
		return owner == null || owner.isBlank() ? DEMO : SINGLE_PLAYER;
	}

	/**
	 * Whether anyone may watch a run of this kind — a {@link #DEMO} or a {@link #TIMELINE} (a
	 * leaderboard is for watching); an owned {@link #SINGLE_PLAYER} / {@link #MULTIPLAYER} run is
	 * private to its participants. This is the lobby-visibility rule.
	 */
	public boolean isPublic() {
		return this == DEMO || this == TIMELINE;
	}

	/** Whether a run of this kind is one of a player's finite save slots — only {@link #SINGLE_PLAYER}. */
	public boolean isSaveSlot() {
		return this == SINGLE_PLAYER;
	}

	/**
	 * Whether a human at the wheel picks this run's buildings — so the ruler-queue heuristic is turned
	 * OFF and an empty queue raises the B6 pause-and-choose interrupt (docs/build-queue-plan.md).
	 * <p>
	 * <b>{@link #SINGLE_PLAYER} only.</b> The interrupt is a single-player feature: a save slot has
	 * exactly one player, they are why the run exists, and pausing for their decree is the game.
	 * <p>
	 * <b>The {@link #DEMO} used to be in here and it was a bug</b> (owner, 2026-07-28). The demo is
	 * unowned, so <em>anyone</em> signed in may command it — but nobody is obliged to, and an
	 * anonymous spectator cannot at all. So the very first empty ruler queue paused the deployed demo
	 * on its opening days and left it there: a public spectator run that shows the same date forever
	 * and waits for a decree from a visitor who is not signed in and never asked to drive. A demo
	 * decides for itself, like the shared {@link #TIMELINE}, whose lockstep world must never freeze
	 * on one seat's empty queue either.
	 */
	public boolean playerChoosesBuilds() {
		return this == SINGLE_PLAYER;
	}

	/**
	 * How a freshly-created run of this kind <b>begins</b> — the three beginnings, made a property of
	 * the kind rather than an {@code if} ladder duplicated across the create endpoints (see {@code
	 * docs/session-management.md}). A no-op unless the session is still {@link ClockState#CREATED}, so
	 * it is safe to call on a re-founded/already-running session.
	 *
	 * <ul>
	 * <li>{@link #TIMELINE} — <b>waits for the gun</b>: born empty and opened for joins, it starts only
	 *     when an admin fires it (and {@code launch} rightly refuses an empty run).</li>
	 * <li>{@link #DEMO} — <b>runs immediately</b>: a demo nobody pressed play on is a dead demo.</li>
	 * <li>{@link #SINGLE_PLAYER} / {@link #MULTIPLAYER} — <b>starts paused</b>: you land on the world
	 *     and survey it before committing.</li>
	 * </ul>
	 *
	 * @param hs the freshly-created session
	 */
	public void begin(HostedSession hs) {
		if (hs.clock() != ClockState.CREATED)
			return;
		switch (this) {
			case TIMELINE -> {
				// the gun is a separate, admin-only act (control {action:"start"}) — do nothing here
			}
			case DEMO -> hs.start();
			case SINGLE_PLAYER, MULTIPLAYER -> hs.startPaused();
		}
	}

	/**
	 * The stable wire token the web client keys on ({@code "demo"}, {@code "single-player"},
	 * {@code "multiplayer"}, {@code "timeline"}) — the lowercase, hyphenated name the lobby rows used
	 * before kind was modelled, kept identical so the client is unchanged.
	 */
	public String wire() {
		return name().toLowerCase(java.util.Locale.ROOT).replace('_', '-');
	}
}
