package com.civstudio.server.web;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.civstudio.server.ClockState;
import com.civstudio.server.HostedSession;
import com.civstudio.server.SessionHost;
import com.civstudio.server.SessionKind;
import com.civstudio.server.SessionSpec;
import com.civstudio.geo.WorldMap;
import com.civstudio.handicap.HandicapCatalog;
import com.civstudio.server.command.SetTaxRateCommand;
import com.civstudio.server.registry.SessionRecord;
import com.civstudio.server.registry.SessionRegistry;
import com.civstudio.simulation.SimulationConfig;
import com.civstudio.server.render.SessionSnapshot;
import com.civstudio.settlement.Settlement;

import jakarta.servlet.http.HttpServletRequest;

/**
 * The REST + SSE surface of the spectator/interactive server (see {@code docs/client-server.md}),
 * ported from the old JDK-{@code HttpServer} {@code FeedServer} to Spring MVC (running on virtual
 * threads). Endpoints:
 * <ul>
 * <li>{@code GET  /api/sessions}              — list the hosted sessions.</li>
 * <li>{@code POST /api/sessions}              — found + start a session from a spec.</li>
 * <li>{@code GET  /api/sessions/{id}/stream}  — subscribe to the snapshot feed (SSE).</li>
 * <li>{@code GET  /api/sessions/{id}/events}  — the retained event tail (a snapshot's log is only
 * the delta, so this is how a late joiner or a reloaded page recovers what it missed).</li>
 * <li>{@code POST /api/sessions/{id}/control} — {@code {action:pause|resume|step|rate|stop}}.</li>
 * <li>{@code POST /api/sessions/{id}/commands}— submit a player command, e.g.
 * {@code {type:setTaxRate, lever:bankProfit|nobleIncome, rate:0..1}}.</li>
 * </ul>
 * A slow spectator never stalls the sim: each SSE connection has its own bounded queue that the
 * session thread offers into (dropping the oldest frame if the client falls behind), while the
 * connection's own virtual thread drains it to the socket.
 */
@RestController
@RequestMapping("/api/sessions")
public class SessionController {

	// max lobby chat message length (longer is truncated)
	private static final int MAX_CHAT_LEN = 280;

	// ceiling on an /events page, so a caller can't ask for the whole retained tail (4096 lines) at
	// once; 0/absent means the tail's own default (200). The notification board asks for far less —
	// only the last 30 in-game days, which it bounds again client-side.
	private static final int MAX_EVENT_LIMIT = 512;

	private final SessionHost host;
	private final CurrentUserResolver currentUser;
	private final SessionAuthz authz;
	private final SseFeed feed;

	public SessionController(SessionHost host, CurrentUserResolver currentUser,
			SessionAuthz authz, SseFeed feed) {
		this.host = host;
		this.currentUser = currentUser;
		this.authz = authz;
		this.feed = feed;
	}

	/**
	 * The hosted sessions — the lobby's list (see {@code docs/spectator-lobby.md} Phase 1).
	 * <p>
	 * <b>Visibility:</b> public runs (a Timeline, the demo) are listed for everyone, including the
	 * signed-out — spectating is never gated. A player's own save slots are listed only to them: a
	 * private run is nobody else's business, and a lobby that leaked them would be a lobby people
	 * stopped using. Admins see everything, since they are the ones asked to fix it.
	 *
	 * @param http the request (the caller's identity decides what their own means)
	 * @return one row per visible session
	 */
	@GetMapping
	public List<Map<String, Object>> list(HttpServletRequest http) {
		String me = currentUser.userId(http);
		boolean admin = currentUser.isAdmin(http);
		List<Map<String, Object>> out = new ArrayList<>();
		java.util.Set<String> liveIds = new java.util.HashSet<>();
		WorldMap map = null;
		for (HostedSession hs : host.list()) {
			liveIds.add(hs.id());
			if (map == null)
				map = hs.session().getWorldMap();   // any live map serves to resolve a record's realm below
			if (!authz.canSee(hs, me, admin))
				continue;   // someone else's private run — the visibility rule lives in SessionAuthz
			out.add(liveRow(hs, me));
		}
		// The caller's OWN recorded runs that are NOT live in this process — restored lazily on access,
		// so after a redeploy they sit in the registry unloaded. Without these the lobby would hide your
		// save slots while they still count against your slot limit (saveSlotsOf reads the registry), so
		// you'd be told "you already have 5" over an apparently near-empty shelf. Registry-only rows are
		// lighter (no colony name / spectator count); opening one restores it in full.
		if (me != null)
			for (SessionRecord r : host.registry().all())
				if (me.equals(r.owner()) && !liveIds.contains(r.id()))
					out.add(recordRow(r, map));
		return out;
	}

