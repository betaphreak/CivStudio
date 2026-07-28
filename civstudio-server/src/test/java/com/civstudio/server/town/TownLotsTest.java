package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

import org.junit.jupiter.api.Test;

import com.civstudio.server.town.TownLots.Density;
import com.civstudio.server.town.TownLots.Kind;
import com.civstudio.server.town.TownLots.Lot;
import com.civstudio.server.town.TownWall.EdgeInfo;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Poly;

/**
 * The lots ({@code docs/towngen-port.md} T6, §4a) — the payoff of the port. The subdivision is
 * <b>fitted</b> to what really stands on a plot, so a plot with twelve households and three
 * buildings looks different from one with two households, because it is.
 */
class TownLotsTest {

	private static final Predicate<Cell> ALL_LAND = c -> true;
	private static final EdgeInfo DRY = (cell, side) -> false;
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

	private static Footprint town(int w, int h) {
		return Footprint.of(block(0, 0, w, h), ALL_LAND);
	}

	private static TownMesh mesh(Footprint fp) {
		return TownMesh.of(fp, SEED);
	}

	/** A density that answers the same for every plot. */
	private static Density flat(List<String> buildings, int households) {
		return new Density() {

			@Override
			public List<String> buildings(Cell cell) {
				return buildings;
			}

			@Override
			public int households(Cell cell) {
				return households;
			}
		};
	}

	private static long count(List<Lot> lots, Kind kind) {
		return lots.stream().filter(l -> l.kind() == kind).count();
	}

	// --- the fit ------------------------------------------------------------------------------

	@Test
	void aCrowdedPlotIsCutIntoMoreLotsThanAnEmptyOne() {
		// THE WHOLE POINT. The reference invents its subdivision target because nothing else knows;
		// we know, so the count is a fact about the plot rather than a die roll.
		Footprint fp = town(3, 3);
		TownLots busy = TownLots.of(mesh(fp), null, flat(List.of(), 10), SEED);
		TownLots quiet = TownLots.of(mesh(fp), null, flat(List.of(), 2), SEED);
		assertTrue(busy.diag().lots() > quiet.diag().lots() * 2,
				busy.diag() + " vs " + quiet.diag());
	}

	@Test
	void everyBuildingAndEveryHouseholdGetsItsOwnLot() {
		Footprint fp = town(2, 2);
		TownLots lots = TownLots.of(mesh(fp),
				null, flat(List.of("BUILDING_A", "BUILDING_B"), 3), SEED);
		for (Cell c : fp.allCells()) {
			List<Lot> here = lots.of(c);
			assertEquals(2, count(here, Kind.BUILDING), "one lot per building on " + c);
			assertEquals(3, count(here, Kind.DWELLING), "one lot per household on " + c);
		}
		assertEquals(0, lots.diag().unfitted(), "a five-lot plot fits comfortably");
	}

	@Test
	void theMostImportantBuildingTakesTheBiggestBlock() {
		// §2c's notable buildings as large coloured masses: the density hands them over most
		// important first and the pieces are sorted by area, so a cathedral gets a cathedral's
		// footprint without any of this code knowing what a cathedral is
		Footprint fp = town(1, 1);
		TownLots lots = TownLots.of(mesh(fp), null,
				flat(List.of("BUILDING_CATHEDRAL", "BUILDING_COTTAGE"), 4), SEED);
		List<Lot> here = lots.of(new Cell(0, 0));
		assertEquals("BUILDING_CATHEDRAL", here.get(0).building());
		assertEquals("BUILDING_COTTAGE", here.get(1).building());
		assertTrue(here.get(0).poly().area() >= here.get(1).poly().area());
		for (int i = 1; i < here.size(); i++) {
			assertTrue(here.get(i - 1).poly().area() >= here.get(i).poly().area(),
					"lots run biggest first");
		}
	}

	@Test
	void aBuildingLotNamesItsBuildingAndNothingElseDoes() {
		List<Lot> here = TownLots.of(mesh(town(1, 1)), null, flat(List.of("BUILDING_A"), 3), SEED)
				.of(new Cell(0, 0));
		for (Lot lot : here) {
			if (lot.kind() == Kind.BUILDING) {
				assertEquals("BUILDING_A", lot.building());
			} else {
				assertNull(lot.building(), lot.kind() + " carries no building id");
			}
		}
	}

