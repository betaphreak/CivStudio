package com.civstudio.server.registry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;

import com.civstudio.data.WorldSources;
import org.springframework.boot.test.context.SpringBootTest;

import com.civstudio.server.ClockState;
import com.civstudio.server.HostedSession;
import com.civstudio.server.SessionHost;
import com.civstudio.server.SessionSpec;
import com.civstudio.settlement.Settlement;

/**
 * With a datasource configured (H2 here), runs and seats are written to the actual database — the
 * Phase-6 contract ({@code docs/spectator-lobby.md}). Verifies that {@code PersistenceConfig} wires
 * the {@link JdbcSessionRegistry}, that {@link SessionHost} records what it does, and — the point of
 * the whole phase — that <b>a redeploy cannot hand a ranked player a second attempt</b>.
 */
@SpringBootTest(properties = {
		"civstudio.demo.enabled=false",
		"spring.datasource.url=jdbc:h2:mem:registry;DB_CLOSE_DELAY=-1",
		"spring.datasource.username=sa",
		"spring.datasource.password=" })
class SessionPersistenceTest {

	private static final int DHENIJANSAR = 4411;

	@Autowired
	SessionHost host;

	@Autowired
	SessionRegistry registry;

	@AfterEach
	void cleanup() {
		host.stopAll();
	}

	@Test
	void aDatasourceMakesTheRegistryDurable() {
		assertInstanceOf(JdbcSessionRegistry.class, registry,
				"with a datasource the registry must be the durable one, or ranked silently resets");
	}

	@Test
	@Timeout(180)
	void foundingARunWritesItDown() {
		HostedSession hs = host.create(new SessionSpec(6001L, "registry-test", DHENIJANSAR), "alice");

		SessionRecord r = registry.find(hs.id()).orElseThrow();
		assertEquals("registry-test", r.scenario());
		assertEquals(6001L, r.seed());
		assertEquals(DHENIJANSAR, r.provinceId());
		assertEquals("alice", r.owner());
		assertEquals("CREATED", r.clockState(), "recorded before it can end");
		assertEquals("LIVE", r.outcome(), "and it has not ended itself");
		assertEquals("SINGLE_PLAYER", r.kind(), "an owned, non-Timeline run is a save slot");
		assertTrue(registry.all().stream().anyMatch(x -> x.id().equals(hs.id())));
	}

	@Test
	@Timeout(180)
	void joiningATimelineWritesTheSeat() {
		HostedSession hs = host.create(SessionSpec.timeline(6002L, DHENIJANSAR), null);
		Settlement alice = host.joinTimeline(hs.id(), "alice");
		Settlement bob = host.joinTimeline(hs.id(), "bob");

		List<SeatRecord> seats = registry.seats(hs.id());
		assertEquals(2, seats.size());
		assertEquals("alice", seats.get(0).userId(), "seats are recorded in join order");
		assertEquals(alice.getName(), seats.get(0).colonyName());
		assertEquals(alice.getProvince().id(), seats.get(0).provinceId());
		assertEquals("bob", seats.get(1).userId());
		assertEquals(bob.getProvince().id(), seats.get(1).provinceId());

		assertEquals("alice", registry.seatOf(hs.id(), "alice").orElseThrow().userId());
		assertTrue(registry.seatOf(hs.id(), "carol").isEmpty());
	}

	/**
	 * The whole reason this phase exists. A redeploy throws away the live session map; if the seat
	 * only lived there, a ranked player would quietly get a second attempt. The durable record is
	 * what refuses them.
	 */
	@Test
	@Timeout(300)
	void aRedeployCannotHandAPlayerASecondSeat() {
		SessionSpec spec = SessionSpec.timeline(6003L, DHENIJANSAR);
		HostedSession before = host.create(spec, null);
		host.joinTimeline(before.id(), "alice");
		String id = before.id();

		// the redeploy: this process forgets every live session, the database does not
		host.stopAll();
		HostedSession after = host.create(spec, null);
		assertEquals(id, after.id(), "the same spec comes back under the same id");
		assertTrue(after.colonies().isEmpty(), "the live world is genuinely gone");

		SessionRegistry.SeatTakenException denied = assertThrows(
				SessionRegistry.SeatTakenException.class, () -> host.joinTimeline(id, "alice"));
		assertTrue(denied.getMessage().contains("alice"), denied.getMessage());
		// ...and the record still knows exactly what she held
		assertNotNull(registry.seatOf(id, "alice").orElseThrow().colonyName());
		// a player who never joined is still welcome
		assertNotNull(host.joinTimeline(id, "bob"));
	}

