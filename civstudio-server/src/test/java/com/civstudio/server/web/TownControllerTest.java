package com.civstudio.server.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

import com.civstudio.server.HostedSession;
import com.civstudio.server.SessionHost;
import com.civstudio.server.SessionSpec;
import com.civstudio.server.render.TownView;

/**
 * The town-layout endpoint ({@code docs/towngen-port.md} T7, prototype) — the first time anything
 * the town generator computes leaves the server. Served against the league demo at Nathalaire, the
 * site we have a hand-drawn reference for (§2c).
 */
class TownControllerTest {

	private static final int NATHALAIRE = 451;

	private record Served(SessionHost host, HostedSession session, TownController controller) {

		TownView town(int provinceId) {
			return controller.town(session.id(), provinceId).getBody();
		}
	}

	private static Served serve() {
		SessionHost host = new SessionHost();
		HostedSession hs = host.create(SessionSpec.leagueDemo(42, NATHALAIRE));
		return new Served(host, hs, new TownController(host));
	}

	@Test
	void theSiteServesItsTown() {
		TownView town = serve().town(NATHALAIRE);
		assertNotNull(town);
		assertEquals(NATHALAIRE, town.province());
		assertNotNull(town.colony(), "a live colony stands there");
		// 27 is Nathalaire's own 1444 development, and it does not get all of it: this is a LEAGUE,
		// so the plots nearer a vassal city belong to that city (docs/city-and-league.md). One
		// patch per plot the lead city actually holds.
		assertEquals(23, town.patches().size(), "one patch per plot the lead city holds");
		assertTrue(town.patches().size() < 27, "its neighbours took the ground nearer them");
		assertTrue(town.outline().length > 4, "an irregular outline, not a box");
		assertTrue(town.walled(), "a metropolis is fortified");
	}

	@Test
	void theWallTravelsAsPerPlotEdgesTypedByWhatIsBeyondThem() {
		TownView town = serve().town(NATHALAIRE);
		assertFalse(town.wall().isEmpty());
		long quay = town.wall().stream().filter(w -> "QUAY".equals(w.kind())).count();
		long curtain = town.wall().stream().filter(w -> "CURTAIN".equals(w.kind())).count();
		assertTrue(quay > curtain, "the pirate city's line is mostly waterfront: "
				+ quay + " quay, " + curtain + " curtain");
		for (TownView.WallView w : town.wall()) {
			assertEquals(2, w.line().length, "a segment is two points");
			assertEquals(2, w.line()[0].length, "and a point is [x, y]");
			assertNotNull(w.side());
		}
	}

	@Test
	void gatesSayWhatTheyFace() {
		TownView town = serve().town(NATHALAIRE);
		assertFalse(town.gates().isEmpty(), "roads leave this province");
		for (TownView.GateView g : town.gates()) {
			assertNotNull(g.toward(), "a gate knows its neighbour");
			assertEquals(2, g.at().length);
		}
	}

	@Test
	void everyPointIsInPlotRasterSpace() {
		// the coordinate contract (§3): the client projects these with the same projectOn the plot
		// grid uses, so they must be plot coordinates and not pixels or normalised anything
		TownView town = serve().town(NATHALAIRE);
		TownView.PatchView first = town.patches().get(0);
		for (double[] pt : first.poly()) {
			assertTrue(Math.abs(pt[0] - first.x()) <= 2, "patch point near its own plot: " + pt[0]);
			assertTrue(Math.abs(pt[1] - first.y()) <= 2, "patch point near its own plot: " + pt[1]);
		}
	}

	@Test
	void aSiteWithNoTownAnswersEmptyRatherThanMissing() {
		// a client asking about every province in view must get a cheap, cacheable "nothing here"
		TownView town = serve().town(9999);
		assertNotNull(town);
		assertNull(town.colony());
		assertTrue(town.patches().isEmpty());
		assertFalse(town.walled());
	}

	@Test
	void anUnknownSessionIs404() {
		SessionHost host = new SessionHost();
		assertEquals(404, new TownController(host).town("no-such-session", NATHALAIRE)
				.getStatusCode().value());
	}
}
