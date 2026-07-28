package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

import org.junit.jupiter.api.Test;

import com.civstudio.server.town.TownStreets.Kind;
import com.civstudio.server.town.TownStreets.Street;
import com.civstudio.server.town.TownStreets.Terrain;
import com.civstudio.server.town.TownWall.Bearing;
import com.civstudio.server.town.TownWall.EdgeInfo;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Pt;

/**
 * The streets ({@code docs/towngen-port.md} T5): a network that comes in at the gates, contours
 * around what it would rather not climb, bridges what it must, and meets itself at a crossroads
 * instead of laying two roads down the same plots.
 */
class TownStreetsTest {

	private static final Predicate<Cell> ALL_LAND = c -> true;
	private static final EdgeInfo DRY = (cell, side) -> false;
	private static final Terrain FLAT = new Terrain() {
	};

	private static final long SEED = TownRng.siteSeed(7654321L, 451);

	private static Set<Cell> block(int x0, int y0, int w, int h) {
		Set<Cell> out = new LinkedHashSet<>();
		for (int y = y0; y < y0 + h; y++) {
			for (int x = x0; x < x0 + w; x++) {
				out.add(new Cell(x, y));
			}
		}
		return out;
	}

	private static Footprint town(Set<Cell> cells) {
		return Footprint.of(cells, ALL_LAND);
	}

	private static TownStreets lay(Footprint fp, TownWall wall, Cell centre, Terrain terrain,
			List<Bearing> bearings) {
		return TownStreets.of(fp, TownMesh.of(fp, SEED), wall, centre, terrain, bearings);
	}

	/** The T-shaped town two roads have to share the stem of. */
	private static Set<Cell> teeTown() {
		Set<Cell> cells = new LinkedHashSet<>(block(0, 0, 5, 1));
		cells.add(new Cell(2, 1));
		cells.add(new Cell(2, 2));
		return cells;
	}

	private static final Bearing EAST = new Bearing(0, "Eastmarch");
	private static final Bearing WEST = new Bearing(Math.PI, "Westmarch");

	// --- the network ------------------------------------------------------------------------

	@Test
	void aRoadComesInAtEveryGateAndRunsToTheCentre() {
		Footprint fp = town(block(0, 0, 5, 5));
		Cell centre = new Cell(2, 2);
		TownWall wall = TownWall.of(fp, true, 0, centre.centre(), DRY, List.of(EAST, WEST));
		TownStreets streets = lay(fp, wall, centre, FLAT, List.of(EAST, WEST));

		assertTrue(streets.streets().size() >= 2);
		for (Street s : streets.streets()) {
			assertTrue(s.points().size() >= 2, "a street is a line, not a point");
			assertTrue(streets.streetCells().contains(centre), "the network reaches the centre");
		}
		Set<String> named = new HashSet<>(streets.streets().stream().map(Street::toward).toList());
		assertTrue(named.containsAll(Set.of("Eastmarch", "Westmarch")),
				"each gate's street knows what lies out through it: " + named);
	}

	@Test
	void aWalledTownWhoseWallIsAllQuayStillGetsAStreetNetwork() {
		// NATHALAIRE'S CASE, in miniature. A gate goes only in a curtain segment, so a town whose
		// line is water all round gets none at all — and a city with no streets is a worse answer
		// than a city whose streets come in off its landings.
		Footprint fp = town(block(0, 0, 5, 5));
		Cell centre = new Cell(2, 2);
		EdgeInfo allWater = (cell, side) -> true;
		TownWall wall = TownWall.of(fp, true, 0, centre.centre(), allWater, List.of(EAST, WEST));
		assertTrue(wall.walled());
		assertTrue(wall.gates().isEmpty(), "no curtain, so no gate");

		TownStreets streets = lay(fp, wall, centre, FLAT, List.of());
		assertTrue(streets.streets().size() >= 2, "a network, not one road: " + streets.diag());
		assertTrue(streets.streets().size() <= TownStreets.WAYS_IN);
		assertTrue(streets.streetCells().contains(centre));
	}