	/**
	 * A finished run is finished. Re-founding its spec — which is exactly what a redeploy does — must
	 * not quietly reopen it: that would hand a ranked player the retry the whole phase exists to
	 * deny, by erasing the verdict rather than by losing it.
	 */
	@Test
	@Timeout(180)
	void refoundingAFinishedRunDoesNotReopenIt() {
		SessionSpec spec = new SessionSpec(6004L, "registry-test", DHENIJANSAR);
		HostedSession hs = host.create(spec, "alice");
		String id = hs.id();
		// stand in for a run that ended: the registry is the authority on that
		registry.updateProgress(id, "STOPPED", "ABANDONED",
				"Dhenijansar departed as a Caravan on 1452-03-02", 2639);

		host.stopAll(); // the redeploy

		assertThrows(SessionHost.RunFinishedException.class, () -> host.create(spec, "alice"),
				"a finished run must not be re-founded under its own id");
		SessionRecord after = registry.find(id).orElseThrow();
		assertTrue(after.isFinished(), "its verdict must not be overwritten");
		assertEquals("ABANDONED", after.outcome());
		assertEquals("GAME_OVER", after.legacyState(), "the legacy mirror still reads game over");
		assertEquals(2639, after.tick());
		assertNotNull(after.endReason());
	}

	/**
	 * Restore, the continuity half: a Timeline still open for joins comes back with its roster
	 * intact — same players, same colonies, same provinces — because founding is deterministic and
	 * the seats replay in the order they were taken. The cheap, exact case: nothing to fast-forward.
	 */
	@Test
	@Timeout(300)
	void restoringAnOpenTimelineRebuildsItsRoster() {
		SessionSpec spec = SessionSpec.timeline(6005L, DHENIJANSAR);
		HostedSession before = host.create(spec, null);
		Settlement aliceBefore = host.joinTimeline(before.id(), "alice");
		Settlement bobBefore = host.joinTimeline(before.id(), "bob");
		String id = before.id();

		host.stopAll(); // the redeploy: this process forgets everything

		HostedSession after = host.restore(id);
		assertNotNull(after, "an unfinished run must be restorable");
		assertEquals(2, after.colonies().size(), "both seats came back");
		assertEquals(ClockState.CREATED, after.clock(), "and it is still open for joins");

		Settlement aliceAfter = after.colonyOf("alice");
		Settlement bobAfter = after.colonyOf("bob");
		assertNotNull(aliceAfter, "alice still holds her seat");
		assertNotNull(bobAfter);
		assertEquals(aliceBefore.getName(), aliceAfter.getName(), "the same colony, re-founded");
		assertEquals(aliceBefore.getProvince().id(), aliceAfter.getProvince().id());
		assertEquals(bobBefore.getName(), bobAfter.getName());
		assertEquals(bobBefore.getProvince().id(), bobAfter.getProvince().id());
		assertEquals("alice", after.ownerOf(aliceAfter.getName()), "and it is still hers");
	}

	/**
	 * STOPPED is not finished. A graceful shutdown stops <b>every</b> session, so if "stopped from
	 * outside" counted as over, a single redeploy would permanently kill everything it touched —
	 * the exact opposite of what restore is for. Only a run that ended <em>itself</em> is beyond
	 * coming back (see {@code docs/game-over.md} on why the two states are distinct).
	 */
	@Test
	@Timeout(180)
	void aRunStoppedByAShutdownIsNotFinishedAndComesBack() {
		SessionSpec spec = new SessionSpec(6008L, "registry-test", DHENIJANSAR);
		HostedSession hs = host.create(spec, "alice");
		hs.startPaused();
		hs.stop(); // what shutdown does to every session

		SessionRecord stopped = registry.find(hs.id()).orElseThrow();
		assertEquals("STOPPED", stopped.clockState());
		assertEquals("LIVE", stopped.outcome(), "stopped from outside is not finished — it stays LIVE");
		assertFalse(stopped.isFinished());
		host.stopAll();

		assertNotNull(host.getOrRestore(hs.id()), "a shutdown must not be a death sentence");
		host.stopAll();
		assertNotNull(host.create(spec, "alice"), "...and re-founding it is fine too");
	}

