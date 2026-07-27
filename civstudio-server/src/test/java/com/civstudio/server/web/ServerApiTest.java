package com.civstudio.server.web;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import com.civstudio.server.HostedSession;
import com.civstudio.server.SessionHost;
import com.civstudio.server.SessionSpec;
import com.civstudio.server.render.CaravanDetail;
import com.civstudio.server.render.SessionSnapshot;

import tools.jackson.databind.ObjectMapper;

/**
 * Exercises the Spring MVC REST + SSE surface end to end against a booted context on a random
 * port (see {@code docs/spring-boot-migration.md}): the session list, the SSE snapshot feed, the
 * taxation command, CORS, and the map bundle. The demo session is disabled so each test drives its
 * own paused session deterministically; {@link #cleanup()} clears the shared host between tests.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = { "civstudio.demo.enabled=false", "civstudio.auth.trust-dev-user-header=true" })
class ServerApiTest {

	private static final int DHENIJANSAR = 4411;

	@LocalServerPort
	int port;

	@Autowired
	SessionHost host;

	private final ObjectMapper json = new ObjectMapper();
	private final HttpClient client = HttpClient.newHttpClient();

	@AfterEach
	void cleanup() {
		host.stopAll(); // clear any sessions a test created, so they don't leak into one another
	}

	@Test
	@Timeout(120)
	void streamsSnapshotFramesOverSse() throws Exception {
		HostedSession hs = host.create(SessionSpec.caravanDemo(111L, DHENIJANSAR));
		hs.startPaused(); // emits the tick-0 snapshot; a subscriber gets it immediately

		// the session list reports the hosted session
		HttpResponse<String> list = client.send(
				HttpRequest.newBuilder(uri("/api/sessions")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, list.statusCode());
		assertTrue(list.body().contains(hs.id()), "the session should be listed");

		// subscribe to the SSE stream
		HttpResponse<java.io.InputStream> stream = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/stream"))
						.timeout(Duration.ofSeconds(30)).GET().build(),
				HttpResponse.BodyHandlers.ofInputStream());
		assertEquals(200, stream.statusCode());
		assertTrue(stream.headers().firstValue("Content-Type").orElse("")
				.startsWith("text/event-stream"));

		try (BufferedReader r = new BufferedReader(
				new InputStreamReader(stream.body(), StandardCharsets.UTF_8))) {
			// first frame is the cached tick-0 snapshot pushed on subscribe
			SessionSnapshot first = json.readValue(nextData(r), SessionSnapshot.class);
			assertEquals(hs.id(), first.sessionId());
			assertEquals(1, first.colonies().size());
			// no bands at tick 0 — the colony musters its foraging explorers emergently over
			// winter (the emergent-muster behaviour is asserted in HostedSessionTest)

			// stepping produces a fresh frame at a later tick
			hs.step(2);
			SessionSnapshot next;
			do {
				next = json.readValue(nextData(r), SessionSnapshot.class);
			} while (next.tick() <= first.tick());
			assertTrue(next.tick() >= 1, "the streamed tick advances after stepping");
		}
	}

	@Test
	@Timeout(120)
	void taxRateCommandOverHttpMovesTheRulerLever() throws Exception {
		HostedSession hs = host.create(SessionSpec.caravanDemo(222L, DHENIJANSAR));
		hs.startPaused(); // paused at tick 0; the command lands on the next tick
		assertNotNull(hs.colonies().get(0).getRuler(), "the demo colony has a ruler");

		// POST a real player command (authenticated — writes now require sign-in); the endpoint
		// accepts it and reports the apply tick
		HttpResponse<String> ok = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/commands"))
						.header("Content-Type", "application/json")
						.header("X-CivStudio-User", "tester")
						.POST(HttpRequest.BodyPublishers.ofString(
								"{\"type\":\"setTaxRate\",\"lever\":\"bankProfit\",\"rate\":0.3}"))
						.build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(202, ok.statusCode());
		assertTrue(ok.body().contains("\"accepted\":true"), ok.body());

		// step past the command's tick; the ruler's lever moves to the commanded rate
		hs.step(3);
		long deadline = System.nanoTime() + 60_000_000_000L;
		while (hs.colonies().get(0).getRuler().getBankProfitTaxRate() < 0.3
				&& System.nanoTime() < deadline)
			Thread.sleep(5);
		assertEquals(0.3, hs.colonies().get(0).getRuler().getBankProfitTaxRate(), 1e-9,
				"the HTTP command should have moved the bank-profit tax lever");

		// an unknown command type is rejected, not silently accepted
		HttpResponse<String> bad = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/commands"))
						.header("Content-Type", "application/json")
						.header("X-CivStudio-User", "tester")
						.POST(HttpRequest.BodyPublishers.ofString("{\"type\":\"bogus\"}"))
						.build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(400, bad.statusCode());
	}

	@Test
	@Timeout(120)
	void corsAllowsTheSiteOriginAndPreflightsThePost() throws Exception {
		HostedSession hs = host.create(SessionSpec.caravanDemo(333L, DHENIJANSAR));
		hs.startPaused();

		// a production site origin is echoed in Access-Control-Allow-Origin
		HttpResponse<String> allowed = client.send(
				HttpRequest.newBuilder(uri("/api/sessions"))
						.header("Origin", "https://anbennar.civstudio.com").GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals("https://anbennar.civstudio.com",
				allowed.headers().firstValue("Access-Control-Allow-Origin").orElse(null));

		// an unknown origin gets no CORS grant (Spring rejects the cross-origin request)
		HttpResponse<String> denied = client.send(
				HttpRequest.newBuilder(uri("/api/sessions"))
						.header("Origin", "https://evil.example").GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertTrue(denied.headers().firstValue("Access-Control-Allow-Origin").isEmpty(),
				"an unlisted origin must not be granted CORS");

		// the JSON POST's preflight is answered (200 + methods) so the browser proceeds
		HttpResponse<String> pre = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/commands"))
						.header("Origin", "https://anbennar.civstudio.com")
						.header("Access-Control-Request-Method", "POST")
						.method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, pre.statusCode());
		assertTrue(pre.headers().firstValue("Access-Control-Allow-Methods")
				.orElse("").contains("POST"));
		assertEquals("https://anbennar.civstudio.com",
				pre.headers().firstValue("Access-Control-Allow-Origin").orElse(null));
	}

	@Test
	@Timeout(120)
	void serveBundleReturnsTheMapBundleJsonAndGzips() throws Exception {
		// plain GET: JSON with the province backbone + engine-derived + merged asset fields, and the
		// site origin is echoed for CORS
		HttpResponse<String> res = client.send(
				HttpRequest.newBuilder(uri("/api/bundle"))
						.header("Origin", "https://anbennar.civstudio.com").GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, res.statusCode());
		assertTrue(res.headers().firstValue("Content-Type").orElse("").startsWith("application/json"));
		assertEquals("https://anbennar.civstudio.com",
				res.headers().firstValue("Access-Control-Allow-Origin").orElse(null));
		var bundle = json.readTree(res.body());
		int provinceCount = bundle.get("provinces").size();
		assertTrue(provinceCount > 4000, "expected the whole world, got " + provinceCount + " provinces");
		for (String key : new String[] { "geo", "geoNames", "adjacencies", "terrainColors" })
			assertTrue(bundle.has(key), "bundle missing key: " + key);

		// with Accept-Encoding: gzip the server ships the gzipped copy; it gunzips to the same bundle
		HttpResponse<byte[]> gz = client.send(
				HttpRequest.newBuilder(uri("/api/bundle"))
						.header("Accept-Encoding", "gzip").GET().build(),
				HttpResponse.BodyHandlers.ofByteArray());
		assertEquals("gzip", gz.headers().firstValue("Content-Encoding").orElse(null));
		try (var in = new java.util.zip.GZIPInputStream(new java.io.ByteArrayInputStream(gz.body()))) {
			assertEquals(provinceCount, json.readTree(in).get("provinces").size());
		}
	}

	@Test
	@Timeout(120)
	void serveTiersReturnsTheTierOutlinesAndGzips() throws Exception {
		// /api/tiers is the dissolved geographic-tier outlines, served verbatim from the engine jar
		// (was the committed web/assets/tiers.json). Plain GET is JSON with the three tier keys.
		HttpResponse<byte[]> res = client.send(
				HttpRequest.newBuilder(uri("/api/tiers")).GET().build(),
				HttpResponse.BodyHandlers.ofByteArray());
		assertEquals(200, res.statusCode());
		assertTrue(res.headers().firstValue("Content-Type").orElse("").startsWith("application/json"));
		var tiers = json.readTree(res.body());
		for (String key : new String[] { "continents", "superRegions", "regions" })
			assertTrue(tiers.has(key), "tiers missing key: " + key);

		// it is byte-identical to the engine resource it re-serves
		byte[] resource = getClass().getResourceAsStream("/map/tierborders.json").readAllBytes();
		assertArrayEquals(resource, res.body(), "/api/tiers must serve tierborders.json verbatim");

		// Accept-Encoding: gzip ships the gzipped copy; it gunzips to the same JSON
		HttpResponse<byte[]> gz = client.send(
				HttpRequest.newBuilder(uri("/api/tiers")).header("Accept-Encoding", "gzip").GET().build(),
				HttpResponse.BodyHandlers.ofByteArray());
		assertEquals("gzip", gz.headers().firstValue("Content-Encoding").orElse(null));
		try (var in = new java.util.zip.GZIPInputStream(new java.io.ByteArrayInputStream(gz.body()))) {
			assertArrayEquals(resource, in.readAllBytes());
		}
	}

	@Test
	@Timeout(120)
	void serveTechsReturnsTheGzippedTechGraphWithArtMetadata() throws Exception {
		// /api/techs is the tech graph (from the jar's techs.json) merged with the art-coupled
		// icon/beaker metadata, gzipped and served as octet-stream — the client gunzips it in-page,
		// so there is deliberately NO Content-Encoding header (was the committed techs.pack).
		HttpResponse<byte[]> res = client.send(
				HttpRequest.newBuilder(uri("/api/techs")).header("Accept-Encoding", "gzip").GET().build(),
				HttpResponse.BodyHandlers.ofByteArray());
		assertEquals(200, res.statusCode());
		assertTrue(res.headers().firstValue("Content-Type").orElse("").startsWith("application/octet-stream"));
		assertTrue(res.headers().firstValue("Content-Encoding").isEmpty(),
				"the pack is gunzipped in-page, so the response must not be Content-Encoding: gzip");

		try (var in = new java.util.zip.GZIPInputStream(new java.io.ByteArrayInputStream(res.body()))) {
			var techs = json.readTree(in);
			assertTrue(techs.isArray() && techs.size() > 300, "expected the full tech graph");
			int withIcon = 0, withBeaker = 0;
			for (var t : techs) {
				assertTrue(t.has("Type") && t.has("iGridX"), "tech missing graph fields");
				if (t.has("icon"))
					withIcon++;
				if (t.has("beaker"))
					withBeaker++;
			}
			assertTrue(withIcon > 200, "the art metadata (icon rects) should be merged in, got " + withIcon);
			assertTrue(withBeaker > 0, "the beaker metadata should be merged in");
		}
	}

	@Test
	@Timeout(120)
	void actuatorHealthIsUpAndCorsAllowsTheSite() throws Exception {
		// the static site polls this during its loading screen and reads status==UP; it does so
		// cross-origin, so the CORS header must be present (Actuator CORS is its own config).
		HttpResponse<String> res = client.send(
				HttpRequest.newBuilder(uri("/actuator/health"))
						.header("Origin", "https://anbennar.civstudio.com").GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, res.statusCode());
		assertTrue(res.body().contains("\"status\":\"UP\""), res.body());
		assertEquals("https://anbennar.civstudio.com",
				res.headers().firstValue("Access-Control-Allow-Origin").orElse(null));
	}

	@Test
	@Timeout(120)
	void pingReturnsAServerTimestampAndIsNeverCached() throws Exception {
		long before = System.currentTimeMillis();
		HttpResponse<String> res = client.send(HttpRequest.newBuilder(uri("/api/ping")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, res.statusCode());
		long t = json.readTree(res.body()).path("t").asLong();
		assertTrue(t >= before && t <= System.currentTimeMillis() + 1000,
				"ping should report the server's own clock, got " + t);
		// the whole point of the readout is measuring the network — a cached ping would report ~0ms
		// forever, so no-store is load-bearing, not decoration
		assertTrue(res.headers().firstValue("Cache-Control").orElse("").contains("no-store"),
				"ping must not be cacheable: " + res.headers().map());
	}

	@Test
	@Timeout(120)
	void resourceManifestListsTheEagerSetWithRealServedSizes() throws Exception {
		HttpResponse<String> res = client.send(HttpRequest.newBuilder(uri("/api/resources")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, res.statusCode());
		var body = json.readTree(res.body());
		var resources = body.path("resources");
		assertTrue(resources.size() >= 4, "expected the world assets in the bill: " + res.body());

		// each eager entry must name an endpoint that really serves it, at the size claimed — the
		// manifest's whole job is letting the client total the bytes before fetching, so a wrong
		// number is worse than none. The per-province plots have no fixed size and carry -1.
		long eagerSum = 0;
		for (var e : resources) {
			String path = e.path("path").asString();
			int bytes = e.path("bytes").asInt();
			if (!e.path("eager").asBoolean()) {
				assertEquals(-1, bytes, path + " is lazy, so it should not claim a fixed size");
				continue;
			}
			eagerSum += bytes;
			HttpResponse<byte[]> got = client.send(
					HttpRequest.newBuilder(uri(path)).header("Accept-Encoding", "gzip").GET().build(),
					HttpResponse.BodyHandlers.ofByteArray());
			assertEquals(200, got.statusCode(), path + " is in the bill but does not serve");
			assertEquals(bytes, got.body().length, path + " served a different size than the bill claims");
		}
		assertEquals(eagerSum, body.path("eagerBytes").asLong(),
				"eagerBytes should be the sum of the eager entries the client will actually pull");
	}

	@Test
	@Timeout(120)
	void snapshotEndpointServesOneReadingAndIsEmptyBeforeTheFirstFrame() throws Exception {
		// a session nobody has heard of
		HttpResponse<String> missing = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/nope/snapshot")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(404, missing.statusCode());

		HostedSession hs = host.create(SessionSpec.caravanDemo(223L, DHENIJANSAR));
		hs.startPaused();
		// drive at least one frame, then read it without opening an SSE stream
		hs.step(1);
		long deadline = System.nanoTime() + 60_000_000_000L;
		while (hs.currentSnapshot() == null && System.nanoTime() < deadline)
			Thread.sleep(5);

		HttpResponse<String> res = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/snapshot")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, res.statusCode());
		var colony = json.readTree(res.body()).path("colonies").path(0);
		assertEquals("Dhenijansar", colony.path("name").asString());
		// provinceId is what lets the web rail show a province's live colony inline: lat/lon can't be
		// turned back into a province client-side without inverting the map projection
		assertEquals(DHENIJANSAR, colony.path("provinceId").asInt(),
				"the colony should name the province it sits in");
	}

	@Test
	@Timeout(120)
	void eventsEndpointServesTheRetainedTailAFrameCannotRecover() throws Exception {
		HttpResponse<String> missing = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/nope/events")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(404, missing.statusCode());

		HostedSession hs = host.create(SessionSpec.caravanDemo(223L, DHENIJANSAR));
		hs.startPaused();
		hs.step(1);
		long deadline = System.nanoTime() + 60_000_000_000L;
		while (hs.currentSnapshot() == null && System.nanoTime() < deadline)
			Thread.sleep(5);

		// THE point of this endpoint: founding the colony logs a line, and the snapshot that carried it
		// has already been drained away. A spectator connecting now — or a page that just reloaded —
		// can only recover it from the tail.
		HttpResponse<String> res = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/events")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, res.statusCode());
		var lines = json.readTree(res.body());
		assertTrue(lines.size() > 0, "the tail should still hold the founding line");
		var founding = lines.path(0);
		assertTrue(founding.path("text").asString().contains("founded"),
				"expected the founding line, got: " + founding.path("text").asString());
		assertTrue(founding.path("date").asString().matches("\\d{4}-\\d{2}-\\d{2}"),
				"every line carries an in-game date the board can age from");
		// and it must arrive CURATED — the board renders a curated line as a full card and routine
		// churn as a dim one-liner, so a founding recovered from the tail has to look like the same
		// founding delivered live. This is what LogLine.of centralised; the tail used to flag only
		// warnings, so this line came back routine.
		assertTrue(founding.path("curated").asBoolean(),
				"a founding is a notable event however it reaches the client");
		assertEquals("info", founding.path("sev").asString());

		// the date window the board asks for — everything after the founding day is not the founding
		String day = founding.path("date").asString();
		HttpResponse<String> windowed = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/events?from=9999-01-01")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, windowed.statusCode());
		assertEquals(0, json.readTree(windowed.body()).size(),
				"a window past every line returns nothing, so the board seeds empty rather than stale");

		HttpResponse<String> grepped = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/events?from=" + day + "&grep=founded&limit=1"))
						.GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, grepped.statusCode());
		assertEquals(1, json.readTree(grepped.body()).size(), "limit + grep + from narrow the tail");
	}


	@Test
	@Timeout(120)
	void caravanEndpointServesABandsSurvivalSortedComposition() throws Exception {
		// an unknown session has no band to serve
		HttpResponse<String> missing = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/nope/caravan/1")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(404, missing.statusCode());

		HostedSession hs = host.create(SessionSpec.caravanDemo(225L, DHENIJANSAR));
		hs.startPaused();
		// the colony musters its foraging explorers emergently over winter — step until a band exists
		hs.step(300);
		long deadline = System.nanoTime() + 90_000_000_000L;
		long bandId = -1;
		while (bandId < 0 && System.nanoTime() < deadline) {
			SessionSnapshot s = hs.currentSnapshot();
			if (s != null && !s.caravans().isEmpty())
				bandId = s.caravans().get(0).id();
			else
				Thread.sleep(10);
		}
		assertTrue(bandId >= 0, "the demo colony should muster a band within the season");

		HttpResponse<String> res = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/caravan/" + bandId)).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(200, res.statusCode());
		assertTrue(res.headers().firstValue("Cache-Control").orElse("").contains("no-cache"),
				"a band's makeup changes as it marches, so the sheet must not be cached");
		CaravanDetail d = json.readValue(res.body(), CaravanDetail.class);
		assertEquals(bandId, d.id());
		assertTrue(!d.members().isEmpty(), "the band has a roster");
		assertEquals(12, d.skills().size(), "the band-average profile covers every skill");
		// the roster is ordered by SURVIVAL descending (the leader-succession order)
		for (int i = 1; i < d.members().size(); i++)
			assertTrue(d.members().get(i - 1).survival() >= d.members().get(i).survival(),
					"roster must be survival-descending");
		// exactly one member is flagged the leader
		assertEquals(1, d.members().stream().filter(CaravanDetail.Crew::leader).count(),
				"exactly one leader is flagged");

		// a bogus band id on a real session is a clean 404
		HttpResponse<String> noBand = client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/caravan/999999999")).GET().build(),
				HttpResponse.BodyHandlers.ofString());
		assertEquals(404, noBand.statusCode());
	}

	private String currentSnapshotBody(HostedSession hs) throws Exception {
		return client.send(
				HttpRequest.newBuilder(uri("/api/sessions/" + hs.id() + "/snapshot")).GET().build(),
				HttpResponse.BodyHandlers.ofString()).body();
	}

	private URI uri(String path) {
		return URI.create("http://localhost:" + port + path);
	}

	// read the next SSE "data:" line's payload (Spring writes "data:<json>", no leading space)
	private static String nextData(BufferedReader r) throws IOException {
		String line;
		while ((line = r.readLine()) != null)
			if (line.startsWith("data:")) {
				String d = line.substring("data:".length());
				return d.startsWith(" ") ? d.substring(1) : d;
			}
		throw new IOException("stream ended before a data frame");
	}
}
