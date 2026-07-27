package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDate;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.Province;
import com.civstudio.server.town.TownMesh.Patch;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Lloyd;
import com.civstudio.server.town.geom.Pt;
import com.civstudio.server.town.geom.TownScale;
import com.civstudio.settlement.GameSession;
import com.civstudio.settlement.PlotOccupant;
import com.civstudio.settlement.Settlement;

/**
 * The mesh ({@code docs/towngen-port.md} T3). The invariant the whole design rests on is the
 * bijection — every patch holds exactly one plot centre, every plot has a patch — and §4.1 makes it
 * true by construction rather than by luck, so these tests aim at the shapes that would break a
 * mesh that only got lucky: concave, holed, and with detached suburbs.
 */
class TownMeshTest {

	private static final Predicate<Cell> ALL_LAND = c -> true;
	private static final Predicate<Cell> NO_LAND = c -> false;
	private static final long SEED = TownRng.siteSeed(7654321L, 4411);

	private static Set<Cell> block(int x0, int y0, int w, int h) {
		Set<Cell> out = new LinkedHashSet<>();
		for (int y = y0; y < y0 + h; y++) {
			for (int x = x0; x < x0 + w; x++) {
				out.add(new Cell(x, y));
			}
		}
		return out;
	}

	/** Concave, holed, and with a detached suburb — everything at once. */
	private static Footprint awkward() {
		Set<Cell> cells = new LinkedHashSet<>(block(0, 0, 5, 5));
		cells.removeAll(block(3, 3, 2, 2));             // the notch
		cells.remove(new Cell(1, 1));                   // the lake
		cells.addAll(block(8, 0, 2, 1));                // a suburb across the fields
		return Footprint.of(cells, c -> !c.equals(new Cell(1, 1)));
	}

	private static void assertBijection(TownMesh mesh) {
		for (Patch p : mesh.patches()) {
			assertTrue(p.poly().contains(p.cell().centre()),
					"patch " + p.cell() + " does not hold its own plot centre");
			assertTrue(p.poly().area() > 0, "patch " + p.cell() + " is empty");
			assertTrue(p.seed().dist(p.cell().centre()) <= TownScale.JITTER_R + 1e-12,
					"seed " + p.cell() + " escaped its clamp");
		}
		assertEquals(0, mesh.diag().bijectionRepairs(),
				"the clamp makes repairs impossible: " + mesh.diag());
	}

	@Test
	void everyPlotGetsExactlyOnePatchOnAnAwkwardFootprint() {
		Footprint fp = awkward();
		TownMesh mesh = TownMesh.of(fp, SEED);
		assertEquals(fp.allCells().size(), mesh.patches().size());
		assertEquals(fp.allCells().size(), mesh.byCell().size(), "one patch per plot, no doubles");
		assertBijection(mesh);
	}

	@Test
	void patchesTileTheTownWithoutSpillingOffIt() {
		Footprint fp = awkward();
		TownMesh mesh = TownMesh.of(fp, SEED);
		double total = 0;
		for (Patch p : mesh.patches()) {
			total += p.poly().area();
		}
		int plots = fp.allCells().size();
		assertEquals(plots, total, plots * 0.05,
				"the patches cover the town's ground and little else: " + total + " over " + plots);
	}

	@Test
	void noPatchReachesIntoTheLake() {
		// the hole is water the town built around; a ward standing in it would be a ward in a lake
		Footprint fp = awkward();
		TownMesh mesh = TownMesh.of(fp, SEED);
		Cell lake = new Cell(1, 1);
		for (Patch p : mesh.patches()) {
			assertFalse(p.poly().contains(lake.centre()),
					"patch " + p.cell() + " reached into the lake");
		}
	}

	@Test
	void suburbsAreMeshedAndMarkedExtramural() {
		Footprint fp = awkward();
		TownMesh mesh = TownMesh.of(fp, SEED);
		Map<Cell, Patch> by = mesh.byCell();
		assertTrue(by.containsKey(new Cell(8, 0)), "a suburb is built ground and gets a patch");
		assertFalse(by.get(new Cell(8, 0)).walled(), "but it is outside the wall");
		assertTrue(by.get(new Cell(0, 0)).walled(), "while the body is inside it");
		assertEquals(2, mesh.diag().extramural());
	}