	@Test
	void theSecondRoadJoinsTheFirstInsteadOfRunningBesideIt() {
		// THE REUSE DISCOUNT, and the whole reason a town has a high street. Both roads must use the
		// stem of the T; the second stops where it meets the first rather than repeating it.
		Cell centre = new Cell(2, 2);
		Footprint fp = town(teeTown());
		TownStreets streets = lay(fp, TownWall.NONE, centre, FLAT, List.of(EAST, WEST));

		assertEquals(2, streets.streets().size());
		assertEquals(1, streets.diag().arteries(), "exactly one road reached the centre");
		assertEquals(1, streets.diag().junctions(), "and the other met it at one crossroads");

		Street branch = streets.streets().stream().filter(s -> s.kind() == Kind.STREET).findFirst()
				.orElseThrow();
		assertEquals(new Cell(2, 0), branch.cells().get(branch.cells().size() - 1),
				"the branch ends at the junction, not past it");
		assertFalse(branch.cells().contains(centre), "and never reaches the centre itself");
	}

	@Test
	void noPlotEdgeIsPavedTwice() {
		// the network is a tree: drawing it can never double the ink on any one stretch
		Footprint fp = town(block(0, 0, 6, 6));
		Cell centre = new Cell(3, 3);
		List<Bearing> around = List.of(EAST, WEST, new Bearing(Math.PI / 2, "South"),
				new Bearing(-Math.PI / 2, "North"));
		TownWall wall = TownWall.of(fp, true, 0, centre.centre(), DRY, around);
		TownStreets streets = lay(fp, wall, centre, FLAT, around);

		Set<String> links = new HashSet<>();
		for (Street s : streets.streets()) {
			for (int i = 0; i + 1 < s.cells().size(); i++) {
				Cell a = s.cells().get(i);
				Cell b = s.cells().get(i + 1);
				String key = a.y() < b.y() || (a.y() == b.y() && a.x() <= b.x())
						? a + "|" + b : b + "|" + a;
				assertTrue(links.add(key), "this stretch is only paved once: " + key);
			}
		}
		assertTrue(streets.streets().size() >= 2, "several roads were actually laid");
	}

	// --- the weight function ----------------------------------------------------------------

	@Test
	void aStreetContoursAroundAHillRatherThanClimbingIt() {
		// THE SLOPE TERM, which the plan calls most of what separates a plausible town map from a
		// convincing one. The direct line runs over a ridge; the street goes round the end of it.
		Footprint fp = town(block(0, 0, 5, 3));
		Cell centre = new Cell(0, 1);
		Cell ridge = new Cell(2, 1);
		Terrain hill = new Terrain() {

			@Override
			public int elevation(Cell cell) {
				return cell.equals(ridge) ? 200 : 0;
			}
		};

		TownStreets flat = lay(fp, TownWall.NONE, centre, FLAT, List.of(EAST));
		TownStreets hilly = lay(fp, TownWall.NONE, centre, hill, List.of(EAST));

		assertTrue(flat.streets().get(0).cells().contains(ridge),
				"on flat ground the road runs straight along the row");
		assertFalse(hilly.streets().get(0).cells().contains(ridge),
				"with the ridge there it goes round");
		assertNotEquals(flat.streets().get(0).cells(), hilly.streets().get(0).cells());
	}

	@Test
	void aStreetPaysToCrossARiverAndPrefersAnEasierCrossing() {
		// the water term of the same one weight function: the river cuts the middle column, except
		// at the top row, so the road detours to the ford instead of bridging in front of the gate
		Footprint fp = town(block(0, 0, 5, 3));
		Cell centre = new Cell(0, 1);
		Terrain river = new Terrain() {

			@Override
			public boolean river(Cell from, Cell to) {
				// the channel runs down the line x=1.5, open only at y=0
				int lo = Math.min(from.x(), to.x());
				return from.y() == to.y() && from.y() > 0 && lo == 1;
			}
		};
		TownStreets streets = lay(fp, TownWall.NONE, centre, river, List.of(EAST));

		Street s = streets.streets().get(0);
		assertTrue(s.cells().contains(new Cell(1, 0)) && s.cells().contains(new Cell(2, 0)),
				"the road used the one crossing that costs nothing: " + s.cells());
		assertEquals(0, streets.diag().bridges(), "so it built no bridge");
	}

