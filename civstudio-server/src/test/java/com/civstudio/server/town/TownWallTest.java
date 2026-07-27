package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

import org.junit.jupiter.api.Test;

import com.civstudio.server.town.TownWall.Bearing;
import com.civstudio.server.town.TownWall.EdgeInfo;
import com.civstudio.server.town.TownWall.Gate;
import com.civstudio.server.town.TownWall.Kind;
import com.civstudio.server.town.TownWall.Segment;
import com.civstudio.server.town.TownWall.Side;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Pt;

/**
 * Fortification ({@code docs/towngen-port.md} T4): a wall is a property of individual plots, one
 * piece per outward edge, and what kind of piece depends on what lies beyond it.
 */
class TownWallTest {

	private static final Predicate<Cell> ALL_LAND = c -> true;
	private static final EdgeInfo DRY = (cell, side) -> false;

	private static Set<Cell> block(int x0, int y0, int w, int h) {
		Set<Cell> out = new LinkedHashSet<>();
		for (int y = y0; y < y0 + h; y++) {
			for (int x = x0; x < x0 + w; x++) {
				out.add(new Cell(x, y));
			}
		}
		return out;
	}

	private static Footprint town(int w, int h) {
		return Footprint.of(block(0, 0, w, h), ALL_LAND);
	}

	private static TownWall wall(Footprint fp, EdgeInfo edges, List<Bearing> bearings) {
		return TownWall.of(fp, true, 0, new Pt(fp.size() / 2.0, fp.size() / 2.0), edges, bearings);
	}

	@Test
	void everyOutwardEdgeOfEveryBorderPlotIsFortified() {
		// a 3x3 town has eight border plots and twelve outward edges; the middle plot has none
		TownWall w = wall(town(3, 3), DRY, List.of());
		assertTrue(w.walled());
		assertEquals(12, w.segments().size());
		assertTrue(w.segmentsOf(new Cell(1, 1)).isEmpty(), "the interior plot carries no wall");
		assertEquals(2, w.segmentsOf(new Cell(0, 0)).size(), "a corner plot carries two pieces");
		assertEquals(1, w.segmentsOf(new Cell(1, 0)).size(), "an edge plot carries one");
		for (Segment s : w.segments()) {
			assertEquals(Kind.CURTAIN, s.kind(), "dry ground all round, so it is all curtain");
			assertEquals(1.0, s.a().dist(s.b()), 1e-9, "a segment spans exactly one plot edge");
		}
	}

	@Test
	void aCoastalEdgeIsQuayAndTheRestIsStillWall() {
		// the plots' own coast mask decides: the east side of this town is shore
		EdgeInfo shore = (cell, side) -> side == Side.E && cell.x() == 2;
		TownWall w = wall(town(3, 3), shore, List.of());
		int quay = 0;
		for (Segment s : w.segments()) {
			if (s.kind() == Kind.QUAY) {
				quay++;
				assertEquals(Side.E, s.side());
				assertEquals(2, s.cell().x());
			}
		}
		assertEquals(3, quay, "three plots front the water");
		assertEquals(9, w.segments().size() - quay, "and the landward line is unaffected");
	}

	@Test
	void aRiverLeavingTownGetsAWaterGate() {
		EdgeInfo river = new EdgeInfo() {

			@Override
			public boolean water(Cell cell, Side side) {
				return false;
			}

			@Override
			public boolean river(Cell cell, Side side) {
				return cell.equals(new Cell(1, 0)) && side == Side.N;
			}
		};
		TownWall w = wall(town(3, 3), river, List.of());
		List<Segment> at = w.segmentsOf(new Cell(1, 0));
		assertEquals(1, at.size());
		assertEquals(Kind.RIVER_GATE, at.get(0).kind(), "the water gets through whatever we build");
		assertTrue(at.get(0).kind().isGate());
	}

	@Test
	void riverBeatsShoreWhereBothApply() {
		// a river mouth is both: it is a way through, and that is the load-bearing fact
		EdgeInfo both = new EdgeInfo() {

			@Override
			public boolean water(Cell cell, Side side) {
				return true;
			}

			@Override
			public boolean river(Cell cell, Side side) {
				return cell.equals(new Cell(0, 1)) && side == Side.W;
			}
		};
		TownWall w = wall(town(3, 3), both, List.of());
		assertEquals(Kind.RIVER_GATE, w.segmentsOf(new Cell(0, 1)).get(0).kind());
	}

