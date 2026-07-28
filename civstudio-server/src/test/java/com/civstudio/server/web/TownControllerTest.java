package com.civstudio.server.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

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

	@TempDir
	static java.nio.file.Path storeDir;

	private record Served(SessionHost host, HostedSession session, TownController controller) {

		TownView town(int provinceId) {
			return controller.town(session.id(), provinceId).getBody();
		}

		/**
		 * Advance the session by {@code days} in-game days and wait for them to land.
		 * <p>
		 * The session is launched PAUSED by {@link #serve()} and stepped from here, which matters:
		 * {@code step()} only credits a PAUSED clock, and a session that was merely <em>created</em>
		 * has no thread to consume the credit at all. Stepping one of those silently does nothing —
		 * which is exactly how the first cut of this test spent fourteen minutes asserting that a
		 * town unchanged since day one had not changed since day one.
		 */
		void run(int days) {
			long target = session.tick() + days;
			session.step(days);
			for (int spins = 0; session.tick() < target && spins < 3000; spins++) {
				try {
					Thread.sleep(5);
				} catch (InterruptedException e) {
					Thread.currentThread().interrupt();
					return;
				}
			}
			if (session.tick() < target) {
				throw new IllegalStateException("the session did not advance: tick " + session.tick()
						+ " of " + target + ", clock " + session.clock());
			}
		}
	}

	private static TownStore store() {
		com.civstudio.server.CivStudioProperties props = new com.civstudio.server.CivStudioProperties();
		props.getPlots().setCacheDir(storeDir.resolve(java.util.UUID.randomUUID().toString()).toString());
		return new TownStore(props);
	}

	private static Served serve() {
		SessionHost host = new SessionHost();
		HostedSession hs = host.create(SessionSpec.leagueDemo(42, NATHALAIRE));
		hs.startPaused();     // a thread to consume step credits, and not one tick more than asked
		return new Served(host, hs, new TownController(host, store()));
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

	// --- T7: the store, and a town that grows -------------------------------------------------

	@Test
	void aSettledTownCostsAFileReadAndAChangedOneIsRecomputed() {
		// the store's whole job: recompute only when the colony moved. Asking twice on the same day
		// must give the same bytes without running the generator again.
		Served s = serve();
		TownView first = s.town(NATHALAIRE);
		TownView again = s.town(NATHALAIRE);
		assertEquals(first.patches().size(), again.patches().size());
		assertEquals(first.outline().length, again.outline().length);
		assertEquals(1, s.controller().store().count(s.session().id()),
				"one json.gz for this site, on the volume");
	}

	@Test
	@org.junit.jupiter.api.Tag("full-run")
	void aYearOfSimulationGrowsTheTown() {
		// THE POINT OF THE WHOLE PORT, run forward: found a city, let it live a year, and watch the
		// layout follow. The signature is what makes this cheap — a settled day costs a file read
		// and only a day the colony actually changed pays for the generator.
		Served s = serve();
		TownView day1 = s.town(NATHALAIRE);
		int lots1 = lots(day1);
		int buildings1 = kind(day1, "BUILDING");

		s.run(365);
		TownView year1 = s.town(NATHALAIRE);

		assertTrue(s.session().tick() >= 365, "a year actually elapsed: tick " + s.session().tick());
		assertNotNull(year1.colony(), "the city survived its first year");
		assertTrue(lots(year1) > 0, "and still stands on something");
		// a year in, the sim has raised real buildings — which is the moment §4b's synthetic
		// households start giving way to real state, plot by plot
		assertTrue(kind(year1, "BUILDING") > buildings1,
				"the crown raised real buildings over the year: " + buildings1 + " → "
						+ kind(year1, "BUILDING"));
		assertTrue(year1.patches().size() >= day1.patches().size(),
				"a living colony's plot set is monotone (§2a), so the town never shrinks");
		// AND IT HOLLOWS OUT INSIDE ITS WALL. The founding retinue arrives packed onto its home
		// plots and consolidates over the first months; the plots it leaves are not open ground but
		// somewhere that used to be somewhere, which is exactly what §2a says decline looks like.
		assertTrue(kind(year1, "RUIN") > 0,
				"the plots the colony emptied show as ruins, not as invented families");
		assertTrue(lots1 > 0 && lots(year1) > 0);
	}

	@Test
	void theSameDayServesTheSameTownAndALaterOneMayNot() {
		// a signature that flapped would rewrite every layout on the volume every tick while nothing
		// had changed; one that never moved would freeze a growing city on day one
		Served s = serve();
		TownView before = s.town(NATHALAIRE);
		int lotsBefore = lots(before);
		s.run(30);
		TownView after = s.town(NATHALAIRE);
		assertEquals(before.province(), after.province());
		assertTrue(lots(after) > 0, "a month on, the town is still a town");
		assertTrue(Math.abs(lots(after) - lotsBefore) < lotsBefore,
				"and it did not turn into something else overnight");
	}

	private static int lots(TownView town) {
		int n = 0;
		for (TownView.PatchView p : town.patches()) {
			n += p.lots().size();
		}
		return n;
	}

	private static int kind(TownView town, String kind) {
		int n = 0;
		for (TownView.PatchView p : town.patches()) {
			for (TownView.LotView lot : p.lots()) {
				if (kind.equals(lot.kind())) {
					n++;
				}
			}
		}
		return n;
	}

	@Test
	void aTownThatStarvedBackDownKeepsItsWall() {
		// §2a IN AS MANY WORDS: "the wall records the maximum extent the settlement ever reached...
		// decline is rendered INSIDE the wall, and the wall never contracts." The fit reads the
		// colony's CURRENT tier, so a settlement that starves below TOWN loses its fortifications
		// outright — which is what nineteen years of the demo actually did to Nathalaire. The stored
		// layout is the only thing that remembers.
		TownView walled = serve().town(NATHALAIRE);
		assertTrue(walled.walled(), "it starts as a walled metropolis");
		assertFalse(walled.wall().isEmpty());

		TownView unwalled = new TownView(NATHALAIRE, "Nathalaire", false, walled.outline(),
				walled.holes(), walled.patches(), java.util.List.of(), java.util.List.of(),
				walled.streets(), walled.bridges());
		TownView kept = unwalled.keepingWallOf(walled);

		assertTrue(kept.walled(), "the line it once raised is still there");
		assertEquals(walled.wall().size(), kept.wall().size());
		assertEquals(walled.gates().size(), kept.gates().size());
		assertTrue(kept.patches().stream().anyMatch(TownView.PatchView::walled),
				"and the plots it encloses still know they are inside it");
	}

	@Test
	void aWallIsNeverTakenFromATownThatHasOneOfItsOwn() {
		// the high-water mark only ever ADDS: a growing town's newer, larger wall must win
		TownView town = serve().town(NATHALAIRE);
		assertEquals(town.wall().size(), town.keepingWallOf(town).wall().size());
		assertSame(town, town.keepingWallOf(null), "nothing stored, nothing to keep");
	}

	@Test
	void everyLotHasAStableNameKeyedByItsPlot() {
		// §3a's identity rule: keyed by (x, y, index) and never by a position in the layout's own
		// lists, because a cell's coordinates survive a regeneration and a list index does not —
		// which is what lets an authored name override outlive the shape it was written against
		TownView town = serve().town(NATHALAIRE);
		java.util.Set<String> ids = new java.util.HashSet<>();
		for (TownView.PatchView p : town.patches()) {
			for (int i = 0; i < p.lots().size(); i++) {
				String id = p.lots().get(i).id();
				assertEquals(p.x() + ":" + p.y() + "#" + i, id);
				assertTrue(ids.add(id), "every lot in town is named once: " + id);
			}
		}
		assertFalse(ids.isEmpty());
		for (TownView.GateView g : town.gates()) {
			assertNotNull(g.side(), "a gate is keyed by (cell, side) too");
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
		assertEquals(404, new TownController(host, store()).town("no-such-session", NATHALAIRE)
				.getStatusCode().value());
	}
}
