package com.civstudio.server;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

import com.civstudio.settlement.GameSession;
import com.civstudio.settlement.Settlement;
import com.civstudio.server.chat.ChatStore;
import com.civstudio.server.chat.InMemoryChatStore;
import com.civstudio.server.command.CommandStore;
import com.civstudio.server.command.GameCommand;
import com.civstudio.server.command.NoOpCommandStore;
import com.civstudio.server.registry.InMemorySessionRegistry;
import com.civstudio.server.registry.SeatRecord;
import com.civstudio.server.registry.SessionRecord;
import com.civstudio.server.registry.SessionRegistry;
import com.civstudio.balance.BalanceProfiles;
import com.civstudio.scenario.FoundingShape;
import com.civstudio.scenario.LeagueFlavor;
import com.civstudio.scenario.ScenarioDef;
import com.civstudio.scenario.ScenarioRegistry;
import com.civstudio.simulation.SimulationConfig;
import com.civstudio.simulation.SimulationHarness;
import jakarta.annotation.PreDestroy;
import lombok.extern.java.Log;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Owns the live {@link HostedSession hosted sessions} of one server process, keyed by
 * {@link SessionSpec#id() session id} — the "many sessions per JVM" registry Phase 0 made
 * safe (each session's log/output is now per-session; see {@code docs/client-server.md}). A
 * client asks for a spec; the host founds the session's world (a standard colony, which musters
 * its own emergent explorer levies), registers it, and hands it back for the transport to
 * subscribe to.
 */
@Log
@Component
public final class SessionHost {

	// how long a lazy restore may spend replaying before we call it broken. Generous: a restore runs
	// uncapped (~seconds for thousands of ticks), so hitting this means something is wrong, not slow.
	private static final long RESTORE_TIMEOUT_MS = 600_000L;

	/**
	 * How many single-player runs one player may have going at once — their save slots (see
	 * {@code docs/spectator-lobby.md} Phase 4).
	 */
	public static final int SAVE_SLOT_LIMIT = 5;

	private final ConcurrentMap<String, HostedSession> sessions = new ConcurrentHashMap<>();

	private final CommandStore commandStore;
	private final ChatStore chatStore;
	private final SessionRegistry registry;

	/** In-memory only — for constructing a host directly (e.g. in a test), no persistence. */
	public SessionHost() {
		this(new NoOpCommandStore(), new InMemoryChatStore(), new InMemorySessionRegistry());
	}

	/**
	 * @param commandStore durable command-log storage — a {@link NoOpCommandStore} when no
	 *                     datasource is configured (see {@code PersistenceConfig})
	 * @param chatStore    lobby chat storage — an {@link InMemoryChatStore} when no datasource
	 * @param registry     where runs and seats are remembered — an {@link InMemorySessionRegistry}
	 *                     when no datasource, which forgets them with the process
	 */
	@Autowired
	public SessionHost(CommandStore commandStore, ChatStore chatStore, SessionRegistry registry) {
		this.commandStore = commandStore;
		this.chatStore = chatStore;
		this.registry = registry;
	}

	/** Where runs and seats are remembered across restarts (docs/spectator-lobby.md Phase 6). */
	public SessionRegistry registry() {
		return registry;
	}

	/**
	 * Found and register an <em>unowned</em> (public) session from {@code spec} — the
	 * server-seeded demo and the existing tests. Equivalent to {@link #create(SessionSpec,
	 * String) create(spec, null)}.
	 *
	 * @param spec the founding spec
	 * @return the hosted session
	 */
	public HostedSession create(SessionSpec spec) {
		return create(spec, null);
	}

	/**
	 * Found and register a session from {@code spec} owned by {@code owner} (idempotent by the
	 * derived {@linkplain #sessionKey key}: re-founding the same spec+owner returns the existing
	 * session, so a persisted command log replays onto it — {@code state = f(spec, log)}). Two
	 * different owners founding the same spec get two independent sessions. The session is built
	 * but not started — the caller sets the tick rate and starts it.
	 *
	 * @param spec  the founding spec (the determinism root — ownership is metadata alongside it,
	 *              never part of the spec)
	 * @param owner the owning {@code app_user} id, or {@code null} for an unowned/public session
	 * @return the hosted session
	 */
	public HostedSession create(SessionSpec spec, String owner) {
		return create(spec, owner, SessionKind.of(owner, spec), null, null);
	}

	/**
	 * Found and register a session with an explicit {@linkplain SessionKind kind}, {@code mode} and
	 * {@code difficulty} — the full founding path (see {@code docs/session-management.md}). The
	 * two-argument {@link #create(SessionSpec, String)} derives the kind and takes the defaults for
	 * the rest; a caller with a founding request (the controller) passes them through here.
	 *
	 * @param spec       the founding spec (the determinism root)
	 * @param owner      the owning {@code app_user} id, or {@code null} for an unowned/public session
	 * @param kind       the run's kind (visibility/auth category) — never {@code null}
	 * @param mode       the mode variant, or {@code null} for the default
	 * @param difficulty the Civ4 handicap key, or {@code null} for the default
	 * @return the hosted session
	 */
	public HostedSession create(SessionSpec spec, String owner, SessionKind kind, String mode,
			String difficulty) {
		String id = sessionKey(spec, owner);
		HostedSession live = sessions.get(id);
		if (live != null)
			return live;
		// A FINISHED run is finished. Re-founding its spec is exactly what a redeploy does, so
		// without this a redeploy would reopen an ended Timeline — handing out the very retry the
		// registry exists to deny, by erasing the verdict rather than by losing it. To play again you
		// need a new run, not the same id back. (A disposable fixture — the demo — calls forget()
		// first, deliberately and out loud.)
		SessionRecord recorded = registry.find(id).orElse(null);
		if (recorded != null && recorded.isFinished())
			throw new RunFinishedException(id, recorded.legacyState(), recorded.endReason());
		// a player's save slots are finite; a new one has to fit (re-founding a run you already have
		// is not a new slot, hence the `recorded == null`)
		if (recorded == null && kind.isSaveSlot() && saveSlotsOf(owner).size() >= SAVE_SLOT_LIMIT)
			throw new SaveSlotsFullException(owner);
		return sessions.computeIfAbsent(id, k -> {
			HostedSession hs = build(id, owner, kind, mode, difficulty, spec);
			// remember the run before it can end: the record is what survives this process, and a
			// run that ended without ever being written down is a run that never happened
			registry.save(new SessionRecord(id, spec.scenario(), spec.seed(), spec.provinceId(),
					owner, kind.name(), mode, difficulty, hs.clock().name(), hs.outcome().name(),
					null, 0, com.civstudio.data.WorldSources.contentVersion()));
			// the terminal values are handed to us rather than read back: at this point the session
			// has not published them yet, which is exactly what makes the record trustworthy
			hs.onEnd((ended, clock, outcome, endReason, tick) -> registry.updateProgress(ended.id(),
					clock.name(), outcome.name(), endReason, tick));
			return hs;
		});
	}

	/**
	 * This player's save slots — their single-player runs still in play.
	 * <p>
	 * A <b>finished</b> run does not hold a slot. Its record persists (it is their run, and the
	 * lobby can still list it), but the slot it occupied is free: five collapses would otherwise lock
	 * a player out of the game forever, and colonies collapse by design. A run merely {@code STOPPED}
	 * <em>does</em> hold its slot — it is still playable, which is exactly the distinction
	 * {@code docs/game-over.md} draws.
	 *
	 * @param userId the player
	 * @return their live save slots, oldest first (empty for an unidentified caller)
	 */
	public List<SessionRecord> saveSlotsOf(String userId) {
		if (userId == null || userId.isBlank())
			return List.of();
		List<SessionRecord> out = new ArrayList<>();
		for (SessionRecord r : registry.all())
			if (userId.equals(r.owner()) && r.kindEnum().isSaveSlot() && !r.isFinished())
				out.add(r);
		return out;
	}

	/** Thrown when a player with a full set of save slots asks for another. */
	public static final class SaveSlotsFullException extends RuntimeException {
		private static final long serialVersionUID = 1L;

		SaveSlotsFullException(String owner) {
			super(owner + " already has " + SAVE_SLOT_LIMIT + " runs in play — finish or delete one");
		}
	}

	/** Thrown when a run that has already ended is asked to found again under its own id. */
	public static final class RunFinishedException extends RuntimeException {
		private static final long serialVersionUID = 1L;

		private final transient String endReason;

		RunFinishedException(String id, String state, String endReason) {
			super("run " + id + " is over (" + state + ")"
					+ (endReason == null ? "" : ": " + endReason));
			this.endReason = endReason;
		}

		/** Why the run ended, or {@code null} if it was stopped rather than finished. */
		public String endReason() {
			return endReason;
		}
	}

	/**
	 * Bring a recorded run back into this process — the restore path ({@code
	 * docs/spectator-lobby.md} Phase 6). Rebuilds it the way the engine says a run <em>is</em>
	 * defined: its {@link SessionSpec spec}, its roster, and its ordered command log.
	 * <ol>
	 * <li>the spec re-founds the world (the engine is seed-reproducible);</li>
	 * <li>a Timeline's <b>seats are re-founded in {@code seat_order}</b> — founding is
	 * deterministic, so replaying the join order reproduces the same colonies in the same
	 * provinces. The recorded province is <b>checked</b>, not trusted: a mismatch means the world
	 * moved under us and is worth failing loudly for;</li>
	 * <li>the command log replays (already the case — {@link #build} loads it);</li>
	 * <li>the run is <b>fast-forwarded</b> to its recorded tick, because {@code state = f(spec,
	 * log)} and there is no shortcut to tick N but to run N days. This is why it is done lazily,
	 * on first access, rather than holding boot hostage.</li>
	 * </ol>
	 * A run that never started (tick 0, {@code CREATED} — a Timeline still open for joins) needs no
	 * fast-forward at all, which is the cheap and fully-exact case.
	 *
	 * @param id the recorded run's id
	 * @return the restored session, or {@code null} if nothing is recorded under that id or the run
	 *         is over (a finished run needs no rebuilding — its outcome is columns)
	 */
	public synchronized HostedSession restore(String id) {
		HostedSession live = sessions.get(id);
		if (live != null)
			return live;
		SessionRecord r = registry.find(id).orElse(null);
		// only a run that ENDED ITSELF is beyond restoring. A STOPPED one was stopped from outside —
		// which is what shutdown does to every session — so it is exactly what restore is for.
		if (r == null || r.isFinished())
			return null;
		warnIfContentMoved(r);
		SessionSpec spec = new SessionSpec(r.seed(), r.scenario(), r.provinceId());
		HostedSession hs = build(id, r.owner(), r.kindEnum(), r.mode(), r.difficulty(), spec);
		hs.onEnd((ended, clock, outcome, endReason, tick) -> registry.updateProgress(ended.id(),
				clock.name(), outcome.name(), endReason, tick));
		sessions.put(id, hs);

		// re-found the roster, in the order it was taken
		for (SeatRecord s : registry.seats(id)) {
			Settlement colony = foundSeat(hs);
			if (colony.getProvince() == null || colony.getProvince().id() != s.provinceId())
				throw new IllegalStateException("restoring " + id + ": " + s.userId()
						+ " was seated in province " + s.provinceId() + " but re-founding put them in "
						+ (colony.getProvince() == null ? "none" : colony.getProvince().id())
						+ " — the world is not the one this run was played in");
			seat(hs, colony, s.userId());
		}

		if (r.tick() > 0) {
			// fast-forward: run the recorded days as fast as the machine allows, then hold. The
			// command log replays itself on the way, at the ticks it was stamped with.
			long rate = hs.tickRateMillis();
			hs.setTickRateMillis(0);
			hs.startPaused();
			hs.step((int) Math.min(Integer.MAX_VALUE, r.tick()));
			awaitTick(hs, r.tick());
			// …then put the clock back on its pacing. Without this a restored run that resumes below
			// ticks UNCAPPED forever, because the fast-forward's rate was never undone.
			hs.setTickRateMillis(rate);
			// A restored run comes back PAUSED, whatever it was doing when the process went down
			// (owner decision, 2026-07-27): you land on the world and decide to continue it, rather
			// than finding days already spent on your behalf. The DEMO is the exception — a shop
			// window nobody pressed play on is a dead shop window (cf. SessionKind.begin).
			if (hs.kind() == SessionKind.DEMO && "RUNNING".equals(r.clockState()))
				hs.resume();
		}
		log.info(() -> "restored session " + id + " (" + r.scenario() + ", tick " + r.tick()
				+ ", " + registry.seats(id).size() + " seats)");
		return hs;
	}

	/**
	 * The live run with this id, restoring it from its record if this process does not hold it —
	 * what a caller that wants to <em>use</em> a session should ask for. Returns {@code null} for a
	 * run that neither exists nor can be restored (including a finished one).
	 *
	 * @param id the session id
	 * @return the session, or {@code null}
	 */
	public HostedSession getOrRestore(String id) {
		HostedSession hs = sessions.get(id);
		return hs != null ? hs : restore(id);
	}

	// block until a restoring session has replayed up to `tick`. It runs uncapped, so this is a
	// short spin over seconds, not a wait on wall-clock pacing (a 4,426-tick collapse replays in ~3s).
	private static void awaitTick(HostedSession hs, long tick) {
		long deadline = System.nanoTime() + RESTORE_TIMEOUT_MS * 1_000_000L;
		while (hs.tick() < tick && !hs.isTerminal()) {
			if (System.nanoTime() > deadline)
				throw new IllegalStateException("restoring " + hs.id() + " timed out at tick "
						+ hs.tick() + " of " + tick);
			Thread.onSpinWait();
		}
	}

	/**
	 * The surrogate session id: the spec id for an unowned session (unchanged — the demo keeps
	 * its stable {@code "caravan-demo-<seed>"} id), else the spec id tagged with the owner so
	 * owned runs of the same spec (and different owners' runs) never collide. Kept deterministic
	 * so a re-founded spec+owner resumes its command log; Phase 2's session registry can replace
	 * this with an opaque minted id (see {@code docs/authentication.md}).
	 *
	 * @param spec  the founding spec
	 * @param owner the owning user id, or {@code null}/blank for an unowned/public session
	 * @return the session key
	 */
	public static String sessionKey(SessionSpec spec, String owner) {
		return owner == null || owner.isBlank() ? spec.id() : spec.id() + "@" + owner.trim();
	}

	/** The session with this id, or {@code null}. */
	/**
	 * Warn when a run is restored against a <b>different content version</b> than it was founded
	 * against.
	 * <p>
	 * Restoring replays the spec + command log, which reproduces the run only if the world it replays
	 * into is the same world. The content store changes independently of the code — and once balance
	 * data rides the bundle, a content edit moves the numbers the run was tuned with — so a restore
	 * across a version change is a run that will diverge from its own history.
	 * <p>
	 * A warning, not a refusal: the alternative is bricking every recorded run whenever content ships,
	 * which is worse than a run that drifts. This makes the drift <em>visible</em> instead of silent,
	 * which is the whole reason the column exists. A {@code null} on either side means "unknown" (a
	 * legacy row, or a source carrying no version) and says nothing either way.
	 *
	 * @param r the record being restored
	 */
	private static void warnIfContentMoved(SessionRecord r) {
		String founded = r.contentVersion();
		String now = com.civstudio.data.WorldSources.contentVersion();
		if (founded != null && now != null && !founded.equals(now))
			log.warning(() -> "restoring " + r.id() + ": founded against content version " + founded
					+ " but this process serves " + now
					+ " — the replay may diverge from the recorded run");
	}

	public HostedSession get(String id) {
		return sessions.get(id);
	}

	/** All hosted sessions. */
	public Collection<HostedSession> list() {
		return List.copyOf(sessions.values());
	}

	/** Stop and remove a session from this process (no-op if absent). Its record survives. */
	public void remove(String id) {
		HostedSession hs = sessions.remove(id);
		if (hs != null)
			hs.stop();
	}

	/**
	 * Stop a run and <b>erase every trace of it</b>, record and seats included — as though it had
	 * never been played.
	 * <p>
	 * For disposable fixtures only. Forgetting a ranked Timeline would hand every one of its players
	 * a fresh attempt and destroy its verdict, which is exactly what the registry exists to prevent;
	 * the demo, being a shop window rather than anyone's record, is the case this is for.
	 *
	 * @param id the run to forget
	 */
	public void forget(String id) {
		remove(id);
		registry.forget(id);
	}

	/** Stop and remove every session — the server-shutdown path. */
	public void stopAll() {
		for (String id : List.copyOf(sessions.keySet()))
			remove(id);
	}

	/**
	 * Graceful shutdown: stop every hosted session when the Spring context closes (a SIGTERM to
	 * the container, or a test context teardown). Stopping a session emits its final snapshot,
	 * which completes any open SSE stream — so the embedded server isn't left waiting on an
	 * open-ended async request. Replaces the old {@code ServerMain} JVM shutdown hook.
	 */
	@PreDestroy
	public void shutdown() {
		stopAll();
	}

	// found the session's world from the spec, resolving its scenario id through the ScenarioRegistry
	// (workstream B) — shape + balance profile as DATA rather than a hardcoded isTimeline() branch.
	private HostedSession build(String id, String owner, SessionKind kind, String mode,
			String difficulty, SessionSpec spec) {
		ScenarioDef def = ScenarioRegistry.get().resolve(spec.scenario());
		if (def == null) {
			// a scenario string the registry does not know — an old persisted session, or a typo.
			// Warn loudly and found a standard colony (what every non-timeline id did before), rather
			// than 404 a restore. The "standard" built-in is always present.
			log.warning(() -> "unknown scenario '" + spec.scenario() + "' — founding standard");
			def = ScenarioRegistry.get().resolve("standard");
		}
		SimulationConfig cfg = SimulationConfig.DEFAULT;
		// scenario flags may override the (since-2026-07-23 flag-on) plot/build-economy
		// defaults — the legacy-market scenario founds the pure-market collapse-era colony
		cfg = cfg.toBuilder()
				.homePlots(def.flag("homePlots", cfg.homePlots()))
				.buildEconomy(def.flag("buildEconomy", cfg.buildEconomy())).build();
		if (def.shape() == FoundingShape.TIMELINE)
			return buildTimeline(id, owner, kind, mode, difficulty, spec, cfg);
		if (def.shape() == FoundingShape.LEAGUE)
			return buildLeague(id, owner, kind, mode, difficulty, spec, cfg, def);
		// a CAMP scenario founds low and climbs the tier ladder; its flags carry the subsistence
		// home-plot economy the camp survives on (docs/settlement-tier-ladder-plan.md D4) and,
		// since B1, the build economy's occupation choice (docs/build-queue-plan.md)
		if (def.shape() == FoundingShape.CAMP)
			cfg = cfg.toBuilder().foundAtCamp(true).homePlots(def.flag("homePlots", false))
					.buildEconomy(def.flag("buildEconomy", false)).build();
		// SimulationHarness.create builds the GameSession, founds the colony into the
		// province, and installs the (now per-session) log — see docs/client-server.md
		SimulationHarness h = SimulationHarness.create(cfg, spec.seed(), spec.provinceId());
		// the scenario's agent-behaviour tuning — "default" is behaviour-neutral, so caravan-demo
		// and every legacy session found exactly as before (workstream A: BalanceProfiles)
		h.setBalanceProfile(BalanceProfiles.get().get(def.balanceProfile()));
		h.foundStandardColony();
		// a City colony musters winter foraging expeditions by default (docs/explorer-caravan.md),
		// which it drives and the render feed draws on the map; a Village founds none.
		Settlement colony = h.getColony();
		// spectator sessions show the district view (docs/district-buildout.md D5): let the hosted
		// colony auto-build its unlocked buildings onto its district plots as it researches. Off by
		// default in the engine (byte-identical headless runs); render-only, so no economic change.
		colony.setAutoBuildDistricts(true);
		GameSession session = colony.getSession();
		// No bands are hand-seeded any more: a City colony musters its OWN winter foraging explorers
		// (installExplorerProvisioning — the ruler drafts the pool's least-skilled adults each lean
		// season, docs/explorer-caravan.md). Those emergent levies pioneer trails the route layer draws
		// (gap B, docs/route-rendering.md), so the demo needs no directed caravans of its own.
		HostedSession hs = new HostedSession(id, owner, kind, mode, difficulty, spec, session,
				List.of(colony), cfg.startDate(), commandStore, chatStore);
		// resume: replay any previously-persisted commands (keyed by the surrogate id) into the
		// fresh session's log so state = f(spec, command log) holds across a restart
		for (GameCommand cmd : commandStore.load(id))
			hs.replay(cmd);
		return hs;
	}

	// A LEAGUE founds several peer cities into ONE province: the lead city and its vassal mayors.
	//
	// This is what a large historical city is, and docs/city-and-league.md settles the taxonomy —
	// several settlements under one name are NOT quarters of one city (that was the first sketch's
	// error), they are cities in a Rank.LEAGUE, the way the Hansa literally was. Nathalaire is the
	// worked case: the hand-drawn map (docs/towngen-port.md §2c) shows ten named quarters around one
	// bay, and the map data says they cannot be neighbouring provinces — province 451 has three land
	// neighbours, all rural. So they are ten cities sharing one province.
	//
	// Each vassal's ruler takes the lead city's ruler as its LIEGE, which is the existing feudal link
	// (docs/estate-system.md P3) applied across colonies rather than within one.
	private HostedSession buildLeague(String id, String owner, SessionKind kind, String mode,
			String difficulty, SessionSpec spec, SimulationConfig cfg, ScenarioDef def) {
		SimulationHarness lead = SimulationHarness.create(cfg, spec.seed(), spec.provinceId());
		lead.setBalanceProfile(BalanceProfiles.get().get(def.balanceProfile()));
		lead.foundStandardColony();
		Settlement first = lead.getColony();
		first.setAutoBuildDistricts(true);
		GameSession session = first.getSession();
		List<Settlement> colonies = new ArrayList<>();
		colonies.add(first);

		int size = Math.max(1, def.flag("leagueSize", 1));
		com.civstudio.geo.Province province = session.getWorldMap().province(spec.provinceId());
		// THE SITE BELONGS TO THE LEAD CITY; THE VASSALS FOUND AROUND IT (owner, 2026-07-28).
		// Nathalaire proper has all 63 of province 451's plots to itself — which is also what the
		// engine assumes, since it caps a settlement at its province's plot count and the cities
		// share one pool: a second city in 451 has nowhere to seat a firm. So the nine vassal
		// mayors found into the site's land neighbours, staying adjacent to it, which is what makes
		// this a conurbation rather than a scattered league.
		List<Integer> sites = leagueSites(session, spec.provinceId());
		// the site says what kind of league it grows: ADM development a conurbation, DIP a maritime
		// league of ports, MIL a war camp (LeagueFlavor). Only the contiguous forms are built —
		// a DIP league needs its cities scattered along a coast and tied by shipping, which is a
		// founding problem of its own, so it founds as a conurbation for now and says so.
		LeagueFlavor flavor = LeagueFlavor.named(def.flags().get("leagueFlavor") instanceof String s
				? s : null, LeagueFlavor.of(province));
		if (!flavor.isContiguous())
			log.info(() -> "league " + id + " is " + flavor + "-flavoured (" + province.name()
					+ "): founding it contiguously until scattered leagues are built");
		LeagueNames.Pool names = LeagueNames.pool(session, sites);
		for (int i = 1; i < size; i++) {
			Settlement vassal = null;
			for (int attempt = 0; attempt < sites.size() && vassal == null; attempt++) {
				int siteId = sites.get((i + attempt) % sites.size());
				com.civstudio.geo.Province at = session.getWorldMap().province(siteId);
				if (at == null)
					continue;
				try {
					Settlement c = session.newSettlement(names.next(siteId), cfg.startDate(),
							cfg.meanInitAgeYears(), cfg.targetNStock(), cfg.meanSkillMale(),
							cfg.meanSkillFemale(), at);
					com.civstudio.io.SimLog.bind(c);
					SimulationHarness h = new SimulationHarness(cfg, c);
					h.setBalanceProfile(BalanceProfiles.get().get(def.balanceProfile()));
					h.foundStandardColony();
					c.setAutoBuildDistricts(true);
					// the feudal link, across colonies: this city's crown answers to the league's
					if (c.getRuler() != null && first.getRuler() != null)
						c.getRuler().setLiege(first.getRuler());
					vassal = c;
				} catch (RuntimeException e) {
					// that province is full: try the next site rather than giving up on the city
					log.fine(() -> "league " + id + ": no room in " + siteId + " (" + e.getMessage()
							+ ")");
				}
			}
			if (vassal == null) {
				// every site is full — a league of what fits is a perfectly good league, and a demo
				// must not fail to boot over its tenth city
				int founded = colonies.size();
				log.warning(() -> "league " + id + " stopped at " + founded + " cities: its sites "
						+ sites + " are full");
				break;
			}
			colonies.add(vassal);
		}
		log.info(() -> "founded " + flavor + " league " + id + " — " + colonies.size() + " cities in "
				+ (province == null ? String.valueOf(spec.provinceId()) : province.name()));
		HostedSession hs = new HostedSession(id, owner, kind, mode, difficulty, spec, session,
				List.copyOf(colonies), cfg.startDate(), commandStore, chatStore);
		for (GameCommand cmd : commandStore.load(id))
			hs.replay(cmd);
		return hs;
	}

	/**
	 * The provinces a league's <b>vassal</b> cities may found into: the site's settleable land
	 * neighbours, in a stable order. The site itself is not among them — it belongs to the lead
	 * city, whose plot cap is the province. A conurbation grows over a border as readily as up to
	 * one; Nathalaire's bay is where four provinces meet.
	 */
	private static List<Integer> leagueSites(GameSession session, int siteId) {
		List<Integer> sites = new ArrayList<>();
		for (int nb : session.getWorldMap().neighbors(siteId)) {
			com.civstudio.geo.Province p = session.getWorldMap().province(nb);
			if (p != null && p.type() != null && p.type().isLand() && p.isSettleable())
				sites.add(nb);
		}
		return List.copyOf(sites);
	}

	// A ranked Timeline is born EMPTY: it founds no colony of its own and fills as players join
	// (joinTimeline), which is why it must be given its clock origin rather than read one off a
	// colony it does not yet have. House-owned (the `owner` a Timeline is created with is the house,
	// not a player) — each seat inside it is owned per colony instead. See docs/spectator-lobby.md.
	private HostedSession buildTimeline(String id, String owner, SessionKind kind, String mode,
			String difficulty, SessionSpec spec, SimulationConfig cfg) {
		GameSession session = new GameSession(spec.seed());
		HostedSession hs = new HostedSession(id, owner, kind, mode, difficulty, spec, session,
				List.of(), cfg.startDate(), commandStore, chatStore);
		for (GameCommand cmd : commandStore.load(id))
			hs.replay(cmd);
		return hs;
	}

	/**
	 * Seat a player in a ranked Timeline: pick their site, found their colony there, and claim it
	 * for them. <b>One colony per player per Timeline</b> — asking twice returns the seat you
	 * already hold rather than founding a second, so a double-click cannot make you two players.
	 * <p>
	 * Only before the gun ({@link HostedSession.State#CREATED}): every colony must start on the same
	 * day, or a late arrival founds into a century-old world. The colony is named for its province,
	 * so a Timeline reads as a map of real places.
	 *
	 * @param sessionId the Timeline's session id
	 * @param userId    the joining {@code app_user} id
	 * @return the player's colony (freshly founded, or the one they already hold)
	 * @throws IllegalArgumentException if there is no such session, it is not a Timeline, or the
	 *                                  user is not identified
	 * @throws IllegalStateException    if the Timeline has already started
	 */
	public synchronized Settlement joinTimeline(String sessionId, String userId) {
		if (userId == null || userId.isBlank())
			throw new IllegalArgumentException("a Timeline seat belongs to a player");
		HostedSession hs = sessions.get(sessionId);
		if (hs == null)
			throw new IllegalArgumentException("no session " + sessionId);
		if (!hs.isTimeline())
			throw new IllegalArgumentException("session " + sessionId + " is not a Timeline");
		Settlement held = hs.colonyOf(userId);
		if (held != null)
			return held; // idempotent: you already have your one seat
		// ...and the durable record has the last word on that. The live map above only knows this
		// process; the registry knows every process, so a redeploy cannot hand out a second seat.
		if (registry.seatOf(sessionId, userId).isPresent())
			throw new SessionRegistry.SeatTakenException(userId + " already holds a seat in "
					+ sessionId + " (its colony is not in this process — the run needs restoring)");
		if (hs.clock() != ClockState.CREATED)
			throw new IllegalStateException("Timeline " + sessionId
					+ " has already started — the roster is closed");

		int seatOrder = hs.colonies().size();
		Settlement colony = foundSeat(hs);
		// write the seat down BEFORE seating it in memory: if the constraint rejects it (a
		// concurrent join by the same player), the colony is simply never seated, and we would
		// rather waste a founding than hand one player two seats
		registry.seat(new SeatRecord(sessionId, userId, colony.getName(),
				colony.getProvince().id(), seatOrder));
		seat(hs, colony, userId);
		return colony;
	}

	// Found the NEXT seat's colony in `hs` — the site the picker gives for the colonies seated so
	// far. Shared by a join (which then records the seat) and a restore (which is replaying seats
	// already recorded), so both found by exactly the same path: that identity is what makes a
	// restored roster the same roster. The colony is not seated yet — the caller does that once it
	// is satisfied the seat is legitimate.
	private Settlement foundSeat(HostedSession hs) {
		SimulationConfig cfg = SimulationConfig.DEFAULT;
		GameSession session = hs.session();
		com.civstudio.geo.Province anchor = session.getWorldMap().province(hs.spec().provinceId());
		com.civstudio.geo.Province site = TimelineSites.pick(session.getWorldMap().provinces(),
				hs.colonies(), anchor);
		// A Timeline is one realm's ladder, and the guard for that is HERE — at the founding, not on
		// the map's edges. Cave mouths are freely walkable (docs/realms.md §Crossing a realm on foot),
		// so a colony CAN march out of its realm; what it may never do is come into being in another
		// one. Asserted rather than assumed: `pick` already filters, but this is the invariant, and a
		// second founding path must not be able to smuggle a colony into a ladder it is not in.
		if (hs.isTimeline() && anchor != null && !TimelineSites.canFound(site, anchor.realm()))
			throw new IllegalStateException("Timeline " + hs.id() + " is scoped to " + anchor.realm()
					+ " but the site " + site.name() + " is in " + site.realm()
					+ " (docs/realms.md §Ranked is per realm)");
		Settlement colony = session.newSettlement(site.name(), cfg.startDate(),
				cfg.meanInitAgeYears(), cfg.targetNStock(), cfg.meanSkillMale(),
				cfg.meanSkillFemale(), site);
		// the per-session log is initialised by the FIRST colony and bound for each one after, so
		// every colony's founding records carry it (the TwinSettlementEconomy pattern)
		if (hs.colonies().isEmpty())
			com.civstudio.io.SimLog.init(colony);
		else
			com.civstudio.io.SimLog.bind(colony);
		SimulationHarness h = new SimulationHarness(cfg, colony);
		h.foundStandardColony();
		colony.setAutoBuildDistricts(true);   // the district view, as the demo colony gets
		return colony;
	}

	// seat a founded colony and give it to its player
	private static void seat(HostedSession hs, Settlement colony, String userId) {
		hs.addColony(colony);
		hs.claimColony(colony.getName(), userId);
	}

}