	@Test
	void gatesFaceTheRoadsThatActuallyLeaveTown() {
		// bearings are in raster space, where y grows downward: 0 = east, π/2 = south
		TownWall w = TownWall.of(town(5, 5), true, 0, new Pt(2.5, 2.5), DRY,
				List.of(new Bearing(0, "East March"), new Bearing(Math.PI, "West March")));
		assertEquals(2, w.gates().size());
		Gate east = w.gates().get(0);
		assertEquals("East March", east.toward());
		assertEquals(Side.E, east.segment().side());
		assertEquals(4, east.segment().cell().x(), "on the eastern face of town");
		assertEquals(Side.W, w.gates().get(1).segment().side());
		assertEquals(0, w.gates().get(1).segment().cell().x());
	}

	@Test
	void twoRoadsLeavingTheSameWayShareOneGate() {
		// §5.4: without a separation rule a polyomino outline turns into a wall of mostly gates
		TownWall w = TownWall.of(town(5, 5), true, 0, new Pt(2.5, 2.5), DRY,
				List.of(new Bearing(0, "Near"), new Bearing(0.1, "AlsoEast"),
						new Bearing(Math.PI / 2, "South")));
		assertEquals(2, w.gates().size(), "the near-collinear second road gets no gate of its own");
		assertEquals("Near", w.gates().get(0).toward());
		assertEquals("South", w.gates().get(1).toward());
	}

	@Test
	void aGateIsNeverPutInAQuay() {
		// a road does not leave over water; that is a harbour, and its own problem
		EdgeInfo allShore = (cell, side) -> true;
		TownWall w = TownWall.of(town(4, 4), true, 0, new Pt(2, 2), allShore,
				List.of(new Bearing(0, "East March")));
		assertTrue(w.gates().isEmpty());
		for (Segment s : w.segments()) {
			assertEquals(Kind.QUAY, s.kind());
		}
	}

	@Test
	void anImpermanentOrTinySettlementIsNotWalled() {
		assertFalse(TownWall.of(town(3, 3), false, 0, new Pt(1, 1), DRY, List.of()).walled(),
				"below TOWN there is no wall at all");
		assertFalse(TownWall.of(town(3, 1), true, 0, new Pt(1, 0), DRY, List.of()).walled(),
				"and a three-plot town has nothing worth enclosing (§5.3)");
		assertTrue(TownWall.of(town(2, 2), true, 0, new Pt(1, 1), DRY, List.of()).walled(),
				"four plots is the floor");
	}

	@Test
	void theWalledCoreIsCappedAndTheRestIsExtramural() {
		// §2b: one of the ~62 all-urban provinces must not wall a town several times any other's
		Footprint big = town(8, 8);
		TownWall w = TownWall.of(big, true, 16, new Pt(4, 4), DRY, List.of());
		assertEquals(16, w.core().size(), "the wall encloses the cap, not the whole footprint");
		assertEquals(64, big.size(), "while the town still stands on all of it");
		assertTrue(w.encloses(new Cell(4, 4)), "the centre is inside");
		assertFalse(w.encloses(new Cell(0, 0)), "the far corner is a suburb");
	}

	@Test
	void aSeveredLimbFallsOutsideTheWallRatherThanBreakingIt() {
		// taking the nearest N plots can cut a limb off the body; the wall encloses what survives
		// as one piece, because a wall cannot wrap two
		Set<Cell> cells = new LinkedHashSet<>(block(0, 0, 3, 3));
		cells.addAll(block(3, 1, 6, 1));            // a long arm reaching east
		Footprint fp = Footprint.of(cells, ALL_LAND);
		TownWall w = TownWall.of(fp, true, 9, new Pt(1.5, 1.5), DRY, List.of());
		assertEquals(1, Footprint.components(new LinkedHashSet<>(w.core())).size(),
				"the core is one connected piece");
		assertTrue(w.core().size() <= 9);
	}

	@Test
	void theCoreIsTheWholeBodyWhenUncapped() {
		TownWall w = TownWall.of(town(4, 4), true, 0, new Pt(2, 2), DRY, List.of());
		assertEquals(16, w.core().size());
	}

	@Test
	void fortificationIsDeterministic() {
		Footprint fp = town(5, 5);
		List<Bearing> b = List.of(new Bearing(0.4, "A"), new Bearing(2.9, "B"));
		assertEquals(TownWall.of(fp, true, 12, new Pt(2.5, 2.5), DRY, b).segments(),
				TownWall.of(fp, true, 12, new Pt(2.5, 2.5), DRY, b).segments());
	}
}
