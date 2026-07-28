package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

import org.junit.jupiter.api.Test;

import com.civstudio.server.town.TownWards.Site;
import com.civstudio.server.town.TownWall.Bearing;
import com.civstudio.server.town.TownWall.EdgeInfo;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.DistrictType;

/**
 * The wards ({@code docs/towngen-port.md} T6, §4): a patch is a plot, so the ward drawn on it is
 * the plot's own district — the sim's answer where the sim has one, and a location score where it
 * has not.
 */
class TownWardsTest {

	private static final Predicate<Cell> ALL_LAND = c -> true;
	private static final EdgeInfo DRY = (cell, side) -> false;
	private static final Site BARE = new Site() {
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

	private static Footprint town(int w, int h) {
		return Footprint.of(block(0, 0, w, h), ALL_LAND);
	}

	private static TownWards wards(Footprint fp, Cell centre, Site site) {
		TownWall wall = TownWall.of(fp, true, 0, centre.centre(), DRY,
				List.of(new Bearing(0, "Eastmarch")));
		TownStreets streets = TownStreets.of(fp, TownMesh.of(fp, SEED), wall, centre, new TownStreets.Terrain() {
		}, List.of(new Bearing(0, "Eastmarch")));
		return TownWards.of(fp, wall, streets, centre, site, SEED);
	}

	// --- the bijection ------------------------------------------------------------------------

	@Test
	void everyPatchGetsExactlyOneWard() {
		Footprint fp = town(5, 5);
		TownWards w = wards(fp, new Cell(2, 2), BARE);
		assertEquals(fp.allCells().size(), w.wards().size());
		for (Cell c : fp.allCells()) {
			assertNotEquals(null, w.of(c), "no plot is left without a ward: " + c);
		}
	}

	@Test
	void theFoundingPlotIsAlwaysTheCityCentre() {
		// whatever else scores well there, the centre is the centre — it is not up for scoring
		Cell centre = new Cell(2, 2);
		Site everythingIsAHolySite = new Site() {

			@Override
			public DistrictType decided(Cell cell) {
				return DistrictType.HOLY_SITE;
			}
		};
		assertEquals(DistrictType.CITY_CENTER,
				wards(town(5, 5), centre, everythingIsAHolySite).of(centre));
	}

	@Test
	void theSimsOwnAnswerIsNotOverruled() {
		// district-buildout.md forbids the client inventing district identity, and this is the server
		// half of that: where the buildings decided a type, the scoring does not get a vote
		Cell built = new Cell(4, 4);
		Site site = new Site() {

			@Override
			public DistrictType decided(Cell cell) {
				return cell.equals(built) ? DistrictType.COMMERCIAL_HUB : null;
			}
		};
		TownWards w = wards(town(5, 5), new Cell(2, 2), site);
		assertEquals(DistrictType.COMMERCIAL_HUB, w.of(built));
		assertEquals(2, w.diag().fromSim(), "the centre and the built plot");
	}

	// --- the scoring --------------------------------------------------------------------------

	@Test
	void aTownGetsOneOfEachSpecialAndHousesForTheRest() {
		TownWards w = wards(town(5, 5), new Cell(2, 2), BARE);
		Map<DistrictType, Integer> counts = w.diag().counts();
		assertEquals(1, counts.get(DistrictType.CITY_CENTER));
		for (DistrictType t : List.of(DistrictType.ENCAMPMENT, DistrictType.HOLY_SITE,
				DistrictType.CAMPUS, DistrictType.THEATER)) {
			assertEquals(1, counts.get(t), t + " appears exactly once");
		}
		assertTrue(counts.getOrDefault(DistrictType.NEIGHBORHOOD, 0) > 10,
				"most of a town is where people live: " + w.diag());
	}

	@Test
	void marketsScaleWithTheTownAndTheOtherSpecialsDoNot() {
		Map<DistrictType, Integer> small = wards(town(3, 3), new Cell(1, 1), BARE).diag().counts();
		Map<DistrictType, Integer> big = wards(town(8, 8), new Cell(4, 4), BARE).diag().counts();
		assertTrue(big.get(DistrictType.COMMERCIAL_HUB) > small.get(DistrictType.COMMERCIAL_HUB),
				"a bigger town has more markets");
		assertEquals(small.get(DistrictType.HOLY_SITE), big.get(DistrictType.HOLY_SITE),
				"but only one cathedral, whatever its size");
	}

	@Test
	void theCitadelTakesTheWallAndTheHighGround() {
		// the reference's instinct, scored over real terrain: a hill ON the wall beats a hill in the
		// middle of town, because the citadel is there to hold the line
		Cell knoll = new Cell(0, 2);                 // on the west wall
		Site relief = new Site() {

			@Override
			public int elevation(Cell cell) {
				return cell.equals(knoll) ? 220 : 100;
			}

			@Override
			public boolean hill(Cell cell) {
				return cell.equals(knoll);
			}
		};
		assertEquals(DistrictType.ENCAMPMENT, wards(town(5, 5), new Cell(2, 2), relief).of(knoll));
	}

	@Test
	void theCathedralWantsARiseNearThePlazaAndNotTheRampart() {
		// the same two terms, weighted the other way round — which is the whole reason each ward
		// scores rather than being placed by a rule
		Cell rise = new Cell(2, 1);                  // one plot off the centre, interior
		Site relief = new Site() {

			@Override
			public int elevation(Cell cell) {
				return cell.equals(rise) ? 200 : 100;
			}
		};
		TownWards w = wards(town(5, 5), new Cell(2, 2), relief);
		assertEquals(DistrictType.HOLY_SITE, w.of(rise));
		assertNotEquals(DistrictType.ENCAMPMENT, w.of(rise), "the citadel took the wall instead");
	}

	@Test
	void aNoblesFiefPullsTheTheatreTowardIt() {
		// the term the reference could not have had: it invented a patriciate, and we have a real one
		Cell fief = new Cell(3, 2);
		Site held = new Site() {

			@Override
			public boolean enfeoffed(Cell cell) {
				return cell.equals(fief);
			}
		};
		TownWards plain = wards(town(5, 5), new Cell(2, 2), BARE);
		TownWards lorded = wards(town(5, 5), new Cell(2, 2), held);
		assertNotEquals(plain.of(fief), lorded.of(fief),
				"a lord's ground is not scored like crown demesne");
	}

	@Test
	void heightIsJudgedAgainstThisTownNotTheWholeHeightmap() {
		// §7's caveat: the imported heightmap is continental, so a whole settlement can span forty
		// units of 255. Scored absolutely, every plot in town reads as flat and the term does nothing.
		Cell top = new Cell(4, 0);
		Site shallow = new Site() {

			@Override
			public int elevation(Cell cell) {
				return cell.equals(top) ? 118 : 112;   // six units apart, out of 255
			}
		};
		TownWards w = wards(town(5, 5), new Cell(2, 2), shallow);
		assertTrue(w.of(top) == DistrictType.ENCAMPMENT || w.of(top) == DistrictType.HOLY_SITE,
				"a six-unit rise still reads as the high ground: " + w.of(top));
	}

	// --- determinism --------------------------------------------------------------------------

	@Test
	void theSameTownIsWardedTheSameWayTwice() {
		assertEquals(wards(town(6, 6), new Cell(3, 3), BARE).wards(),
				wards(town(6, 6), new Cell(3, 3), BARE).wards());
	}

	@Test
	void twoSitesOfTheSameShapeDoNotPutTheirCathedralOnTheSameCorner() {
		// the keyed nudge: without it every flat town of the same shape is identical, and a map of
		// them reads as a tiling rather than as places
		Footprint fp = town(5, 5);
		Cell centre = new Cell(2, 2);
		TownWall wall = TownWall.of(fp, true, 0, centre.centre(), DRY, List.of());
		TownWards a = TownWards.of(fp, wall, TownStreets.NONE, centre, BARE,
				TownRng.siteSeed(7654321L, 451));
		TownWards b = TownWards.of(fp, wall, TownStreets.NONE, centre, BARE,
				TownRng.siteSeed(7654321L, 4411));
		assertNotEquals(a.wards(), b.wards(), "two sites, two towns");
	}

	// --- totality -----------------------------------------------------------------------------

	@Test
	void nothingToWardIsAnAnswerNotAFailure() {
		assertSame(TownWards.NONE,
				TownWards.of(Footprint.EMPTY, TownWall.NONE, TownStreets.NONE, new Cell(0, 0), BARE,
						SEED));
		assertTrue(TownWards.NONE.isEmpty());
		// a centre outside the town is odd but not fatal: everything simply scores off it
		TownWards w = TownWards.of(town(3, 3), TownWall.NONE, TownStreets.NONE, new Cell(90, 90),
				BARE, SEED);
		assertFalse(w.isEmpty());
		assertEquals(9, w.wards().size());
	}
}