	// a lobby row for a LIVE session (the full-detail case: colony name, spectator count, live clock)
	private Map<String, Object> liveRow(HostedSession hs, String me) {
		// a mutable map, not Map.of: the nullable fields below would make Map.of throw
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("id", hs.id());
		row.put("scenario", hs.spec().scenario());
		row.put("kind", hs.kind().wire());
		row.put("seed", hs.spec().seed());
		// the two control axes, split out of the old single `state` (docs/session-management.md):
		// clockState drives the transport/terminal UI, outcome the finished/verdict UI
		row.put("clockState", hs.clock().name());
		row.put("outcome", hs.outcome().name());
		row.put("tick", hs.tick());
		row.put("date", hs.date().toString());     // the in-game date a lobby row shows
		row.put("watching", hs.spectators());      // 👁 on the row
		row.put("mine", me != null && me.equals(hs.owner()));
		row.put("realm", realmKey(hs.session().getWorldMap(), hs.spec().provinceId()));
		// What the row is CALLED. A run is named by its colony for now — naming is deferred to
		// countries (docs/spectator-lobby.md §Naming), and this is the one field that changes when
		// they land. Absent for a Timeline (it is the world's, not a colony's) and for a run with
		// no colony yet, where the client falls back to the id.
		if (!hs.isTimeline() && !hs.colonies().isEmpty())
			row.put("colony", hs.colonies().get(0).getName());
		if (hs.isTimeline()) {
			// a Timeline's row is about the contest: how many are still standing, of how many
			// founded. (Amendment 4 — a player with a living colony should see a rank window
			// rather than the whole board — is a later, separate change.)
			row.put("seats", hs.colonies().size());
			row.put("standing", hs.survivors());
		}
		if (hs.endReason() != null)
			row.put("endReason", hs.endReason());
		return row;
	}

	// a lobby row built from a RECORD alone — a run recorded but not loaded in this process. The record
	// has no colony name (the client titles it by id) nor a live spectator count; the in-game date is
	// its clock origin (the shared founding date) plus the recorded tick.
	private Map<String, Object> recordRow(SessionRecord r, WorldMap map) {
		Map<String, Object> row = new LinkedHashMap<>();
		row.put("id", r.id());
		row.put("scenario", r.scenario());
		row.put("kind", r.kindEnum().wire());
		row.put("seed", r.seed());
		row.put("clockState", r.clockState() == null ? "STOPPED" : r.clockState());
		row.put("outcome", r.outcome() == null ? "LIVE" : r.outcome());
		row.put("tick", r.tick());
		row.put("date", SimulationConfig.DEFAULT.startDate().plusDays(r.tick()).toString());
		row.put("watching", 0);
		row.put("mine", true);   // only the caller's own records reach here
		row.put("realm", realmKey(map, r.provinceId()));
		if (r.endReason() != null)
			row.put("endReason", r.endReason());
		return row;
	}

	// The realm a run lives in — the realm of its anchor province. Opening the run switches the client's
	// map to this realm; defaults to Cannor when the anchor has no realm (or the map is unavailable) —
	// the same default a bare URL takes, and the realm the retired `halcann` key resolves to.
	private static String realmKey(WorldMap map, int provinceId) {
		com.civstudio.geo.Province p = map == null ? null : map.province(provinceId);
		com.civstudio.geo.Realm r = p != null ? p.realm() : com.civstudio.geo.Realm.NONE;
		return r == com.civstudio.geo.Realm.NONE ? com.civstudio.geo.Realm.CANNOR.rawKey() : r.rawKey();
	}