	@Test
	void aTownOnBothBanksBridgesRatherThanGivingUp() {
		// BRIDGE_COST is a price, not a wall. With no ford anywhere the road pays once and crosses.
		Footprint fp = town(block(0, 0, 5, 3));
		Cell centre = new Cell(0, 1);
		Terrain river = new Terrain() {

			@Override
			public boolean river(Cell from, Cell to) {
				return from.y() == to.y() && Math.min(from.x(), to.x()) == 1;
			}
		};
		TownStreets streets = lay(fp, TownWall.NONE, centre, river, List.of(EAST));

		assertEquals(1, streets.diag().bridges(), "it crossed the channel exactly once");
		assertEquals(1, streets.streets().get(0).crossings());
		// T4b: a bridge is a PLACE, and it is exactly the shared edge midpoint of the two plots the
		// street steps between — which is also where the river's own centre-line crosses that edge,
		// so it lands on the channel without any intersection arithmetic
		assertEquals(new Pt(2.0, 1.5), streets.streets().get(0).bridges().get(0));
		assertTrue(streets.diag().interesting(), "a bridge is worth a log line");
	}

	// --- where the roads come in ------------------------------------------------------------

	@Test
	void anUnwalledTownStillGetsLanes() {
		// §5.3 leaves a hamlet unwalled, but a hamlet still has roads: with no gates they radiate
		// from the centre to the footprint edge, aimed at the same neighbours a gate would have been
		Footprint fp = town(block(0, 0, 4, 4));
		TownStreets streets = lay(fp, TownWall.NONE, new Cell(1, 1), FLAT, List.of(EAST, WEST));
		assertEquals(2, streets.streets().size(),
				"the lanes its neighbours give it, and no invented extras — that is a town's luxury");
		assertTrue(streets.streets().stream().anyMatch(s -> "Eastmarch".equals(s.toward())));
	}

	@Test
	void aTownNobodyCrossesTheBorderOfInventsItsOwnRoads() {
		// no recorded crossings at all — the lanes aim at the town's own far corners instead of
		// nothing, and they are chosen deterministically so they do not move between generations
		Footprint fp = town(block(0, 0, 5, 5));
		TownStreets a = lay(fp, TownWall.NONE, new Cell(2, 2), FLAT, List.of());
		TownStreets b = lay(fp, TownWall.NONE, new Cell(2, 2), FLAT, List.of());

		assertFalse(a.isEmpty(), "it laid something");
		assertTrue(a.streets().size() <= TownStreets.WAYS_IN);
		assertEquals(cellPaths(a), cellPaths(b), "the same town twice is the same town");
		for (Street s : a.streets()) {
			assertEquals(null, s.toward(), "an invented road faces nowhere in particular");
		}
	}

	@Test
	void gatesAreWhereTheRoadsComeInWhenThereIsAWall() {
		Footprint fp = town(block(0, 0, 5, 5));
		Cell centre = new Cell(2, 2);
		TownWall wall = TownWall.of(fp, true, 0, centre.centre(), DRY, List.of(EAST));
		assertEquals(1, wall.gates().size());

		TownStreets streets = lay(fp, wall, centre, FLAT, List.of(EAST));
		Pt gate = wall.gates().get(0).segment().mid();
		assertEquals(gate, streets.streets().get(0).points().get(0),
				"the road starts in the gateway itself, exactly");
	}

	// --- what is drawn ----------------------------------------------------------------------

