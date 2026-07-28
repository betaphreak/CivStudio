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
	void theStreetsTravelAsSmoothedLinesThatKnowWhatTheyAre() {
		TownView town = serve().town(NATHALAIRE);
		assertFalse(town.streets().isEmpty(), "a city has streets");
		long arteries = town.streets().stream().filter(s -> "MAIN".equals(s.kind())).count();
		assertTrue(arteries >= 1, "at least one reaches the centre");
		for (TownView.StreetView s : town.streets()) {
			assertTrue(s.line().length >= 2, "a street is a line");
			assertEquals(2, s.line()[0].length, "and a point is [x, y]");
			assertTrue(s.bridges() >= 0);
		}
		// the corner-cutting happened server-side, so the client draws what it is given: a street
		// that ran nine plots arrives with far more than nine points
		assertTrue(town.streets().stream().anyMatch(s -> s.line().length > 20),
				"the artery arrives smoothed, not as a plot-to-plot staircase");
	}

	@Test
	void aStreetEndsWhereItJoinsAnother() {
		// the junction pinning of Polyline, checked on the wire: a branch's last point must be a
		// point the artery also has, or every crossroads draws a gap
		TownView town = serve().town(NATHALAIRE);
		TownView.StreetView artery = town.streets().stream().filter(s -> "MAIN".equals(s.kind()))
				.findFirst().orElseThrow();
		for (TownView.StreetView s : town.streets()) {
			if ("MAIN".equals(s.kind())) {
				continue;
			}
			double[] end = s.line()[s.line().length - 1];
			boolean onSomeStreet = false;
			for (TownView.StreetView other : town.streets()) {
				if (other == s) {
					continue;
				}
				for (double[] p : other.line()) {
					if (p[0] == end[0] && p[1] == end[1]) {
						onSomeStreet = true;
					}
				}
			}
			assertTrue(onSomeStreet, "the branch ends on a street the town already has");
		}
		assertNotNull(artery);
	}

	@Test
	void everyPatchSaysWhatItIsAndWhatStandsOnIt() {
		TownView town = serve().town(NATHALAIRE);
		int withLots = 0;
		java.util.Set<String> wards = new java.util.HashSet<>();
		for (TownView.PatchView p : town.patches()) {
			assertNotNull(p.ward(), "a patch is a plot, and a plot has a district");
			wards.add(p.ward());
			if (!p.lots().isEmpty()) {
				withLots++;
			}
			for (TownView.LotView lot : p.lots()) {
				assertNotNull(lot.kind());
				assertTrue(lot.poly().length >= 3, "a lot is a polygon");
				assertEquals(2, lot.poly()[0].length, "and a point is [x, y]");
				if ("BUILDING".equals(lot.kind())) {
					assertNotNull(lot.building(), "a building lot names its building");
				} else {
					assertNull(lot.building(), lot.kind() + " carries no building id");
				}
			}
		}
		assertTrue(wards.contains("CITY_CENTER"), "the founding plot is in there: " + wards);
		assertTrue(wards.size() >= 4, "a city is more than one kind of ground: " + wards);
		assertTrue(withLots > town.patches().size() / 2,
				withLots + " of " + town.patches().size() + " patches have somebody on them");
	}

	@Test
	void aFoundedCityIsPopulatedOnDayOne() {
		// §4b end to end: the sim has claimed one plot, and the city still reads as a city rather
		// than as a curtain wall around empty blocks
		TownView town = serve().town(NATHALAIRE);
		int dwellings = 0;
		for (TownView.PatchView p : town.patches()) {
			for (TownView.LotView lot : p.lots()) {
				if ("DWELLING".equals(lot.kind())) {
					dwellings++;
				}
			}
		}
		assertTrue(dwellings > 20, "a development-27 city houses more than a hamlet: " + dwellings);
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
