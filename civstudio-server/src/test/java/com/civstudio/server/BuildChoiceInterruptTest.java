package com.civstudio.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.parallel.Isolated;

import com.civstudio.server.command.QueueBuildCommand;
import com.civstudio.server.render.SessionSnapshot;

/**
 * The B6 <b>pause-and-choose interrupt</b>, end to end (see {@code docs/build-queue-plan.md} B6 and
 * {@code docs/city-screen-plan.md}): a player-driven session whose crown queue runs dry stops the
 * clock, offers its candidates, and — the part this exists to pin — <b>starts again on a single
 * order</b>.
 *
 * <p>It did not, once. A command submitted during tick {@code T} is stamped {@code T+1}, so it is
 * not yet due when the tick ends; the pause check read the still-empty queue and stopped the clock
 * before the next iteration could drain the order. The run then sat forever holding the answer it
 * had been given, and a second submission was needed to release the first (stranding the second in
 * turn). One order in, one building started, is the contract.
 *
 * <p>{@link Isolated} because the interrupt is gated by a JVM-wide system property that the test
 * tier turns off (a suite has nobody to answer a modal); this class turns it on for its own run and
 * must not have that seen by a session running in parallel.
 */
@Isolated
class BuildChoiceInterruptTest {

	private static final int DHENIJANSAR = 4411;
	private static final String FLAG = "civstudio.buildchoice.interactive";

	@Test
	@Timeout(120)
	void oneOrderResumesASessionPausedOnAnEmptyQueue() {
		String prior = System.getProperty(FLAG);
		System.setProperty(FLAG, "true");
		SessionHost host = new SessionHost();
		// A SINGLE-PLAYER session, and that is the point: the interrupt is a save slot's feature.
		// This used to found a DEMO, because the demo was player-driven too — until that turned out
		// to freeze the deployed public demo on its opening days waiting for a decree from a visitor
		// who is not signed in and never asked to drive (see SessionKind.playerChoosesBuilds).
		HostedSession hs = host.create(SessionSpec.caravanDemo(7654321L, DHENIJANSAR), "tester",
				SessionKind.SINGLE_PLAYER, null, null);
		try {
			hs.start();
			// a save slot is player-driven, so its heuristic is off: the queue genuinely runs dry. Wait
			// for the CLOCK too — an idle queue shows in a cadence frame a moment before the pause
			// itself lands, and the point here is that the clock really stops.
			SessionSnapshot waiting = await(hs,
					s -> s.awaitingBuildChoice() && hs.clock() == ClockState.PAUSED, 60_000,
					"the session to pause awaiting a build choice");
			assertFalse(waiting.buildCandidates().isEmpty(), "the modal is offered real candidates");
			String colony = waiting.colonies().get(0).name();
			String pick = waiting.buildCandidates().get(0);

			// ONE order — exactly what the modal (and the city screen) submits
			hs.submit(new QueueBuildCommand(hs.tick() + 1, colony, List.of(pick), false));

			SessionSnapshot building = await(hs, s -> s.colonies().get(0).queue().active() != null,
					60_000, "the crown to begin the ordered building");
			assertEquals(pick, building.colonies().get(0).queue().active(),
					"it builds what was ordered, not the brain's own pick");
			assertTrue(building.colonies().get(0).queue().cost() > 0,
					"the active item reports the cost its progress bar needs");
			assertFalse(building.awaitingBuildChoice(), "and it is no longer waiting on the player");
		} finally {
			hs.stop();
			host.shutdown();
			if (prior == null)
				System.clearProperty(FLAG);
			else
				System.setProperty(FLAG, prior);
		}
	}

	// poll the session's snapshot until `want` holds, or fail saying what never happened
	private static SessionSnapshot await(HostedSession hs,
			java.util.function.Predicate<SessionSnapshot> want, long timeoutMs, String what) {
		long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
		while (System.nanoTime() < deadline) {
			SessionSnapshot snap = hs.currentSnapshot();
			if (snap != null && !snap.colonies().isEmpty() && want.test(snap))
				return snap;
			try {
				Thread.sleep(10);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				fail("interrupted");
			}
		}
		SessionSnapshot last = hs.currentSnapshot();
		assertNotNull(last, "no snapshot at all while waiting for " + what);
		return fail("timed out waiting for " + what + " (clock " + hs.clock() + ", tick "
				+ last.tick() + ", awaiting " + last.awaitingBuildChoice() + ", queue "
				+ last.colonies().get(0).queue() + ")");
	}
}
