package com.civstudio.server.web;

import java.util.List;
import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.civstudio.server.LobbyRoom;

import jakarta.servlet.http.HttpServletRequest;

/**
 * The Spectator Lobby's own endpoints — the room you are in before you have picked a session (see
 * {@code docs/spectator-lobby.md} Phase 1):
 * <ul>
 * <li>{@code GET  /api/lobby/stream} — the lobby chat feed (SSE), backlog replayed on connect.</li>
 * <li>{@code POST /api/lobby/chat}   — say something (any signed-in user).</li>
 * <li>{@code POST /api/lobby/ask}    — put a lore question to the room ({@link LoreChat}).</li>
 * </ul>
 * Session chat rides its session's snapshot stream; the lobby has no session, hence a feed of its
 * own. It carries <b>chat only</b>: the session list is a plain {@code GET /api/sessions} the lobby
 * refreshes, because a browser list does not need frame-accurate pushes and a poll is one fewer
 * moving part. Chat does need pushing — a conversation on a poll is not a conversation.
 * <p>
 * <b>Listening is anonymous; talking is not.</b> Same rule as everywhere else here: sign-in gates
 * acting, never watching.
 */
@RestController
@RequestMapping("/api/lobby")
public class LobbyController {

	/** Max message length (longer is truncated) — the same ceiling session chat uses. */
	private static final int MAX_CHAT_LEN = 280;

	private final LobbyRoom room;
	private final SseFeed feed;
	private final SessionAuthz authz;
	private final CurrentUserResolver currentUser;
	private final LoreChat lore;

	public LobbyController(LobbyRoom room, SseFeed feed, SessionAuthz authz,
			CurrentUserResolver currentUser, LoreChat lore) {
		this.room = room;
		this.feed = feed;
		this.authz = authz;
		this.currentUser = currentUser;
		this.lore = lore;
	}

	/**
	 * Subscribe to the lobby chat. Open-ended: unlike a session's feed the lobby has no natural end —
	 * it outlives every run in it.
	 *
	 * @return the SSE stream (each message arrives as a {@code chat} event)
	 */
	@GetMapping("/stream")
	public SseEmitter stream() {
		return feed.open("lobby", null, sink -> List.of(
				room.subscribe(msg -> sink.publish("chat", msg))));
	}

	/**
	 * Say something in the lobby.
	 *
	 * @param req  the message body
	 * @param http the request (the poster's identity is resolved from it, never taken from the body)
	 * @return 202 with the resolved display name, 401 signed out, 400 if empty
	 */
	@PostMapping("/chat")
	public ResponseEntity<Object> chat(@RequestBody(required = false) ChatRequest req,
			HttpServletRequest http) {
		ResponseEntity<Object> denied = authz.denyChat(http);
		if (denied != null)
			return denied;
		String user = currentUser.displayName(http);
		String text = req == null || req.text() == null ? "" : req.text().strip();
		if (text.isEmpty())
			return ResponseEntity.badRequest().body(Map.of("error", "empty message"));
		if (text.length() > MAX_CHAT_LEN)
			text = text.substring(0, MAX_CHAT_LEN);
		room.post(user, text);
		return ResponseEntity.status(202).body(Map.of("accepted", true, "user", user));
	}

	/**
	 * Ask the lore chatbot, in the lobby room — see {@link LoreChat} for what that means and why the
	 * answer arrives over the feed rather than in this response.
	 *
	 * @param req  the question, in the same body shape as {@link #chat}
	 * @param http the request (the asker's identity is resolved from it)
	 * @return 202 once the question is in the room, 401 signed out, 400 empty, 503 no lore backend
	 */
	@PostMapping("/ask")
	public ResponseEntity<Object> ask(@RequestBody(required = false) ChatRequest req,
			HttpServletRequest http) {
		ResponseEntity<Object> denied = authz.denyChat(http);
		if (denied != null)
			return denied;
		String question = req == null || req.text() == null ? "" : req.text().strip();
		if (question.isEmpty())
			return ResponseEntity.badRequest().body(Map.of("error", "empty question"));
		if (question.length() > MAX_CHAT_LEN)
			question = question.substring(0, MAX_CHAT_LEN);
		return lore.ask(room::post, currentUser.displayName(http), question);
	}

	/** Body of {@code POST /api/lobby/chat} and {@code POST /api/lobby/ask}. */
	public record ChatRequest(String text) {
	}
}