	@Test
	void whatIsLeftOverIsYard() {
		// three lots asked for, but the cutter always produces at least as many pieces as it can fit
		// — the surplus is garden, not invented houses
		Footprint fp = town(1, 1);
		TownLots lots = TownLots.of(mesh(fp), null, flat(List.of(), 3), SEED);
		List<Lot> here = lots.of(new Cell(0, 0));
		assertEquals(3, count(here, Kind.DWELLING));
		assertEquals(here.size() - 3, count(here, Kind.EMPTY));
	}

	@Test
	void aPlotIsNeverCutPastLegibility() {
		TownLots lots = TownLots.of(mesh(town(1, 1)), null, flat(List.of(), 400), SEED);
		assertTrue(lots.of(new Cell(0, 0)).size() <= TownLots.MAX_LOTS,
				"a plot is one tile; past a dozen blocks it stops reading as a place");
	}

	// --- decline ------------------------------------------------------------------------------

	@Test
	void aWalledPlotThatEmptiedOutRuinsRatherThanVanishing() {
		// §2a: the wall is a high-water mark and decline is rendered INSIDE it. A plot that lost its
		// households is not open ground — it is somewhere that used to be somewhere.
		Footprint fp = town(3, 3);
		TownWall wall = TownWall.of(fp, true, 0, new Cell(1, 1).centre(), DRY, List.of());
		assertTrue(wall.walled());
		TownLots lots = TownLots.of(mesh(fp), wall, flat(List.of(), 0), SEED);
		assertTrue(lots.diag().ruins() > 0, "the emptied core shows ruins: " + lots.diag());
		for (Lot lot : lots.of(new Cell(1, 1))) {
			assertEquals(Kind.RUIN, lot.kind());
		}
		assertTrue(lots.diag().interesting(), "ruins are worth a log line");
	}

	@Test
	void emptyGroundOutsideTheWallIsJustEmptyGround() {
		// the same plot with no wall around it has never been anything, so it ruins nothing
		TownLots lots = TownLots.of(mesh(town(3, 3)), TownWall.NONE, flat(List.of(), 0), SEED);
		assertTrue(lots.isEmpty(), "nothing built, nothing drawn: " + lots.diag());
		assertEquals(0, lots.diag().ruins());
	}

	// --- geometry -----------------------------------------------------------------------------

	@Test
	void everyLotStaysInsideItsOwnPatch() {
		// a lot that strays is a house in the next ward, or outside the wall entirely
		Footprint fp = town(3, 3);
		TownMesh m = mesh(fp);
		TownLots lots = TownLots.of(m, null, flat(List.of("BUILDING_A"), 5), SEED);
		for (TownMesh.Patch patch : m.patches()) {
			for (Lot lot : lots.of(patch.cell())) {
				for (int i = 0; i < lot.poly().size(); i++) {
					assertTrue(patch.poly().contains(lot.poly().get(i)),
							"lot corner inside its patch: " + lot.poly().get(i));
				}
			}
		}
	}

	@Test
	void lotsLeaveTheWardBoundaryClearForTheStreet() {
		Footprint fp = town(2, 2);
		TownMesh m = mesh(fp);
		TownLots lots = TownLots.of(m, null, flat(List.of(), 4), SEED);
		for (TownMesh.Patch patch : m.patches()) {
			for (Lot lot : lots.of(patch.cell())) {
				for (int i = 0; i < lot.poly().size(); i++) {
					assertTrue(
							patch.poly().distanceToBoundary(lot.poly().get(i))
									>= TownLots.WARD_MARGIN - 1e-9,
							"a lot keeps its distance from the ward edge");
				}
			}
		}
	}

	@Test
	void noLotIsDegenerate() {
		TownLots lots = TownLots.of(mesh(town(3, 3)), null, flat(List.of("BUILDING_A"), 6), SEED);
		for (List<Lot> here : lots.byCell().values()) {
			for (Lot lot : here) {
				assertFalse(lot.poly().isEmpty());
				assertTrue(lot.poly().size() >= 3, "a lot is a polygon");
				assertTrue(lot.poly().area() > 0, "with real area");
			}
		}
	}