	@PostMapping
	public ResponseEntity<Object> create(@RequestBody(required = false) CreateRequest req,
			HttpServletRequest http) {
		CreateRequest r = req == null ? new CreateRequest(null, null, null, null, null) : req;
		long seed = r.seed() != null ? r.seed() : 7654321L;
		String scenario = r.scenario() != null ? r.scenario() : SessionSpec.CARAVAN_DEMO;
		int provinceId = r.provinceId() != null ? r.provinceId() : 4411;
		// the founder owns the session; an anonymous founder creates an unowned/public session
		// (open to all — the demo). Phase 2 (docs/authentication.md) will require login to found.
		String owner = currentUser.userId(http);
		SessionSpec spec = new SessionSpec(seed, scenario, provinceId);
		// kind is DERIVED from (owner, spec), never taken from the client — a caller must not be able to
		// declare its private run a public demo. mode/difficulty are the client's to choose (the variant
		// + Civ4 handicap). difficulty is validated against the imported handicap catalog and stored as a
		// canonical key ('noble', 'deity', …); a blank one means the standard rung (docs/session-management.md).
		SessionKind kind = SessionKind.of(owner, spec);
		String difficulty;
		try {
			difficulty = HandicapCatalog.DEFAULT.resolve(r.difficulty());
		} catch (IllegalArgumentException badDifficulty) {
			return ResponseEntity.badRequest().body(Map.of("error", badDifficulty.getMessage()));
		}
		HostedSession hs;
		try {
			hs = host.create(spec, owner, kind, r.mode(), difficulty);
		} catch (SessionHost.SaveSlotsFullException full) {
			return ResponseEntity.status(409).body(Map.of("error", full.getMessage(),
					"slots", host.saveSlotsOf(owner).size(), "limit", SessionHost.SAVE_SLOT_LIMIT));
		} catch (SessionHost.RunFinishedException over) {
			return ResponseEntity.status(409).body(Map.of("error", over.getMessage()));
		}
		// each kind knows how it begins — a Timeline waits for the gun, a save slot starts paused, the
		// demo runs (docs/session-management.md); a no-op if this returned an already-running session
		hs.kind().begin(hs);
		// realm: the client opens the new session by crossing to its realm's map (docs/realms.md §A
		// session carries its realm), and the founder has only this response to learn it from — the
		// list row that also carries it is filtered to the owner but is a separate, racy fetch. Same
		// value realmOf() puts on a list row.
		return ResponseEntity.status(201).body(Map.of("id", hs.id(), "clockState", hs.clock().name(),
				"outcome", hs.outcome().name(), "kind", hs.kind().wire(),
				"realm", realmKey(hs.session().getWorldMap(), hs.spec().provinceId())));
	}

	@PostMapping("/{id}/control")
	public ResponseEntity<Object> control(@PathVariable String id, @RequestBody ControlRequest req,
			HttpServletRequest http) {
		HostedSession hs = host.getOrRestore(id);
		if (hs == null)
			return notFound(id);
		// play/pause/step/rate/stop change state shared by every spectator, so control requires a
		// signed-in user (any authenticated user for the unowned/public demo; the owner for an owned
		// session). Spectating stays anonymous. See docs/authentication.md.
		ResponseEntity<Object> denied = authz.denyClock(hs, http);
		if (denied != null)
			return denied;
		// a finished run takes no orders: its thread is gone, so pause/resume/step would silently
		// do nothing. Say so rather than returning a cheerful 200 that changed nothing. (Only a
		// FINISHED run — a decided outcome — is refused here; a run merely stopped from outside is
		// restorable, and getOrRestore above has already brought it back.)
		if (hs.isFinished())
			return ResponseEntity.status(409).body(Map.of("error", "session " + id + " is over",
					"outcome", hs.outcome().name(), "endReason", String.valueOf(hs.endReason())));
		String action = req.action() == null ? "" : req.action();
		switch (action) {
			// the gun: start a Timeline that has been open for joins. Separate from resume (which only
			// un-pauses an already-running session) because this is the moment the roster closes and
			// everyone's colony starts on the same day.
			case "start" -> {
				if (hs.clock() != ClockState.CREATED)
					return ResponseEntity.status(409).body(Map.of("error",
							"session " + id + " has already started", "clockState", hs.clock().name()));
				try {
					hs.start();
				} catch (IllegalStateException empty) {
					return ResponseEntity.status(409).body(Map.of("error", empty.getMessage()));
				}
			}
			case "pause" -> hs.pause();
			case "resume" -> hs.resume();
			case "step" -> hs.step(req.value() != null ? req.value().intValue() : 1);
			case "rate" -> hs.setTickRateMillis(req.value() != null ? req.value() : 1000);
			case "stop" -> hs.stop();
			default -> {
				return ResponseEntity.badRequest().body(Map.of("error", "unknown action: " + action));
			}
		}
		return ResponseEntity.ok(Map.of("id", id, "clockState", hs.clock().name(),
				"outcome", hs.outcome().name(), "tick", hs.tick()));
	}