	@Test
	void growthBeyondTheNeighbourhoodChangesNothingAtAll() {
		// the payoff of keying jitter on (seed, x, y) and computing every patch locally. The
		// footprint hands cells back sorted, so this new plot lands at the FRONT of the list —
		// under a streamed draw every seed after it would move, resettling wards nobody touched,
		// and under globally-derived bounds every patch would shift a few ulps.
		Footprint before = Footprint.of(block(0, 0, 4, 4), ALL_LAND);
		Set<Cell> grown = new LinkedHashSet<>(block(0, 0, 4, 4));
		grown.add(new Cell(2, -3));                    // three plots clear of anything existing
		Footprint after = Footprint.of(grown, ALL_LAND);

		Map<Cell, Patch> a = TownMesh.of(before, SEED).byCell();
		Map<Cell, Patch> b = TownMesh.of(after, SEED).byCell();
		assertEquals(16, a.size());
		assertEquals(17, b.size());
		for (Cell c : a.keySet()) {
			assertEquals(a.get(c), b.get(c),
					"patch " + c + " changed when a plot three away was built");
		}
	}

	@Test
	void aPlotsJitterIsAPropertyOfThePlotAndNothingElse() {
		// the pre-relaxation draw, which is where order-dependence would enter. Same plot, same
		// site, same offset — regardless of what else exists, in what order, or whether the town
		// is being generated whole or rebuilt from a file years later.
		Pt once = Lloyd.jitterAt(new Cell(3, 3).centre(), TownScale.JITTER_R,
				TownRng.cellKey(SEED, 3, 3));
		Pt again = Lloyd.jitterAt(new Cell(3, 3).centre(), TownScale.JITTER_R,
				TownRng.cellKey(SEED, 3, 3));
		assertEquals(once, again);
		assertNotEquals(once, Lloyd.jitterAt(new Cell(3, 3).centre(), TownScale.JITTER_R,
				TownRng.cellKey(SEED, 3, 4)), "and a different plot draws differently");
	}

	@Test
	void growthReshapesOnlyTheNeighbourhoodOfTheNewPlot() {
		Footprint before = Footprint.of(block(0, 0, 6, 6), ALL_LAND);
		Set<Cell> grown = new LinkedHashSet<>(block(0, 0, 6, 6));
		grown.add(new Cell(6, 5));
		Footprint after = Footprint.of(grown, ALL_LAND);
		Map<Cell, Patch> a = TownMesh.of(before, SEED).byCell();
		Map<Cell, Patch> b = TownMesh.of(after, SEED).byCell();
		Cell far = new Cell(0, 0);
		assertEquals(a.get(far).poly().points(), b.get(far).poly().points(),
				"a patch three plots away is untouched by the new one");
		assertNotEquals(a.get(new Cell(5, 5)).poly().points(),
				b.get(new Cell(5, 5)).poly().points(), "its neighbour does give ground");
	}

	@Test
	void theSameSeedGivesTheSameMeshAndADifferentSeedDoesNot() {
		Footprint fp = awkward();
		assertEquals(TownMesh.of(fp, SEED).patches(), TownMesh.of(fp, SEED).patches());
		assertNotEquals(TownMesh.of(fp, SEED).patches(),
				TownMesh.of(fp, TownRng.siteSeed(7654321L, 4412)).patches());
	}

	@Test
	void aOnePlotTownIsAOnePatchMesh() {
		TownMesh mesh = TownMesh.of(Footprint.of(List.of(new Cell(3, 3)), ALL_LAND), SEED);
		assertEquals(1, mesh.patches().size());
		assertBijection(mesh);
		assertEquals(1.0, mesh.patches().get(0).poly().area(), 1e-9,
				"clipped on all four sides, it is exactly its own plot square");
	}

	@Test
	void anEmptyFootprintMeshesToNothing() {
		assertTrue(TownMesh.of(Footprint.EMPTY, SEED).isEmpty());
		assertEquals(0, TownMesh.of(Footprint.EMPTY, SEED).diag().patches());
	}

	@Test
	void aRingTownAroundALakeStillHoldsTheBijection() {
		Set<Cell> ring = new LinkedHashSet<>(block(0, 0, 5, 5));
		ring.removeAll(block(1, 1, 3, 3));
		assertBijection(TownMesh.of(Footprint.of(ring, NO_LAND), SEED));
	}

	@Test
	void nathalaireMeshesIntoAWardPerPlot() {
		GameSession s = new GameSession(42);
		Province dh = s.getWorldMap().findByName("Nathalaire").orElseThrow();
		Settlement c = s.newSettlement("Test", LocalDate.of(1444, 12, 11), 30, 26, 5, 2, dh);
		c.claimPlot(new PlotOccupant() {
		});
		Footprint fp = ColonyFootprint.of(c, s.plotPoolIfPresent(dh.id()));
		TownMesh mesh = TownMesh.of(fp, TownRng.siteSeed(42, dh.id()));

		assertEquals(27, mesh.patches().size(), "one ward per plot of the 1444 core");
		assertBijection(mesh);
		double total = 0;
		for (Patch p : mesh.patches()) {
			total += p.poly().area();
			assertTrue(p.poly().isConvex(), "patch " + p.cell() + " is not convex");
		}
		assertEquals(27.0, total, 1.5, "the wards cover the town: " + total);
	}
}