	/** A restored run picks up where it left off: the recorded tick is replayed, not skipped. */
	@Test
	@Timeout(300)
	void restoringARunningSessionFastForwardsToItsTick() {
		SessionSpec spec = new SessionSpec(6006L, "registry-test", DHENIJANSAR);
		HostedSession before = host.create(spec, "alice");
		before.setTickRateMillis(0);
		before.startPaused();
		before.step(40);
		long deadline = System.nanoTime() + 120_000L * 1_000_000L;
		while (before.tick() < 40 && System.nanoTime() < deadline)
			Thread.onSpinWait();
		assertEquals(40, before.tick());
		String id = before.id();
		String dateBefore = before.date().toString();
		before.stop(); // recorded as STOPPED at tick 40

		host.stopAll();
		HostedSession after = host.getOrRestore(id);
		assertNotNull(after);
		assertEquals(40, after.tick(), "it replayed the days it had lived, rather than restarting");
		assertEquals(dateBefore, after.date().toString(), "so its clock reads the same day");
		assertEquals(1, after.colonies().size());
	}

	/**
	 * A restored run comes back <b>paused</b>, even though it was RUNNING when the process went
	 * down (owner decision, 2026-07-27). Restoring used to re-{@code resume()} it, so the first
	 * visitor after a redeploy found days already spent on their behalf — and spent at the
	 * fast-forward's uncapped rate, which was never handed back either.
	 */
	@Test
	@Timeout(300)
	void aRestoredRunComesBackPaused() {
		SessionSpec spec = new SessionSpec(6009L, "registry-test", DHENIJANSAR);
		HostedSession before = host.create(spec, "alice");
		before.setTickRateMillis(0);
		before.startPaused();
		before.step(20);
		long deadline = System.nanoTime() + 120_000L * 1_000_000L;
		while (before.tick() < 20 && System.nanoTime() < deadline)
			Thread.onSpinWait();
		before.resume();                       // …and is recorded RUNNING
		String id = before.id();
		host.stopAll();

		HostedSession after = host.getOrRestore(id);
		assertNotNull(after);
		assertEquals(ClockState.PAUSED, after.clock(),
				"a restored run waits for you rather than running on without you");
	}

	/** getOrRestore is the caller's door: a live run is handed back, a recorded one rebuilt. */
	@Test
	@Timeout(180)
	void getOrRestoreReturnsNullForWhatCannotComeBack() {
		assertNull(host.getOrRestore("never-existed"), "nothing recorded, nothing to restore");

		SessionSpec spec = new SessionSpec(6007L, "registry-test", DHENIJANSAR);
		HostedSession hs = host.create(spec, "alice");
		assertSame(hs, host.getOrRestore(hs.id()), "a live run is simply handed back");

		registry.updateProgress(hs.id(), "STOPPED", "LOST", "it ended", 10);
		host.stopAll();
		assertNull(host.getOrRestore(hs.id()),
				"a finished run is not rebuilt — its outcome is columns, not a world");
	}

	// REMOVED (2026-07-23): theOutcomeOfAFinishedRunIsRecorded. Its premise died with the
	// build-economy default flip — it waited (busy-spinning for up to 540s) for the demo colony to
	// "collapse so the run ends itself", but colonies SURVIVE by design now, and a HostedSession has
	// no horizon: runOver() is purely allDead(). So the run can never finish on its own and the test
	// could only ever burn nine minutes and then fail. The recording path it covered still is:
	// aStoppedRunIsNotAFinishedOne + the updateProgress/outcome assertions above exercise the same
	// registry columns without waiting on a death that no longer comes.

	@Test
	@Timeout(180)
	void theContentVersionARunWasFoundedAgainstIsRecorded() {
		// Reproducibility is seed + contentVersion + command log. The seed fixes the draws, but the
		// world (and, once balance rides the bundle, the numbers it was tuned with) comes from studio
		// and moves independently of the code — so the version has to be written down WITH the run.
		HostedSession hs = host.create(new SessionSpec(6009L, "registry-test", DHENIJANSAR), "alice");
		SessionRecord r = registry.find(hs.id()).orElseThrow();

		// the test context runs on the classpath source, which carries no version — and that must
		// round-trip as null ("unknown"), never be quietly filled in with whatever is current now
		assertEquals(WorldSources.contentVersion(), r.contentVersion(),
				"the record keeps the version the run was actually founded against");

		// and it survives a progress update — the column must not be dropped by the UPDATE path
		registry.updateProgress(hs.id(), "PAUSED", "LIVE", null, 42L);
		assertEquals(WorldSources.contentVersion(), registry.find(hs.id()).orElseThrow().contentVersion(),
				"updating progress must not erase the founding content version");
	}
}