	// submit a player command (the interactive seam). A command is tick-stamped and applied at the
	// deterministic top of its tick, so it defaults to the NEXT tick (never retro-mutating the
	// in-flight day) unless a later tick is given.
	@PostMapping("/{id}/commands")
	public ResponseEntity<Object> command(@PathVariable String id, @RequestBody CommandRequest req,
			HttpServletRequest http) {
		HostedSession hs = host.getOrRestore(id);
		if (hs == null)
			return notFound(id);
		// a command acts on a COLONY, so it is that colony's owner who may submit it — not the run's
		// (docs/spectator-lobby.md Phase 2). They coincide for a single-player run and the demo.
		String colony = req.colony() == null || req.colony().isBlank() ? null : req.colony();
		ResponseEntity<Object> denied = authz.denyColonyCommand(hs, colony, http);
		if (denied != null)
			return denied;
		String type = req.type() == null ? "" : req.type();
		long next = hs.tick() + 1;
		long tick = Math.max(next, req.tick() != null ? req.tick() : next);
		switch (type) {
			case "setTaxRate" -> {
				SetTaxRateCommand.Lever lever = parseLever(req.lever());
				if (lever == null)
					return ResponseEntity.badRequest().body(Map.of("error", "unknown lever: " + req.lever()));
				double rate = req.rate() != null ? req.rate() : 0;
				if (!(rate >= 0 && rate <= 1))
					return ResponseEntity.badRequest().body(Map.of("error", "rate must be in [0,1], got " + rate));
				hs.submit(new SetTaxRateCommand(tick, colony, lever, rate));
				Map<String, Object> ok = new LinkedHashMap<>();
				ok.put("accepted", true);
				ok.put("type", type);
				if (colony != null)
					ok.put("colony", colony);
				ok.put("lever", lever.name());
				ok.put("rate", rate);
				ok.put("tick", tick);
				return ResponseEntity.status(202).body(ok);
			}
			case "queueBuild" -> {
				// the B6 player verb: append BUILDING_* ids to the ruler's queue (clear
				// first for reorder/cancel). Ids are validated at pick time by the engine,
				// so a bogus id is dropped, never wedged. Submitting also resumes a
				// session auto-paused awaiting this very choice (HostedSession.submit).
				java.util.List<String> items = req.items() == null ? java.util.List.of() : req.items();
				boolean clear = Boolean.TRUE.equals(req.clear());
				if (items.isEmpty() && !clear)
					return ResponseEntity.badRequest().body(Map.of("error", "queueBuild needs items and/or clear"));
				hs.submit(new com.civstudio.server.command.QueueBuildCommand(tick, colony, items, clear));
				Map<String, Object> ok = new LinkedHashMap<>();
				ok.put("accepted", true);
				ok.put("type", type);
				if (colony != null)
					ok.put("colony", colony);
				ok.put("items", items);
				ok.put("clear", clear);
				ok.put("tick", tick);
				return ResponseEntity.status(202).body(ok);
			}
			case "grantPlot" -> {
				// the P3 ruler decree: enfeoff a plot to a noble (its residents become that noble's
				// vassals). A grant that no longer resolves at its tick is a no-op in the engine.
				if (req.plotIndex() == null || req.nobleId() == null)
					return ResponseEntity.badRequest().body(Map.of("error", "grantPlot needs plotIndex and nobleId"));
				hs.submit(new com.civstudio.server.command.GrantPlotCommand(tick, colony,
						req.plotIndex(), req.nobleId()));
				Map<String, Object> ok = new LinkedHashMap<>();
				ok.put("accepted", true);
				ok.put("type", type);
				if (colony != null)
					ok.put("colony", colony);
				ok.put("plotIndex", req.plotIndex());
				ok.put("nobleId", req.nobleId());
				ok.put("tick", tick);
				return ResponseEntity.status(202).body(ok);
			}
			default -> {
				return ResponseEntity.badRequest().body(Map.of("error", "unknown command type: " + type));
			}
		}
	}