	@Test
	void theDrawnLineRunsThroughTheJitteredSeedsNotThePlotCentres() {
		// this is where the streets get their wander: the mesh already moved every seed off its plot
		// centre, and the road follows the seeds
		Footprint fp = town(block(0, 0, 5, 3));
		Cell centre = new Cell(0, 1);
		TownMesh mesh = TownMesh.of(fp, SEED);
		Map<Cell, TownMesh.Patch> patches = mesh.byCell();
		TownStreets streets = TownStreets.of(fp, mesh, TownWall.NONE, centre, FLAT, List.of(EAST));

		Street s = streets.streets().get(0);
		boolean offCentre = false;
		for (Cell c : s.cells()) {
			if (patches.get(c).seed().dist(c.centre()) > 1e-6) {
				offCentre = true;
			}
		}
		assertTrue(offCentre, "the seeds this road follows are genuinely jittered");
		assertTrue(s.points().size() > s.cells().size(),
				"and the line was corner-cut, so it has more points than plots");
	}

	@Test
	void aJunctionIsOnePointBothStreetsShare() {
		// the pinning rule of Polyline, seen end to end: smoothing must not part the branch from the
		// street it ends on, or every crossroads draws a gap
		Cell centre = new Cell(2, 2);
		Footprint fp = town(teeTown());
		TownStreets streets = lay(fp, TownWall.NONE, centre, FLAT, List.of(EAST, WEST));

		Street artery = streets.streets().stream().filter(s -> s.kind() == Kind.MAIN).findFirst()
				.orElseThrow();
		Street branch = streets.streets().stream().filter(s -> s.kind() == Kind.STREET).findFirst()
				.orElseThrow();
		Pt end = branch.points().get(branch.points().size() - 1);
		assertTrue(artery.points().contains(end),
				"the branch's last point lies on the artery, to the bit");
	}

	// --- totality ---------------------------------------------------------------------------

	@Test
	void nothingToRouteIsAnAnswerNotAFailure() {
		assertSame(TownStreets.NONE, TownStreets.of(Footprint.EMPTY, TownMesh.EMPTY, TownWall.NONE,
				new Cell(0, 0), FLAT, List.of(EAST)));
		Footprint one = town(Set.of(new Cell(0, 0)));
		assertSame(TownStreets.NONE,
				TownStreets.of(one, TownMesh.of(one, SEED), TownWall.NONE, new Cell(0, 0), FLAT,
						List.of(EAST)),
				"a single-plot town has nowhere to lay a street");
		Footprint fp = town(block(0, 0, 3, 3));
		assertSame(TownStreets.NONE, lay(fp, TownWall.NONE, null, FLAT, List.of(EAST)));
		assertSame(TownStreets.NONE, lay(fp, TownWall.NONE, new Cell(9, 9), FLAT, List.of(EAST)),
				"a centre outside the town is not a centre");
	}

	@Test
	void anExtramuralClusterIsUnreachableAndThatIsFine() {
		// §2b's suburbs are disconnected from the body by definition, so a road aimed at one cannot
		// arrive. It is counted, not thrown — T6's gate clustering is what gives a suburb its lanes.
		Set<Cell> cells = new LinkedHashSet<>(block(0, 0, 3, 3));
		cells.addAll(block(6, 0, 2, 2));                 // an island of built ground, four plots off
		Footprint fp = town(cells);
		assertEquals(4, fp.outliers().size());

		TownStreets streets = lay(fp, TownWall.NONE, new Cell(1, 1), FLAT,
				List.of(EAST, WEST, new Bearing(Math.PI / 2, "South")));
		assertTrue(streets.diag().unreachable() >= 0);
		for (Street s : streets.streets()) {
			for (Cell c : s.cells()) {
				assertTrue(fp.cellSet().contains(c), "no street strays into the suburb: " + c);
			}
		}
	}

	private static List<List<Cell>> cellPaths(TownStreets streets) {
		List<List<Cell>> out = new ArrayList<>();
		for (Street s : streets.streets()) {
			out.add(s.cells());
		}
		return out;
	}
}
