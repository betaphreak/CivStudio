package com.civstudio.server.town.geom;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

import org.junit.jupiter.api.Test;

/**
 * The bounded Voronoi ({@code docs/towngen-port.md} T1). Two properties carry the mesh: the cells
 * <b>tile</b> the bounds (nothing lost, nothing counted twice) and each cell <b>holds its own
 * seed</b> — the second being the shape the plot ↔ patch bijection takes before the clamp makes it
 * unconditional.
 */
class VoronoiTest {

	private static final double EPS = 1e-9;

	@Test
	void oneSeedTakesEverything() {
		Poly bounds = Poly.rect(0, 0, 4, 4);
		List<Poly> cells = Voronoi.cells(List.of(new Pt(1, 1)), bounds);
		assertEquals(1, cells.size());
		assertEquals(16.0, cells.get(0).area(), EPS);
	}

	@Test
	void twoSeedsSplitOnTheBisector() {
		Poly bounds = Poly.rect(0, 0, 4, 2);
		List<Poly> cells = Voronoi.cells(List.of(new Pt(1, 1), new Pt(3, 1)), bounds);
		assertEquals(4.0, cells.get(0).area(), EPS);
		assertEquals(4.0, cells.get(1).area(), EPS);
		assertTrue(cells.get(0).contains(new Pt(1, 1)));
		assertTrue(cells.get(1).contains(new Pt(3, 1)));
		assertTrue(cells.get(0).isConvex(), "a Voronoi cell is always convex");
	}

	@Test
	void unjitteredPlotCentresGiveBackThePlotSquares() {
		// the observation §4.1 is built on: the Voronoi of a lattice IS the lattice, so seeding
		// bare plot centres produces square wards and relaxation has nothing to do
		List<Pt> seeds = new ArrayList<>();
		for (int x = 0; x < 3; x++) {
			for (int y = 0; y < 3; y++) {
				seeds.add(new Pt(x + 0.5, y + 0.5));
			}
		}
		List<Poly> cells = Voronoi.cells(seeds, Poly.rect(0, 0, 3, 3));
		for (int i = 0; i < seeds.size(); i++) {
			Poly c = cells.get(i);
			assertEquals(1.0, c.area(), 1e-9, "every cell is exactly its plot square");
			assertEquals(seeds.get(i).x(), c.centroid().x(), 1e-9);
			assertEquals(seeds.get(i).y(), c.centroid().y(), 1e-9);
		}
	}

	@Test
	void cellsTileTheBoundsAndEachHoldsItsSeed() {
		Random rnd = new Random(20260727L);
		Poly bounds = Poly.rect(0, 0, 6, 5);
		List<Pt> seeds = new ArrayList<>();
		for (int i = 0; i < 40; i++) {
			seeds.add(new Pt(rnd.nextDouble() * 6, rnd.nextDouble() * 5));
		}
		List<Poly> cells = Voronoi.cells(seeds, bounds);
		double total = 0;
		for (int i = 0; i < seeds.size(); i++) {
			total += cells.get(i).area();
			assertTrue(cells.get(i).contains(seeds.get(i)), "cell " + i + " lost its own seed");
			assertTrue(cells.get(i).isConvex(), "cell " + i + " is not convex");
		}
		assertEquals(bounds.area(), total, 1e-9, "the cells tile the bounds exactly");
	}

	@Test
	void coincidentSeedsGiveTheCellToTheFirstRatherThanToBoth() {
		// there is no bisector between two seeds at the same point, so the naive clip keeps the
		// whole bounds for BOTH — two cells claiming the same ground, which would break the
		// bijection downstream while looking perfectly healthy
		List<Pt> seeds = List.of(new Pt(1, 1), new Pt(1, 1));
		List<Poly> cells = Voronoi.cells(seeds, Poly.rect(0, 0, 2, 2));
		assertEquals(2, cells.size());
		assertEquals(4.0, cells.get(0).area(), EPS, "the first seed keeps the cell");
		assertTrue(cells.get(1).isEmpty(), "the duplicate gets nothing, and gets it deterministically");
	}

	@Test
	void singleCellMatchesTheWholeDiagram() {
		List<Pt> seeds = List.of(new Pt(1, 1), new Pt(3, 1), new Pt(2, 3));
		Poly bounds = Poly.rect(0, 0, 4, 4);
		List<Poly> all = Voronoi.cells(seeds, bounds);
		for (int i = 0; i < seeds.size(); i++) {
			assertEquals(all.get(i).area(), Voronoi.cell(seeds, i, bounds).area(), EPS,
					"one cell alone is the same cell — a growth step need not rebuild the diagram");
		}
	}
}
