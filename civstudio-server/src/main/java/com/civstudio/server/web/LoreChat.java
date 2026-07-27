package com.civstudio.server.web;

import java.util.Map;
import java.util.function.BiConsumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;

import com.civstudio.server.lore.LoreService;

/**
 * "{@code @ask <question>}" as a thing that happens <b>in a chat room</b> — shared by the two rooms
 * that have one: the Spectator Lobby ({@link LobbyController}) and a session's own chat, which the
 * map's event-log bar types into ({@link SessionController}).
 *
 * <p>It used to be neither. The browser called {@code /api/lore/ask} directly and drew the exchange
 * into its own box, so an answer belonged to one tab: reopening the lobby cleared it, and the log
 * bar had no {@code @ask} at all. Routing it through the room gives a question and its answer the
 * same standing as anything else said there — persisted by the {@code ChatStore}, replayed to
 * whoever arrives later, and read by everyone present. A shared room is the point of a room, and a
 * good answer is worth more than one reading of it.
 *
 * <p><b>The question posts immediately; the answer follows.</b> Retrieval plus generation takes
 * seconds, and holding the request open for them would leave the asker looking at a room that had
 * not noticed they spoke. So the question is posted synchronously, the lookup runs on its own
 * virtual thread, and the answer arrives over the same feed as ordinary chat — which is why
 * {@link #ask} answers 202 rather than the answer itself.
 */
@Component
public class LoreChat {

	private static final Logger log = LoggerFactory.getLogger(LoreChat.class);

	/** The name the lore chatbot posts under — a persona in the room, not a user. */
	public static final String LOREMASTER = "Loremaster";

	/**
	 * Max length of an answer. Far above the room's own message ceiling, which is a rule for people:
	 * a cited lore answer is a paragraph by nature, and cutting it to a chat line would make it
	 * useless. Still bounded — the room is persisted, and one runaway generation should not become a
	 * permanent wall of text in everybody's backlog.
	 */
	static final int MAX_ANSWER_LEN = 2000;

	// Optional: LoreController and LoreService are registered only when a lore datasource is
	// configured, so a server without the lore backend must still serve working chat.
	private final ObjectProvider<LoreService> lore;

	public LoreChat(ObjectProvider<LoreService> lore) {
		this.lore = lore;
	}

	/** Whether this server has a lore backend at all. */
	public boolean available() {
		return lore.getIfAvailable() != null;
	}

	/**
	 * Post {@code question} to a room as {@code user}, then post the Loremaster's answer to the same
	 * room when it arrives.
	 *
	 * @param post     the room's poster — {@code (user, text)}, e.g. {@code LobbyRoom::post} or
	 *                 {@code HostedSession::postChat}
	 * @param user     the asker's server-resolved display name
	 * @param question the question, already stripped and length-capped by the caller
	 * @return 202 once the question is in the room, or 503 when this server has no lore backend
	 */
	public ResponseEntity<Object> ask(BiConsumer<String, String> post, String user, String question) {
		LoreService svc = lore.getIfAvailable();
		if (svc == null)
			return ResponseEntity.status(503)
					.body(Map.of("error", "the lore chatbot isn't enabled on this server"));
		post.accept(user, "@ask " + question);
		Thread.ofVirtual().name("lore-ask").start(() -> {
			try {
				post.accept(LOREMASTER, answerText(svc.ask(question)));
			} catch (RuntimeException e) {
				// the room asked a question; it is owed an answer, even a disappointing one
				log.warn("lore ask failed for \"{}\"", question, e);
				post.accept(LOREMASTER, "I could not reach the archives just now.");
			}
		});
		return ResponseEntity.status(202).body(Map.of("accepted", true, "user", user));
	}

	/**
	 * The prose out of an {@link LoreService.Answer}. Its {@code sources} are dropped rather than
	 * appended: a room is a stream of plain lines, and a citation list is only worth carrying once
	 * there is somewhere to click it.
	 */
	static String answerText(LoreService.Answer answer) {
		String text = answer == null ? null : answer.answer();
		if (text == null || text.isBlank())
			return "I have nothing on that.";
		return text.length() > MAX_ANSWER_LEN ? text.substring(0, MAX_ANSWER_LEN) + "…" : text;
	}
}
