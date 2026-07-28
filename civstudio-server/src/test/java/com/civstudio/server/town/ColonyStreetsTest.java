package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDate;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.Province;
import com.civstudio.server.town.TownStreets.Kind;
import com.civstudio.server.town.TownStreets.Street;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.GameSession;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.PlotOccupant;
import com.civstudio.settlement.ProvincePlotPool;
import com.civstudio.settlement.Settlement;

/**
 * Streets against a real colony on the canonical site — <b>Nathalaire</b> (§9). Everything the
 * router charges for here comes off real plots: the heightmap under the town, the channels running
 * through it, and the border crossings its gates already point at.
 */
class ColonyStreetsTest {

	private static final LocalDate START = LocalDate.of(1444, 12, 11);

	private record Founded(GameSession session, Settlement colony, Province province) {

		ProvincePlotPool pool() {
			return session.plotPoolIfPresent(province.id());
		}
	}

	private static Founded found() {
		GameSession s = new GameSession(42);
		Province np = s.getWorldMap().findByName("Nathalaire").orElseThrow();
		Settlement c = s.newSettlement("Nathalaire", START, 30, 26, 5, 2, np);
		c.claimPlot(new PlotOccupant() {
		});
		return new Founded(s, c, np);
	}

	private static TownStreets streetsOf(Founded f) {
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());
		TownMesh mesh = TownMesh.of(fp, TownRng.siteSeed(f.session().getSeed(), f.province().id()));
		TownWall wall = ColonyWall.of(f.colony(), f.pool(), f.session().getWorldMap(), fp);
		return ColonyStreets.of(f.colony(), f.pool(), f.session().getWorldMap(), fp, mesh, wall);
	}

	@Test
	void aRealCityGetsARealStreetNetwork() {
		Founded f = found();
		TownStreets streets = streetsOf(f);
		assertFalse(streets.isEmpty(), "Nathalaire has streets: " + streets.diag());
		assertTrue(streets.diag().arteries() >= 1, "at least one reaches the centre");
		for (Street s : streets.streets()) {
			assertTrue(s.points().size() >= 2);
			assertTrue(s.cells().size() >= 2);
		}
		// the numbers this site actually produces, pinned the way the wall's 20-quay-to-5-curtain is:
		// one artery out to the Flooded Coast and three landings meeting it, which is the shape the
		// reference picture has. If a tuning change moves these, it should have to say so out loud.
		assertEquals(4, streets.streets().size(), streets.diag().toString());
		assertEquals(1, streets.diag().arteries(), streets.diag().toString());
		assertEquals(3, streets.diag().junctions(), streets.diag().toString());
		assertEquals(9, streets.streets().get(0).cells().size(), "the high street runs nine plots");
	}

	@Test
	void everyStreetStaysOnGroundTheTownActuallyStandsOn() {
		// the router only ever sees the footprint, so this is a guarantee rather than a hope — but it
		// is the guarantee that matters, since a street off the footprint is a street over the bay
		Founded f = found();
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());
		Set<Cell> ground = new HashSet<>(fp.allCells());
		for (Street s : streetsOf(f).streets()) {
			for (Cell c : s.cells()) {
				assertTrue(ground.contains(c), "the street stayed in town: " + c);
			}
		}
	}

	@Test
	void theRoadsLeaveTownTowardTheNeighboursTheGatesFace() {
		Founded f = found();
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());
		TownWall wall = ColonyWall.of(f.colony(), f.pool(), f.session().getWorldMap(), fp);
		TownStreets streets = streetsOf(f);

		Set<String> gates = new HashSet<>(wall.gates().stream().map(TownWall.Gate::toward).toList());
		assertFalse(gates.isEmpty(), "roads do leave this province");
		assertTrue(streets.streets().stream().anyMatch(s -> gates.contains(s.toward())),
				"a gate's street carries that gate's neighbour");
		for (Street s : streets.streets()) {
			// a named street came in at a gate; an unnamed one is a landing off the quay, which on a
			// city that is 20 quay to 5 curtain is most of how anyone arrives (WAYS_IN)
			assertTrue(s.toward() == null || gates.contains(s.toward()),
					"no street faces a neighbour no gate does: " + s.toward());
		}
		assertTrue(streets.streets().size() >= 3,
				"a walled city gets a network, not one road: " + streets.diag());
	}

	@Test
	void theSameColonyLaysTheSameStreetsTwice() {
		// the layout is keyed randomness all the way down, so this holds across whole regenerations
		assertEquals(paths(streetsOf(found())), paths(streetsOf(found())));
	}

	@Test
	void aStreetIsSmoothedButNeverLeavesTheTownsBoundingBox() {
		// corner-cutting can only ever pull a line inward (Chaikin is a convex combination), so a
		// smoothed street cannot bulge out over the water the mesh carefully worked around
		Founded f = found();
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());
		int x0 = Integer.MAX_VALUE, y0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE,
				y1 = Integer.MIN_VALUE;
		for (Cell c : fp.allCells()) {
			x0 = Math.min(x0, c.x());
			y0 = Math.min(y0, c.y());
			x1 = Math.max(x1, c.x() + 1);
			y1 = Math.max(y1, c.y() + 1);
		}
		for (Street s : streetsOf(f).streets()) {
			for (var p : s.points()) {
				assertTrue(p.x() >= x0 - 1e-9 && p.x() <= x1 + 1e-9, "x in the town: " + p);
				assertTrue(p.y() >= y0 - 1e-9 && p.y() <= y1 + 1e-9, "y in the town: " + p);
			}
		}
	}

	@Test
	void theRiverTestIsSymmetricSoACrossingCostsTheSameBothWays() {
		// riverAdj records which neighbours the river on THIS plot runs on to, so a channel may be
		// recorded on either bank. Asking only the plot being left would make a crossing free one way
		// and a bridge the other — and A* finds that kind of asymmetry every single time.
		Founded f = found();
		ProvincePlotPool pool = f.pool();
		TownStreets.Terrain terrain = ColonyStreets.terrain(pool);
		int checked = 0;
		for (Plot p : pool.plots()) {
			Cell a = new Cell(p.x(), p.y());
			for (Cell b : List.of(new Cell(a.x() + 1, a.y()), new Cell(a.x(), a.y() + 1))) {
				assertEquals(terrain.river(a, b), terrain.river(b, a),
						"the same channel, whichever bank you stand on: " + a + " " + b);
				checked++;
			}
		}
		assertTrue(checked > 0);
	}

	@Test
	void aColonyStandingOnNothingGetsNoStreets() {
		Founded f = found();
		assertEquals(TownStreets.NONE, ColonyStreets.of(f.colony(), f.pool(),
				f.session().getWorldMap(), Footprint.EMPTY, TownMesh.EMPTY, TownWall.NONE));
	}

	@Test
	void aBranchIsMarkedAsOneAndAnArteryAsAnArtery() {
		TownStreets streets = streetsOf(found());
		for (Street s : streets.streets()) {
			assertNotEquals(null, s.kind());
		}
		assertEquals(streets.streets().stream().filter(s -> s.kind() == Kind.MAIN).count(),
				streets.diag().arteries());
	}

	private static List<List<Cell>> paths(TownStreets streets) {
		return streets.streets().stream().map(Street::cells).toList();
	}
}
