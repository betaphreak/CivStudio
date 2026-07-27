package com.civstudio.server;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.concurrent.CopyOnWriteArrayList;

import com.civstudio.agent.Caravan;
import com.civstudio.io.SimLog;
import com.civstudio.server.command.CommandLog;
import com.civstudio.server.command.CommandStore;
import com.civstudio.server.command.GameCommand;
import com.civstudio.server.chat.ChatStore;
import com.civstudio.server.render.ChatMessage;
import com.civstudio.server.render.LogLine;
import com.civstudio.server.render.SessionEventLog;
import com.civstudio.server.render.SessionLogBuffer;
import com.civstudio.server.render.SessionSnapshot;
import com.civstudio.server.render.Snapshots;
import com.civstudio.settlement.GameSession;
import com.civstudio.agent.Member;
import com.civstudio.agent.SettlerCaravan;
import com.civstudio.settlement.Settlement;
import com.civstudio.util.Rng;

import lombok.extern.java.Log;

/**
 * One authoritative, hosted run of a {@link GameSession} — the server-side unit a browser
 * spectator subscribes to (see {@code docs/client-server.md}, Phase A). The host owns the
 * <b>tick authority</b>: a single loop, on its own (virtual) thread, that advances the
 * session one in-game day per tick, applies any due {@linkplain CommandLog commands} at the
 * deterministic <em>top of the tick</em>, and emits a render {@link SessionSnapshot} to its
 * subscribers.
 * <p>
 * <b>Determinism.</b> The colonies are advanced <em>sequentially</em> in lockstep (each
 * colony's whole day, in turn). Colonies never read one another mid-day (they draw from
 * disjoint RNG/name/mortality partitions — see {@code GameSession}), so this is
 * bit-identical to the concurrent lockstep of {@link
 * com.civstudio.simulation.SessionRunner}, while giving the host trivial, race-free control
 * over pacing. Pause/resume/step/rate affect only <em>wall-clock timing</em>, never sim
 * results; only commands change state, and they are tick-stamped, so any two replays of the
 * same spec + command log produce identical state.
 * <p>
 * <b>Snapshots are assembled on this thread</b> (in {@link #emit()}, between ticks) and
 * cached; a subscriber — including a late joiner — receives the cached last snapshot, so
 * the projection never races {@code newDay}, and a slow subscriber never stalls the sim
 * (the transport is expected to hand off to its own buffer).
 */
@Log
public final class HostedSession {

	// The run's control state is two orthogonal axes now, not one five-value enum: ClockState (what the
	// clock is doing) and Outcome (how it ended). See docs/session-management.md and the fields below.

	private final String id;
	// the app_user id that owns this run, or null for an unowned (public) session such as the
	// server-seeded demo. Write commands/control are gated on this (see SessionController); an
	// unowned session stays open to anyone, an owned one only to its owner. Phase 1 of the auth
	// work (docs/authentication.md) — real owners arrive with login in Phase 2.
	private final String owner;
	private final SessionSpec spec;
	// The run's taxonomy (docs/session-management.md): kind is the visibility/auth category, mode the
	// variant within it (open set, may be null), difficulty a Civ4 handicap key (may be null). Metadata
	// alongside the spec — not part of the reproducibility root — like the owner above.
	private final SessionKind kind;
	private final String mode;
	private final String difficulty;
	private final GameSession session;
	// The session's colonies. Mutable, but ONLY while CREATED: a Timeline is born empty and fills
	// as players join, then the gun fires and the roster is closed for the run (docs/spectator-lobby.md
	// Phase 3). Copy-on-write because joins arrive on HTTP threads while the session thread reads.
	private final List<Settlement> colonies = new CopyOnWriteArrayList<>();

	// Per-COLONY owners, by colony name — the seam a shared world needs (docs/spectator-lobby.md
	// Phase 2). `owner` above is who owns the RUN; this is who owns each seat in it. They coincide
	// for a single-player run (one colony, one owner) and for the demo (unowned), and diverge in a
	// royale Timeline: one house-owned session holding many players' colonies, where "may you
	// command this?" is a question about the COLONY, not the run. Empty until a colony is claimed;
	// ownerOf() falls back to the run's owner, which is what keeps today's sessions behaving
	// exactly as before. Concurrent: claims arrive on HTTP threads, reads on the session thread.
	private final java.util.concurrent.ConcurrentMap<String, String> colonyOwners =
			new java.util.concurrent.ConcurrentHashMap<>();
	private final CommandLog commandLog = new CommandLog();
	private final CommandStore commandStore;
	private final ChatStore chatStore;
	private final List<Consumer<SessionSnapshot>> subscribers = new CopyOnWriteArrayList<>();

	// the authoritative tick — in-game days elapsed; volatile so control/HTTP threads read
	// a fresh value while the session thread advances it
	private volatile long tick = 0;