	/**
	 * Delete one of your save slots — the run and its record, gone.
	 * <p>
	 * <b>Your own single-player runs only.</b> Not the demo (nobody's), and emphatically not a
	 * Timeline: forgetting one would destroy its verdict and hand every player in it another attempt,
	 * which is what the registry exists to prevent. An admin does not get to bypass that either —
	 * this endpoint is about a player tidying their own shelf, and the admin console has its own
	 * (session-only) removal.
	 *
	 * @param id   the save slot
	 * @param http the request
	 * @return 204 when it is gone, 401 signed out, 403 if it is not yours to delete
	 */
	@DeleteMapping("/{id}")
	public ResponseEntity<Object> delete(@PathVariable String id, HttpServletRequest http) {
		// get(), NOT getOrRestore(): deleting a registry-only slot must not first fast-forward-restore it
		// just to forget it. The owner check + forget work off the record when the run is not live.
		HostedSession hs = host.get(id);
		String user = currentUser.userId(http);
		if (user == null)
			return ResponseEntity.status(401).body(Map.of("error", "sign in to delete a run"));
		// a finished run has no live session to restore, so fall back to its record for the check
		String owner = hs != null ? hs.owner() : host.registry().find(id).map(r -> r.owner()).orElse(null);
		boolean timeline = hs != null ? hs.isTimeline()
				: host.registry().find(id).map(r -> r.isTimeline()).orElse(false);
		if (owner == null && hs == null && host.registry().find(id).isEmpty())
			return notFound(id);
		if (timeline || owner == null)
			return ResponseEntity.status(403)
					.body(Map.of("error", "only your own single-player runs can be deleted"));
		if (!owner.equals(user))
			return ResponseEntity.status(403).body(Map.of("error", "not the owner of session " + id));
		host.forget(id);
		return ResponseEntity.noContent().build();
	}

	// Take your seat in a ranked Timeline: found your colony in the shared world. Requires a
	// signed-in user (the seat is theirs), and only works before the gun — see
	// docs/spectator-lobby.md Phase 3. Idempotent: asking twice returns the seat you already hold.
	@PostMapping("/{id}/join")
	public ResponseEntity<Object> join(@PathVariable String id, HttpServletRequest http) {
		HostedSession hs = host.getOrRestore(id);
		if (hs == null)
			return notFound(id);
		ResponseEntity<Object> denied = authz.denyJoin(http);
		if (denied != null)
			return denied;
		try {
			Settlement colony = host.joinTimeline(id, currentUser.userId(http));
			return ResponseEntity.status(201).body(Map.of("colony", colony.getName(),
					"province", colony.getProvince() == null ? 0 : colony.getProvince().id(),
					"session", id));
		} catch (SessionRegistry.SeatTakenException taken) {
			// the durable record says this player already has a seat — even if this process does not
			// hold their colony. A conflict, and deliberately NOT a silent second seat.
			return ResponseEntity.status(409).body(Map.of("error", taken.getMessage()));
		} catch (IllegalStateException closed) {
			// the roster is closed (the Timeline is running or over) — a real conflict, not a bug
			return ResponseEntity.status(409).body(Map.of("error", closed.getMessage()));
		} catch (IllegalArgumentException bad) {
			return ResponseEntity.badRequest().body(Map.of("error", bad.getMessage()));
		}
	}

	// post a lobby chat message. Unlike control/commands (which change shared state and are
	// owner-gated), chat is open to ANY signed-in user — it's a spectator lobby. The poster's
	// display name is resolved server-side from the principal, so it can't be spoofed; the message
	// is broadcast immediately to every spectator over the SSE `chat` event.
	@PostMapping("/{id}/chat")
	public ResponseEntity<Object> chat(@PathVariable String id, @RequestBody(required = false) ChatRequest req,
			HttpServletRequest http) {
		HostedSession hs = host.getOrRestore(id);
		if (hs == null)
			return notFound(id);
		ResponseEntity<Object> denied = authz.denyChat(http);
		if (denied != null)
			return denied;
		String user = currentUser.displayName(http);
		String text = req == null || req.text() == null ? "" : req.text().strip();
		if (text.isEmpty())
			return ResponseEntity.badRequest().body(Map.of("error", "empty message"));
		if (text.length() > MAX_CHAT_LEN)
			text = text.substring(0, MAX_CHAT_LEN);
		hs.postChat(user, text);
		return ResponseEntity.status(202).body(Map.of("accepted", true, "user", user));
	}

	// the session's latest render snapshot, once. /stream is the right way to WATCH a session, but a
	// caller that wants a single reading — the admin console prefilling the tax levers, a probe, a
	// script — should not have to open an SSE connection and hang up after one frame. Read-only, so
	// ungated like the other spectate endpoints. 204 while the session has not yet emitted a frame.
	@GetMapping("/{id}/snapshot")
	public ResponseEntity<Object> snapshot(@PathVariable String id) {
		HostedSession hs = host.getOrRestore(id);
		if (hs == null)
			return notFound(id);
		SessionSnapshot snap = hs.currentSnapshot();
		return snap == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(snap);
	}