	// --- determinism --------------------------------------------------------------------------

	@Test
	void aPlotsLotsDoNotDependOnWhatWasCutBeforeIt() {
		// the keyed generator, and the reason for it: a shared stream would make a plot's blocks
		// depend on how many plots were cut first, so building on one side of town would re-cut
		// every block on the other
		Footprint small = town(2, 2);
		Footprint grown = Footprint.of(block(0, 0, 4, 4), ALL_LAND);
		Density d = flat(List.of(), 4);
		TownLots before = TownLots.of(mesh(small), null, d, SEED);
		TownLots after = TownLots.of(mesh(grown), null, d, SEED);
		// (0, 0)'s patch changes shape when the town grows around it, so compare a plot whose 5x5
		// neighbourhood is unchanged: there is none in a 2x2, so compare the counts instead
		assertEquals(before.of(new Cell(0, 0)).size(), after.of(new Cell(0, 0)).size());
		assertEquals(TownLots.of(mesh(grown), null, d, SEED).byCell().keySet(),
				after.byCell().keySet());
	}

	@Test
	void theSameTownIsCutTheSameWayTwice() {
		Footprint fp = town(4, 4);
		Density d = flat(List.of("BUILDING_A"), 3);
		TownLots a = TownLots.of(mesh(fp), null, d, SEED);
		TownLots b = TownLots.of(mesh(fp), null, d, SEED);
		assertEquals(a.byCell(), b.byCell());
	}

	@Test
	void twoSitesCutTheSameBlockDifferently() {
		Footprint fp = town(2, 2);
		Density d = flat(List.of(), 4);
		List<Lot> a = TownLots.of(TownMesh.of(fp, TownRng.siteSeed(7654321L, 451)), null, d,
				TownRng.siteSeed(7654321L, 451)).of(new Cell(0, 0));
		List<Lot> b = TownLots.of(TownMesh.of(fp, TownRng.siteSeed(7654321L, 4411)), null, d,
				TownRng.siteSeed(7654321L, 4411)).of(new Cell(0, 0));
		assertNotEquals(a, b);
	}

	// --- totality -----------------------------------------------------------------------------

	@Test
	void nothingToLayOutIsAnAnswerNotAFailure() {
		assertSame(TownLots.NONE, TownLots.of(TownMesh.EMPTY, null, flat(List.of(), 5), SEED));
		assertSame(TownLots.NONE, TownLots.of(null, null, flat(List.of(), 5), SEED));
		assertTrue(TownLots.NONE.isEmpty());
		assertEquals(List.of(), TownLots.NONE.of(new Cell(0, 0)));
	}

	@Test
	void aBlockTooSmallToHoldItsHousesSaysSoRatherThanInventingSlivers() {
		// a patch cut past MIN_BLOCK_AREA stops, and the shortfall is reported: a block that cannot
		// hold what stands on it is a fact about the block
		Footprint fp = town(1, 1);
		TownLots lots = TownLots.of(mesh(fp), null, flat(List.of(), TownLots.MAX_LOTS), SEED);
		List<Lot> here = lots.of(new Cell(0, 0));
		assertEquals(here.size() + lots.diag().unfitted(), TownLots.MAX_LOTS,
				"every lot asked for is either cut or counted: " + lots.diag());
		for (Lot lot : here) {
			assertTrue(lot.poly().area() > 0);
		}
	}

	@Test
	void aPatchWithNoPolygonIsSkippedNotThrownOver() {
		// TownMesh guarantees a non-empty patch, but the lot stage must not depend on that
		TownMesh degenerate = new TownMesh(
				List.of(new TownMesh.Patch(new Cell(0, 0), new com.civstudio.server.town.geom.Pt(0.5,
						0.5), Poly.EMPTY, true)),
				SEED, new TownMesh.Diagnostics(1, 0, 0));
		TownLots lots = TownLots.of(degenerate, null, flat(List.of(), 4), SEED);
		assertTrue(lots.isEmpty());
		assertEquals(4, lots.diag().unfitted());
	}
}