	// The run's clock origin: the colonies' founding date. The session's date is derived from this
	// plus the tick above (see date()) — it is NOT scavenged from whichever colonies are still
	// alive, which is what let the last colony's death freeze every wandering band with it.
	// See docs/spectator-lobby.md §Phase 0.
	private final LocalDate startDate;

	// the two control axes (docs/session-management.md). clock: what the clock is doing. outcome: how
	// the run ended (LIVE until it does). volatile so control/HTTP threads read fresh values while the
	// session thread advances them. outcome is written BEFORE clock flips to STOPPED in run()'s finally,
	// so anything that sees the clock stopped also sees the decided outcome.
	private volatile ClockState clock = ClockState.CREATED;
	private volatile Outcome outcome = Outcome.LIVE;

	// why the run ended, once it has (null until then) — display text for the client's terminal
	// screen. Set on the session thread before the clock flips to STOPPED; volatile so an HTTP
	// thread that sees a decided outcome also sees the reason that was written before it.
	private volatile String endReason;

	// notified when the run reaches a terminal state, so the host can write it down before this
	// process forgets (docs/spectator-lobby.md Phase 6). Best-effort and never allowed to wedge the
	// teardown: a registry that throws must not take the session's thread with it.
	private volatile EndListener onEnd = (hs, clock, outcome, reason, tick) -> {
	};

	/**
	 * Notified once, on the session thread, when a run's clock stops — <b>before</b> the stop is
	 * published, so anything that can see the ending can trust the record of it.
	 * <p>
	 * The terminal values are passed rather than read back off the session precisely because they
	 * are not published yet: {@code session.clock()}/{@code outcome()} still read the pre-terminal
	 * values here.
	 */
	@FunctionalInterface
	public interface EndListener {
		/**
		 * @param session   the run that stopped
		 * @param clock     its terminal {@link ClockState} (always {@link ClockState#STOPPED})
		 * @param outcome   its {@link Outcome} — {@link Outcome#LIVE} if stopped from outside, else the
		 *                  decided verdict
		 * @param endReason why it ended, or {@code null} if it was stopped from outside
		 * @param tick      the tick it reached
		 */
		void ended(HostedSession session, ClockState clock, Outcome outcome, String endReason, long tick);
	}

	// wall-clock milliseconds per tick when RUNNING (0 = as fast as possible); a live knob
	// (the server ticks ~one in-game day per second by default — see ServerMain)
	private volatile long tickRateMillis = 1000;

	// emit a snapshot every N ticks (1 = every day); a throttle for high tick rates
	private volatile int snapshotEveryTicks = 1;

	// the last snapshot assembled on the session thread — handed to late subscribers so the
	// projection is never built off-thread (which would race newDay's agent-set mutation)
	private volatile SessionSnapshot lastSnapshot;

	// holds the session's event-log lines between emits; a SimLog tap fills it on the colony
	// threads, emit() drains it into each snapshot (the browser's live log bar). See run()/emit().
	private final SessionLogBuffer logBuffer = new SessionLogBuffer();

	// a retained rolling tail of the same lines (fed by the same tap, but never drained), so the
	// get_events tool / events MCP resource can serve real history rather than the per-frame delta.
	private final SessionEventLog eventLog = new SessionEventLog();

	// lobby chat: an immediate broadcast channel, separate from the tick-paced snapshot feed (so
	// messages don't wait up to a tick). Persistence + the replay backlog live in the ChatStore;
	// chatLock serializes a subscribe (replay + add) against a post (append + broadcast) so no
	// message is missed or double-delivered.
	private static final int CHAT_REPLAY = 40;   // messages replayed to a newly-connected spectator
	private final Object chatLock = new Object();
	private final java.util.List<Consumer<ChatMessage>> chatSubscribers = new java.util.ArrayList<>();

	// pause/step coordination: the session thread waits on `gate` while PAUSED with no step
	// credit; control threads mutate stepCredits/state under `gate` and notify
	private final Object gate = new Object();
	private int stepCredits = 0;

	private Thread thread;

	/**
	 * Build a hosted session over an already-founded (not yet started) session and its
	 * colonies. The {@link SessionHost} founds these from a {@link SessionSpec} and assigns the
	 * surrogate id and owner (the id keys the {@link SessionHost} registry and the command log;
	 * the owner gates writes — see {@code docs/authentication.md}).
	 *
	 * @param id       the session's surrogate id (registry + command-log key)
	 * @param owner    the owning {@code app_user} id, or {@code null} for an unowned/public
	 *                 session (the server-seeded demo)
	 * @param kind     the run's {@link SessionKind} — its visibility/auth category
	 * @param mode     the mode variant within the kind (open set), or {@code null} for the default
	 * @param difficulty the Civ4 handicap key, or {@code null} for the default
	 * @param spec     the founding spec (seed/scenario/province — the determinism root)
	 * @param session   the game session (owns the seed, world map and wandering bands)
	 * @param colonies  the session's founding colonies (advanced in lockstep each tick) — empty for
	 *                  a Timeline, which fills as players join
	 * @param startDate the run's clock origin: the date its colonies are founded on. Given rather
	 *                  than read off a colony, so an empty Timeline still knows what day it is —
	 *                  the session's clock is a property of the run (see {@link #date()})
	 */
	public HostedSession(String id, String owner, SessionKind kind, String mode, String difficulty,
			SessionSpec spec, GameSession session,
			List<Settlement> colonies, LocalDate startDate, CommandStore commandStore,
			ChatStore chatStore) {
		this.id = id;
		this.owner = owner;
		this.kind = kind == null ? SessionKind.of(owner, spec) : kind;
		this.mode = mode;
		this.difficulty = difficulty;
		this.spec = spec;
		this.session = session;
		this.colonies.addAll(colonies);
		this.commandStore = commandStore;
		this.chatStore = chatStore;
		this.startDate = startDate;
	}