	// The session's retained event tail. A snapshot's `log` is a DELTA — drained once into the frame
	// it rides on — so a spectator only ever sees what the sim logged while it happened to be
	// connected. Join a minute late, or reload the page, and those lines are gone for good: the demo
	// logs its founding, its first digest and two starvation demotions inside its first 62 ticks, and
	// a viewer arriving after that would watch an empty notification board forever.
	//
	// So the board rehydrates from here on connect (web/js/notify.mjs), asking for the window it can
	// actually show — the last 30 in-game days. Read-only, and ungated like the other spectate
	// endpoints. Same tail the get_events MCP tool reads; the lines are byte-identical to the ones the
	// stream delivers (LogLine.of derives curated/sev for both).
	@GetMapping("/{id}/events")
	public ResponseEntity<Object> events(@PathVariable String id,
			@RequestParam(required = false) String level,
			@RequestParam(required = false) String from,
			@RequestParam(required = false) String to,
			@RequestParam(required = false) String grep,
			@RequestParam(required = false, defaultValue = "0") int limit) {
		HostedSession hs = host.getOrRestore(id);
		if (hs == null)
			return notFound(id);
		return ResponseEntity.ok(hs.eventTail(level, from, to, grep, Math.min(limit, MAX_EVENT_LIMIT)));
	}

	// open a Server-Sent-Events stream of the session's snapshots. The session thread serializes +
	// offers frames into this connection's bounded queue (dropping the oldest if the client lags);
	// this connection's own virtual thread drains it to the socket until the client disconnects.
	@GetMapping("/{id}/stream")
	public SseEmitter stream(@PathVariable String id) {
		HostedSession hs = host.getOrRestore(id);
		if (hs == null)
			throw new ResponseStatusException(HttpStatus.NOT_FOUND, "no session " + id);

		// The transport is SseFeed's problem (queueing, the drain thread, drop-oldest, unsubscribing);
		// what belongs HERE is only what this feed carries and when it ends. It ends on the run being
		// terminal — stopped OR game over — since a finished session would otherwise hold the request
		// open forever.
		return feed.open("session-" + id, hs::isTerminal, sink -> List.of(
				hs.subscribe(snap -> sink.publish(null, snap)),      // default event: the snapshot
				hs.subscribeChat(msg -> sink.publish("chat", msg))));  // the client's chat listener
	}

	private static void closeQuietly(AutoCloseable sub) {
		try {
			sub.close();
		} catch (Exception ignored) {
			// unsubscribe is best-effort
		}
	}

	// authorize a write (control or command): the caller must be signed in, and — for an owned
	// session — be the owner or an admin. Returns the deny response (401 unauthenticated / 403
	// not-owner) or null when allowed. Read/spectate endpoints (list, stream) are never gated.
	private static ResponseEntity<Object> notFound(String id) {
		return ResponseEntity.status(404).body(Map.of("error", "no session " + id));
	}

	// map the wire lever name (camelCase from the browser, or the enum name) to the enum
	private static SetTaxRateCommand.Lever parseLever(String wire) {
		if (wire == null)
			return null;
		return switch (wire) {
			case "bankProfit", "BANK_PROFIT" -> SetTaxRateCommand.Lever.BANK_PROFIT;
			case "nobleIncome", "NOBLE_INCOME" -> SetTaxRateCommand.Lever.NOBLE_INCOME;
			default -> null;
		};
	}

	/**
	 * Body of {@code POST /api/sessions} (all fields optional; defaults to the caravan demo). {@code
	 * mode} is the variant within the run's kind and {@code difficulty} a Civ4 handicap key — both
	 * carried as founding metadata (see {@code docs/session-management.md}); the run's <em>kind</em> is
	 * derived server-side from the founder, never taken from the client.
	 */
	public record CreateRequest(Long seed, String scenario, Integer provinceId, String mode,
			String difficulty) {
	}

	/** Body of {@code POST /api/sessions/{id}/control}. */
	public record ControlRequest(String action, Long value) {
	}

	/**
	 * Body of {@code POST /api/sessions/{id}/commands}. {@code colony} names the colony the command
	 * acts on — required to act in a session holding more than one, since a lever must move the
	 * caller's own colony and no one else's; optional (and meaning "the one colony") in a
	 * single-colony run. See {@code docs/spectator-lobby.md} Phase 2.
	 */
	public record CommandRequest(String type, String colony, String lever, Double rate, Long tick,
			java.util.List<String> items, Boolean clear, Integer plotIndex, Integer nobleId) {
	}

	/** Body of {@code POST /api/sessions/{id}/chat}. */
	public record ChatRequest(String text) {
	}
}
