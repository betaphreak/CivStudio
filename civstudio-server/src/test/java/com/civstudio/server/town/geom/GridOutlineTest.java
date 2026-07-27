package com.civstudio.server.town.geom;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.civstudio.server.town.geom.GridOutline.Cell;

/**
 * The union outline of a set of plots — the wall line, before it is a wall ({@code
 * docs/towngen-port.md} §5.2). The cases here are exactly the ones the reference generator's
 * single-loop walk gets wrong: a hole, and two disconnected clumps.
 */
class GridOutlineTest {

	private static final double EPS = 1e-9;

	private static Set<Cell> cells(int... xy) {
		Set<Cell> out = new LinkedHashSet<>();
		for (int i = 0; i < xy.length; i += 2) {
			out.add(new Cell(xy[i], xy[i + 1]));
		}
		return out;
	}

	private static Set<Cell> block(int x0, int y0, int w, int h) {
		Set<Cell> out = new LinkedHashSet<>();
		for (int x = x0; x < x0 + w; x++) {
			for (int y = y0; y < y0 + h; y++) {
				out.add(new Cell(x, y));
			}
		}
		return out;
	}

	@Test
	void oneCellIsItsSquare() {
		List<Poly> loops = GridOutline.loops(cells(3, 4));
		assertEquals(1, loops.size());
		Poly p = loops.get(0);
		assertEquals(4, p.size(), "four corners, not four sides plus duplicates");
		assertEquals(1.0, p.area(), EPS);
		assertTrue(p.signedArea() > 0, "the outer loop is canonical");
	}

	@Test
	void straightRunsCollapseToCorners() {
		Poly p = GridOutline.outer(GridOutline.loops(block(0, 0, 10, 3)));
		assertEquals(4, p.size(), "a 10x3 block is a rectangle: four vertices, not 26");
		assertEquals(30.0, p.area(), EPS);
	}

	@Test
	void anLShapeKeepsItsNotch() {
		Set<Cell> l = new LinkedHashSet<>(block(0, 0, 2, 1));
		l.addAll(block(0, 1, 1, 1));
		Poly p = GridOutline.outer(GridOutline.loops(l));
		assertEquals(6, p.size(), "an L has six corners");
		assertEquals(3.0, p.area(), EPS);
	}

	@Test
	void aDonutYieldsAnOuterLoopAndAHole() {
		Set<Cell> donut = new LinkedHashSet<>(block(0, 0, 3, 3));
		donut.remove(new Cell(1, 1));
		List<Poly> loops = GridOutline.loops(donut);
		assertEquals(2, loops.size(), "outer boundary plus the hole");
		Poly outer = GridOutline.outer(loops);
		assertEquals(9.0, outer.area(), EPS, "the outer loop ignores the hole");
		assertTrue(outer.signedArea() > 0);
		List<Poly> holes = GridOutline.holes(loops);
		assertEquals(1, holes.size());
		assertEquals(1.0, holes.get(0).area(), EPS);
		assertTrue(holes.get(0).signedArea() < 0, "a hole winds the other way");
	}

	@Test
	void twoDisconnectedClumpsBothGetLoops() {
		Set<Cell> two = new LinkedHashSet<>(block(0, 0, 2, 2));
		two.addAll(block(5, 5, 2, 2));
		List<Poly> loops = GridOutline.loops(two);
		assertEquals(2, loops.size(), "neither clump is silently dropped");
		for (Poly p : loops) {
			assertEquals(4.0, p.area(), EPS);
			assertTrue(p.signedArea() > 0, "both are outer loops, so both read as positive");
		}
	}

	@Test
	void aDiagonalPinchDoesNotWeldTwoLoopsIntoAFigureOfEight() {
		// two cells meeting at a single corner: the walk must not cross at the pinch
		List<Poly> loops = GridOutline.loops(cells(0, 0, 1, 1));
		assertEquals(2, loops.size());
		double total = 0;
		for (Poly p : loops) {
			total += p.area();
			assertTrue(p.signedArea() > 0);
		}
		assertEquals(2.0, total, EPS);
	}

	@Test
	void outlineAreaAlwaysMatchesTheCellCount() {
		// the invariant that matters downstream: the wall encloses exactly the plots it was given
		List<Set<Cell>> shapes = new ArrayList<>();
		shapes.add(block(0, 0, 4, 4));
		shapes.add(cells(0, 0, 1, 0, 2, 0, 2, 1, 2, 2, 1, 2, 0, 2, 0, 1));
		shapes.add(block(2, 2, 3, 5));
		for (Set<Cell> s : shapes) {
			List<Poly> loops = GridOutline.loops(s);
			double enclosed = 0;
			for (Poly p : loops) {
				enclosed += p.signedArea();      // holes subtract, being negative
			}
			assertEquals(s.size(), enclosed, EPS, "enclosed area == plot count for " + s.size());
		}
	}

	@Test
	void cellGeometryMatchesThePlotItStandsFor() {
		Cell c = new Cell(7, 2);
		assertEquals(7.5, c.centre().x(), EPS);
		assertEquals(2.5, c.centre().y(), EPS);
		assertEquals(1.0, c.square().area(), EPS);
		assertTrue(c.square().contains(c.centre()));
	}
}