	/** Start ticking freely (paced by the tick rate). */
	public void start() {
		launch(ClockState.RUNNING);
	}

	/** Start halted — advance only via {@link #step(int)} (used by deterministic tests). */
	public void startPaused() {
		launch(ClockState.PAUSED);
	}

	private synchronized void launch(ClockState initial) {
		if (thread != null)
			throw new IllegalStateException("session " + id + " already started");
		// An empty run has nobody to simulate — and worse, it would look FINISHED: allDead() over an
		// empty roster is vacuously true, so the loop would break on its first pass and report game
		// over. A Timeline nobody joined is not a Timeline anyone won; refuse the gun instead.
		if (colonies.isEmpty())
			throw new IllegalStateException("session " + id + " has no colonies — nothing to run"
					+ (isTimeline() ? " (no player has joined this Timeline)" : ""));
		clock = initial;
		thread = Thread.ofVirtual().name("session-" + id).start(this::run);
	}

	/** Pause a running session (no-op if not RUNNING). */
	public void pause() {
		synchronized (gate) {
			if (clock == ClockState.RUNNING)
				clock = ClockState.PAUSED;
			gate.notifyAll();
		}
	}

	/** Resume a paused session (no-op if not PAUSED). */
	public void resume() {
		synchronized (gate) {
			if (clock == ClockState.PAUSED) {
				clock = ClockState.RUNNING;
				gate.notifyAll();
			}
		}
	}

	/**
	 * Advance a paused session by {@code n} ticks, then pause again — deterministic
	 * single-stepping. A no-op unless PAUSED.
	 *
	 * @param n the number of ticks to advance
	 */
	public void step(int n) {
		if (n <= 0)
			return;
		synchronized (gate) {
			if (clock == ClockState.PAUSED) {
				stepCredits += n;
				gate.notifyAll();
			}
		}
	}

	/** Stop the session for good and wait for its thread to finish. */
	public void stop() {
		Thread t;
		synchronized (gate) {
			// Signal the loop to exit; the finally finalizes clock/outcome. This never touches the
			// OUTCOME: a run that ended itself keeps its decided verdict (game over), and a run stopped
			// from outside stays LIVE — a stopped-from-outside session is restorable (a redeploy brings
			// it back), which is what keeps a shutdown from permanently killing everything it touched.
			if (clock != ClockState.STOPPED)
				clock = ClockState.STOPPED;
			gate.notifyAll();
			t = thread;
		}
		if (t != null) {
			t.interrupt(); // break a rate-limit sleep
			try {
				t.join();
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
		}
	}

	/** Set the wall-clock milliseconds per tick when running (0 = uncapped). */
	public void setTickRateMillis(long millis) {
		this.tickRateMillis = Math.max(0, millis);
	}

	/** The wall-clock milliseconds per tick when running (0 = uncapped) — so a caller that borrows
	 *  the clock (the restore fast-forward) can hand it back. */
	public long tickRateMillis() {
		return tickRateMillis;
	}

	/** Set the snapshot cadence (emit every {@code n} ticks; clamped to at least 1). */
	public void setSnapshotEveryTicks(int n) {
		this.snapshotEveryTicks = Math.max(1, n);
	}

	/**
	 * Submit a {@linkplain GameCommand command} to this session's log — the interactive
	 * seam (empty during spectator play). Applied at the top of its tick on the session
	 * thread.
	 *
	 * @param command the command to enqueue
	 */
	public void submit(GameCommand command) {
		commandStore.append(id, command); // durable first, so a restart can replay it
		commandLog.append(command);
		// the B6 interrupt's other half: submitting the build choice resumes a session
		// auto-paused awaiting it (the command applies at the top of the next tick)
		if (command instanceof com.civstudio.server.command.QueueBuildCommand)
			resume();
	}

	/**
	 * Append a persisted command to the log without re-persisting it — the resume path. Called
	 * by {@link SessionHost} when it re-founds a session, so the loaded command log replays at
	 * its recorded ticks as the session advances (state = f(spec, command log)).
	 *
	 * @param command a command loaded from the {@link CommandStore}
	 */
	public void replay(GameCommand command) {
		commandLog.append(command);
	}

	/**
	 * Subscribe to this session's snapshot feed. The subscriber is immediately handed the
	 * current cached snapshot (if any), then every subsequent emission. Returns a handle
	 * that unsubscribes when closed. The subscriber runs on the session thread, so it must
	 * not block (a transport hands the snapshot to its own buffer).
	 * <p>
	 * The catch-up frame is <b>delta-free</b> ({@link SessionSnapshot#withoutDeltas()}): a joiner did
	 * not see the previous frame, so its {@code log}/{@code routeDirty} deltas would be replayed
	 * history, not news. Subsequent emissions carry their deltas normally.
	 *
	 * @param subscriber the snapshot consumer
	 * @return an unsubscribe handle
	 */
	public AutoCloseable subscribe(Consumer<SessionSnapshot> subscriber) {
		subscribers.add(subscriber);
		SessionSnapshot snap = lastSnapshot;
		if (snap != null)
			subscriber.accept(snap);
		return () -> subscribers.remove(subscriber);
	}

	/**
	 * Post a lobby chat message: append it to the replay backlog and broadcast it immediately to
	 * every chat subscriber. Called off the session thread (an HTTP request thread); the subscribers'
	 * consumers must not block (each hands the message to its own SSE buffer).
	 *
	 * @param user the poster's display name (server-resolved, not client-supplied)
	 * @param text the message body
	 */
	public void postChat(String user, String text) {
		ChatMessage msg = new ChatMessage(user, text);
		synchronized (chatLock) {
			chatStore.append(id, user, text);   // persist (durable when a datasource is configured)
			for (Consumer<ChatMessage> c : chatSubscribers)
				try {
					c.accept(msg);
				} catch (RuntimeException e) {
					// a slow/broken chat subscriber must never break the broadcast
				}
		}
	}

	/**
	 * Subscribe to this session's chat channel. The current backlog is replayed to {@code sub} on
	 * subscribe (so a late joiner sees recent messages), then every subsequent post. Returns an
	 * unsubscribe handle.
	 *
	 * @param sub the chat-message consumer
	 * @return an unsubscribe handle
	 */
	public AutoCloseable subscribeChat(Consumer<ChatMessage> sub) {
		synchronized (chatLock) {
			for (ChatMessage m : chatStore.recent(id, CHAT_REPLAY))
				try {
					sub.accept(m);
				} catch (RuntimeException ignored) {
					// best-effort backlog replay
				}
			chatSubscribers.add(sub);
		}
		return () -> {
			synchronized (chatLock) {
				chatSubscribers.remove(sub);
			}
		};
	}

	/** This session's id. */
	public String id() {
		return id;
	}

	/**
	 * Why the run ended, as display text for a client's game-over screen ({@code "the survivors —
	 * 4 adults and 2 children — abandoned Dhenijansar on 1452-03-02"}), or {@code null} while it has
	 * not ended itself. Only
	 * ever set alongside {@link State#GAME_OVER} — a session stopped from outside has no reason,
	 * because it did not reach an end.
	 *
	 * @return the end reason, or {@code null}
	 */
	public String endReason() {
		return endReason;
	}

	/**
	 * Whether the clock has stopped — its thread has exited, so it will not tick again <em>in this
	 * process</em>. True both for a run stopped from outside (still restorable) and one that ended
	 * itself; the SSE feed closes on this, and the client shows its terminal screen and disables
	 * play/pause. To ask instead whether the run is <em>finished for good</em> (never restored),
	 * see {@link #isFinished()}.
	 *
	 * @return {@code true} if this session's clock has stopped
	 */
	public boolean isTerminal() {
		return clock == ClockState.STOPPED;
	}

	/**
	 * Whether the run reached its own end — its {@link Outcome} is decided (won / lost / abandoned).
	 * A finished run never ticks again, holds no save slot, and is never restored. Deliberately not
	 * the same as {@link #isTerminal()}: a run stopped from outside is terminal but not finished — it
	 * stays {@link Outcome#LIVE} and comes back on restore. See {@code docs/game-over.md}.
	 *
	 * @return {@code true} if the run ended itself
	 */
	public boolean isFinished() {
		return outcome.isDecided();
	}

	/**
	 * The session's in-game date — its {@linkplain #tick() tick} counted forward from the run's
	 * founding date. <b>The session's own clock:</b> it does not ask the colonies what day it is,
	 * so it keeps time even when none of them is left to answer.
	 * <p>
	 * Identical to a living colony's {@code getDate()} — both are {@code startDate + steps}, and a
	 * live colony steps exactly once per tick. The difference only shows once nothing is alive: the
	 * colonies' dates freeze where they died, while the session's clock is free to run on (which is
	 * what lets wandering bands outlive their colony). See {@code docs/spectator-lobby.md} §Phase 0.
	 *
	 * @return the session's current in-game date
	 */
	public LocalDate date() {
		return startDate.plusDays(tick);
	}

	/**
	 * The owning {@code app_user} id, or {@code null} if this is an unowned/public session
	 * (the server-seeded demo). Control/command writes are gated on this — an unowned session
	 * is open to anyone, an owned one only to its owner (see {@code docs/authentication.md}).
	 */
	public String owner() {
		return owner;
	}

	/** This session's founding spec. */
	public SessionSpec spec() {
		return spec;
	}

	/** The authoritative tick (in-game days elapsed). */
	public long tick() {
		return tick;
	}

	/** What the clock is doing (created / running / paused / stopped). */
	public ClockState clock() {
		return clock;
	}

	/** The contest result — {@link Outcome#LIVE} until the run ends itself. */
	public Outcome outcome() {
		return outcome;
	}

	/** The run's kind — its visibility/auth category (docs/session-management.md). */
	public SessionKind kind() {
		return kind;
	}

	/** The mode variant within the kind (open set), or {@code null} for the default. */
	public String mode() {
		return mode;
	}

	/** The Civ4 handicap key, or {@code null} for the default. */
	public String difficulty() {
		return difficulty;
	}

	/** The underlying game session (seed, world map, wandering bands). */
	public GameSession session() {
		return session;
	}

	/**
	 * How many connections are watching this run right now — the eye count on a lobby row. Counts the
	 * snapshot subscribers (open SSE feeds), which is what "watching" means here.
	 *
	 * @return the spectator count
	 */
	public int spectators() {
		return subscribers.size();
	}

	/** The session's colonies. */
	public List<Settlement> colonies() {
		return java.util.Collections.unmodifiableList(colonies);
	}

	/** Whether this run is a shared ranked {@linkplain SessionSpec#TIMELINE Timeline}. */
	public boolean isTimeline() {
		return spec.isTimeline();
	}

	/**
	 * Be told when this run reaches a terminal state. The {@link SessionHost} uses it to write the
	 * outcome down; a listener that throws is swallowed, because a failed record must not wedge the
	 * session's teardown.
	 *
	 * @param listener the listener (replaces any previous one)
	 */
	public void onEnd(EndListener listener) {
		this.onEnd = listener == null ? (hs, c, o, r, t) -> {
		} : listener;
	}

	/**
	 * Seat a freshly-founded colony in this run — the join seam. Allowed <b>only before the gun</b>
	 * ({@link State#CREATED}): every colony in a Timeline must start on the same day, or a late
	 * arrival is founding into a century-old world, which is the unfairness Timelines exist to
	 * prevent. {@link SessionHost#joinTimeline} founds the colony and calls this.
	 *
	 * @param colony the founded colony
	 * @throws IllegalStateException if the run has already started
	 */
	public void addColony(Settlement colony) {
		synchronized (gate) {
			if (clock != ClockState.CREATED)
				throw new IllegalStateException(
						"session " + id + " has already started (" + clock + ") — the roster is closed");
			colonies.add(colony);
		}
	}

	/** The colony this user holds in this run, or {@code null} — one seat per player. */
	public Settlement colonyOf(String userId) {
		for (Settlement c : colonies)
			if (userId != null && userId.equals(ownerOf(c.getName())))
				return c;
		return null;
	}

	/** How many colonies are still standing — a Timeline's survivor count. */
	public int survivors() {
		int alive = 0;
		for (Settlement c : colonies)
			if (!c.isDead())
				alive++;
		return alive;
	}

	/**
	 * The session's colony of that name, or {@code null} if it has none. Colony names are drawn
	 * from the seed, so they are stable across a replay of the same spec — which is what lets a
	 * command name its target by name and still replay deterministically.
	 *
	 * @param colonyName the colony's name
	 * @return the colony, or {@code null}
	 */
	public Settlement colonyByName(String colonyName) {
		if (colonyName == null)
			return null;
		for (Settlement c : colonies)
			if (c.getName().equals(colonyName))
				return c;
		return null;
	}

	/**
	 * Who owns the named colony — the seat, not the run. A colony {@linkplain #claimColony claimed}
	 * by a player belongs to that player; an unclaimed one belongs to whoever owns the run, so a
	 * single-player colony answers with its owner and the unowned demo's answers {@code null}
	 * (unowned — any signed-in user may act, as before).
	 * <p>
	 * This is the question a write should ask in a shared world: in a royale Timeline the run is
	 * house-owned while each colony has its own player. See {@code docs/spectator-lobby.md} Phase 2.
	 *
	 * @param colonyName the colony's name
	 * @return the owning {@code app_user} id, or {@code null} if the colony is unowned
	 */
	public String ownerOf(String colonyName) {
		String claimed = colonyOwners.get(colonyName);
		return claimed != null ? claimed : owner;
	}

	/**
	 * Claim a colony for a player — the join seam (a player taking a seat in a shared world).
	 * A colony may be claimed only once: re-claiming it for the same user is a no-op, and claiming
	 * someone else's is rejected, so a seat cannot be taken from under its owner.
	 *
	 * @param colonyName the colony to claim
	 * @param userId     the claiming {@code app_user} id
	 * @throws IllegalArgumentException if the session has no such colony, or {@code userId} is blank
	 * @throws IllegalStateException    if the colony is already claimed by someone else
	 */
	public void claimColony(String colonyName, String userId) {
		if (userId == null || userId.isBlank())
			throw new IllegalArgumentException("a colony is claimed by a user");
		if (colonyByName(colonyName) == null)
			throw new IllegalArgumentException("no colony " + colonyName + " in session " + id);
		String prior = colonyOwners.putIfAbsent(colonyName, userId);
		if (prior != null && !prior.equals(userId))
			throw new IllegalStateException("colony " + colonyName + " is already claimed");
	}

	/** The command log (the session's ordered input/replay history). */
	public CommandLog commandLog() {
		return commandLog;
	}

	/**
	 * The last emitted snapshot, <b>delta-free</b>, or {@code null} before the first emission.
	 * <p>
	 * {@code log} and {@code routeDirty} are always empty here: this is the one-shot read (used by
	 * {@code GET /api/sessions/{id}/snapshot} and the {@code get_snapshot} MCP tool), and its caller
	 * by definition did not see the previous frame. Read history from {@link #eventTail}.
	 */
	public SessionSnapshot currentSnapshot() {
		return lastSnapshot;
	}

	/**
	 * The retained tail of this session's event log (foundings, deaths, policy changes, …), filtered
	 * by minimum severity, in-game date range and substring. Unlike {@link #currentSnapshot()}'s
	 * per-frame log delta this is a rolling window of history — the read seam for the {@code
	 * get_events} MCP tool / {@code events} resource. Read-only; safe on any thread.
	 *
	 * @see com.civstudio.server.render.SessionEventLog#query
	 */
	public List<LogLine> eventTail(String level, String from, String to, String grep, int limit) {
		return eventLog.query(level, from, to, grep, limit);
	}

	// the session thread's body: start the colonies, then tick until they are all done or
	// the session is stopped, applying commands and emitting snapshots along the way
	private void run() {
		// records emitted on this thread carry (and route to) this session's colony/log
		SimLog.bind(colonies.get(0));
		// tap this session's log into the snapshot feed before founding, so the "was founded"
		// lines are captured; closed in the finally below when the session tears down
		AutoCloseable logTap = SimLog.tap(colonies.get(0), e -> {
			logBuffer.add(e.date(), e.message(), e.level(), e.rank());
			eventLog.add(e.date(), e.message(), e.level(), e.rank());
		});
		for (Settlement c : colonies)
			c.start();
		// the B6 seated-session mode: a player-driven run (SINGLE_PLAYER, and the DEMO — a
		// visitor chooses for the shop-window colony) turns the ruler-queue heuristic OFF, so
		// an empty queue genuinely idles and raises the pause-and-choose interrupt below. The
		// shared TIMELINE keeps the heuristic — its lockstep world must never freeze on one
		// seat's empty queue. (SessionKind.playerChoosesBuilds is the single home for the rule.)
		// In tests there is NO player to answer the interrupt, so a paused session would hang
		// forever — the test tier sets civstudio.buildchoice.interactive=false to keep the
		// heuristic on (auto-build, never pause). See interactiveBuildChoice().
		if (kind().playerChoosesBuilds() && interactiveBuildChoice())
			for (Settlement c : colonies)
				if (c.getBuildEconomy() != null)
					c.getBuildEconomy().setHeuristicEnabled(false);
		emit(); // tick-0 snapshot, so a subscriber (even to a paused session) sees state
		// which of the two exits fired: the run reaching its own end (game over) or a stop() from
		// outside. Knowable here and nowhere else — the finally cannot tell them apart after the fact.
		boolean endedItself = false;
		try {
			while (true) {
				if (!awaitTickPermit())
					break; // stopped from outside
				if (runOver()) {
					endedItself = true; // the run reached its own end — game over
					break;
				}
				long entering = tick;
				// deterministic top-of-tick: apply the commands due for this tick
				for (GameCommand cmd : commandLog.drainDueBy(entering))
					cmd.apply(this);
				advanceOneDay();
				tick++;
				if (tick % snapshotEveryTicks == 0)
					emit();
				maybeAwaitBuildChoice();
			}
		} finally {
			for (Settlement c : colonies) {
				try {
					c.finishRun();
				} catch (RuntimeException e) {
					// finalization is best-effort; a botched teardown must not wedge the host
				}
			}
			// the reason is read AFTER finishRun: that is where a dissolving colony actually
			// departs as its band (SettlementLifecycle.finishRun), so before it there is nothing
			// to tell "died" from "departed as a Caravan".
			Outcome finalOutcome = endedItself ? decideOutcome() : Outcome.LIVE;
			endReason = endedItself ? describeEnd() : null;
			// Write the outcome down BEFORE publishing the stop. Anything that can see the run has ended
			// — a client reading the final snapshot, a caller polling outcome() — must be able to trust
			// that the record already says so, or it can read a registry that has not caught up and
			// conclude the run is still open. Set outcome before the clock flips (below) for the same
			// reason: a reader that sees the clock stopped must also see the decided outcome.
			try {
				onEnd.ended(this, ClockState.STOPPED, finalOutcome, endReason, tick);
			} catch (RuntimeException e) {
				log.warning(() -> "could not record the end of session " + id + ": " + e);
			}
			outcome = finalOutcome;
			clock = ClockState.STOPPED;
			emit(); // final snapshot so clients see the terminal state
			try {
				logTap.close();
			} catch (Exception ignored) {
				// unregistering the tap is best-effort
			}
			SimLog.closeSession(colonies.get(0));
		}
	}

	// advance every live colony one in-game day (sequential lockstep), then the session's
	// wandering bands — the marching six of the demo (see docs/caravan-march.md)
	private void advanceOneDay() {
		for (Settlement c : colonies)
			if (!c.isDead())
				c.newDay();
		// The day the colonies just stepped INTO. `tick` is still the day we entered — the loop
		// increments it after this returns — so the day now in progress is tick + 1.
		//
		// This used to be the max date over the LIVE colonies, which meant the bands' clock died
		// with the last colony (tickBands no-ops on a null date), stranding the very band a
		// dissolving colony had just departed as. The session's own clock has no such gap.
		// Identical while any colony lives: both are startDate + steps. See docs/spectator-lobby.md.
		tickBands(startDate.plusDays(tick + 1));
	}

	// advance the session's wandering bands one day on the session band RNG — single-
	// threaded here (the whole session ticks on this one thread), so it is deterministic;
	// labelled (realm) since a band belongs to no one colony. Draws nothing with no bands.
	private void tickBands(LocalDate date) {
		List<Caravan> bands = session.getCaravans();
		if (bands.isEmpty())
			return;
		// NB no null-date guard any more: the date is the session's own clock, which always knows
		// what day it is. It was that guard — reached whenever no colony was left to date the day —
		// that froze the bands the moment their colony died.
		final LocalDate d = date;
		SimLog.asRealm(colonies.get(0), () -> {
			Rng rng = session.getBandRng();
			for (Caravan band : bands)
				band.tick(d, rng);
			// bury the day's dead before the snapshot is built, so a band that starved out
			// stops being drawn as a live marker with a head-count of zero
			for (Caravan dead : session.pruneSpentCaravans())
				log.info("A band under " + dead.getLeader()
						+ " starved out on the road and was lost, on " + d + ".");
		});
	}

	// block while paused with no step credit; consume one credit per stepped tick; pace a
	// freely-running session by the tick rate. Returns false once the session is stopped.
	private boolean awaitTickPermit() {
		synchronized (gate) {
			while (clock == ClockState.PAUSED && stepCredits == 0)
				try {
					gate.wait();
				} catch (InterruptedException e) {
					Thread.currentThread().interrupt();
					return false;
				}
			if (clock == ClockState.STOPPED)
				return false;
			if (clock == ClockState.PAUSED && stepCredits > 0)
				stepCredits--; // spend one step; loop back to PAUSED after this tick
		}
		// pace only a freely-running session (a single-step advances immediately)
		if (clock == ClockState.RUNNING && tickRateMillis > 0)
			try {
				Thread.sleep(tickRateMillis);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return false;
			}
		return clock != ClockState.STOPPED;
	}

	private boolean allDead() {
		return survivors() == 0;
	}

	// Has the run reached its own end? Scenario-aware, because "over" means different things:
	//   - a single-player run ends when its colony dies (nothing left to watch);
	//   - a TIMELINE ends when at most ONE colony stands — the contest is decided, and the last
	//     player standing has won; there is no one left for them to outlive.
	// A solo Timeline (only one player joined) is the exception: with no rival to outlive it would
	// be "won" before the gun, so it runs until its colony dies, like a single-player run.
	private boolean runOver() {
		if (!isTimeline())
			return allDead();
		return colonies.size() >= 2 ? survivors() <= 1 : allDead();
	}

	// The decided Outcome for a run that ended itself — the machine-readable peer of describeEnd()'s
	// text, read from the same engine state (finishRun has run, so a dissolved colony has its band), so
	// the two can never disagree:
	//   - a TIMELINE with rivals ends in a verdict — WON if a colony still stands, else LOST;
	//   - otherwise the survivors either departed as a band (ABANDONED) or the colony died (LOST).
	private Outcome decideOutcome() {
		if (isTimeline() && colonies.size() >= 2) {
			for (Settlement c : colonies)
				if (!c.isDead())
					return Outcome.WON;
			return Outcome.LOST;
		}
		for (Settlement c : colonies)
			if (c.getDepartedBand() != null)
				return Outcome.ABANDONED;
		return Outcome.LOST;
	}

	// Why this run ended, in the words a player should read. Called from the finally, after
	// finishRun, so a dissolved colony has its band by now. The engine already distinguishes the two
	// endings (SettlementLifecycle: a colony that crossed the workforce floor departs as a
	// SettlerCaravan; one that simply ran out of laborers does not), so this reads that state rather
	// than re-deriving the rule. Multi-colony sessions report each colony's fate — a Timeline's
	// "won by <name>" belongs here later (docs/game-over.md §Amendment).
	private String describeEnd() {
		// a Timeline ends in a VERDICT, not a post-mortem: the last colony standing won it
		if (isTimeline() && colonies.size() >= 2) {
			for (Settlement c : colonies)
				if (!c.isDead())
					return c.getName() + " stands alone and wins the Timeline on " + date();
			return "no colony survived the Timeline";
		}
		List<String> fates = new ArrayList<>();
		for (Settlement c : colonies) {
			String when = c.getDeathDate() == null ? "" : " on " + c.getDeathDate();
			SettlerCaravan band = c.getDepartedBand();
			if (band == null) {
				fates.add(c.getName() + " died" + when);
				continue;
			}
			// the survivors took to the road as a band rather than dying outright — report who
			// left (adults vs children, classified as of the colony's death) and the city they left
			LocalDate on = c.getDeathDate() != null ? c.getDeathDate() : date();
			int adults = 0, children = 0;
			for (Member m : bandMembers(band)) {
				if (m.isAdult(on))
					adults++;
				else
					children++;
			}
			fates.add("the survivors — " + plural(adults, "adult", "adults") + " and "
					+ plural(children, "child", "children") + " — abandoned " + c.getName() + when);
		}
		return String.join("; ", fates);
	}

	// the whole departed band: its following plus its leader (promoted out of the following, so
	// counted separately — guarded against a double-count should it ever appear in both)
	private static List<Member> bandMembers(SettlerCaravan band) {
		List<Member> all = new ArrayList<>(band.getFollowing().getMembers());
		Member leader = band.getLeader();
		if (leader != null && !all.contains(leader))
			all.add(leader);
		return all;
	}

	// "1 adult" / "3 adults"
	private static String plural(int n, String one, String many) {
		return n + " " + (n == 1 ? one : many);
	}

	// Whether the pause-and-choose interrupt is live (default true). The test tier disables it
	// (-Dcivstudio.buildchoice.interactive=false): a test has no player to answer the modal, so a
	// paused session would hang the suite — with it off the heuristic stays on and colonies
	// auto-build instead. Production (and the deployed demo) leaves it on.
	private static boolean interactiveBuildChoice() {
		return Boolean.parseBoolean(System.getProperty("civstudio.buildchoice.interactive", "true"));
	}

	// the B6 auto-pause (docs/build-queue-plan.md): a player-driven (SINGLE_PLAYER or DEMO)
	// session whose build-economy colony awaits a queue choice pauses itself between ticks —
	// clock state only, never sim state, so replay is untouched. The snapshot (emitted
	// immediately so the modal shows without waiting for the next cadence frame) carries the
	// awaiting flag + candidates; submitting queue_build resumes (see submit()).
	private void maybeAwaitBuildChoice() {
		if (!kind().playerChoosesBuilds() || !interactiveBuildChoice())
			return;
		// An order already submitted is an answer already given. A command stamped for the NEXT
		// tick is not yet due, so the queue still looks empty here — pausing on that reading strands
		// the very command the pause is waiting for: it would only be drained by the next iteration,
		// which the pause prevents, so the run wedges until the player submits a second time (which
		// releases the first and strands the second). Wait for the log to drain instead.
		if (commandLog.hasPending())
			return;
		boolean awaiting = false;
		for (Settlement c : colonies)
			if (c.getBuildEconomy() != null && c.getBuildEconomy().queueAwaitingChoice()) {
				awaiting = true;
				break;
			}
		if (!awaiting)
			return;
		synchronized (gate) {
			if (clock == ClockState.RUNNING)
				clock = ClockState.PAUSED;
		}
		emit();
	}

	// assemble a fresh snapshot on this (session) thread and push it to subscribers; cache
	// it for late joiners. A misbehaving subscriber is dropped rather than allowed to wedge
	// the loop.
	private void emit() {
		SessionSnapshot snap = Snapshots.of(id, spec.seed(), spec.scenario(),
				clock.name(), outcome.name(), endReason, tick, date(), colonies, session.getWorldMap(),
				session.getCaravans(), logBuffer.drain(), session.drainRouteDirty());
		// The live subscribers below get the frame WITH its deltas — they saw the previous frame, so
		// the delta is exactly what they are missing. The CACHE keeps a delta-free copy, because
		// everyone it is handed to (a late SSE joiner, GET /snapshot, the MCP get_snapshot tool) did
		// not see the previous frame, and a stopped session would otherwise replay the same log lines
		// on every reconnect for as long as it exists. See SessionSnapshot#withoutDeltas.
		lastSnapshot = snap.withoutDeltas();
		for (Consumer<SessionSnapshot> s : subscribers) {
			try {
				s.accept(snap);
			} catch (RuntimeException e) {
				subscribers.remove(s);
			}
		}
	}
}
