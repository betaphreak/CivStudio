package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

import org.junit.jupiter.api.Test;

import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Poly;

/**
 * The footprint cleanup ({@code docs/towngen-port.md} T2, shipping §5.2 and the cheap half of §7a).
 * <p>
 * Every case here is one the reference generator's single-loop walk gets wrong, because it never
 * had to wrap a shape it did not choose: a second clump, a pocket of unbuilt ground, and a lake the
 * town built around. The distinction the lake forces — fill land, keep water — is an invariant and
 * not a feature, which is why it lands in T2 rather than with the rest of the water work.
 */
class FootprintTest {

	private static final Predicate<Cell> ALL_LAND = c -> true;
	private static final Predicate<Cell> NO_LAND = c -> false;
	private static final double EPS = 1e-9;

	private static Set<Cell> block(int x0, int y0, int w, int h) {
		Set<Cell> out = new LinkedHashSet<>();
		for (int y = y0; y < y0 + h; y++) {
			for (int x = x0; x < x0 + w; x++) {
				out.add(new Cell(x, y));
			}
		}
		return out;
	}

	@Test
	void nothingClaimedIsAnEmptyFootprintNotACrash() {
		Footprint f = Footprint.of(List.of(), ALL_LAND);
		assertTrue(f.isEmpty());
		assertTrue(f.outer().isEmpty());
		assertEquals(0, f.size());
	}

	@Test
	void oneClaimedPlotIsAOnePlotTown() {
		Footprint f = Footprint.of(List.of(new Cell(4, 7)), ALL_LAND);
		assertEquals(1, f.size());
		assertEquals(1.0, f.outer().area(), EPS);
		assertTrue(f.waterHoles().isEmpty());
		assertTrue(f.diag().singleOuterLoop());
	}

	@Test
	void outlyingClumpsAreDroppedAndCounted() {
		// two built plots across the province are a hamlet outside the town, not part of it
		Set<Cell> claimed = new LinkedHashSet<>(block(0, 0, 4, 4));
		claimed.addAll(block(20, 20, 2, 1));
		claimed.add(new Cell(30, 30));
		Footprint f = Footprint.of(claimed, ALL_LAND);
		assertEquals(16, f.size());
		assertEquals(3, f.diag().droppedCells());
		assertEquals(2, f.diag().droppedClumps());
		assertEquals(16.0, f.outer().area(), EPS);
		assertTrue(f.diag().singleOuterLoop(), "one town, one wall line");
		assertTrue(f.diag().interesting(), "a dropped clump is worth a log line");
	}

	@Test
	void diagonalTouchIsNotConnected() {
		// 4-neighbour connectivity: a corner touch is two clumps, and walling them as one would
		// pinch the outline at a point no street could pass through
		Set<Cell> claimed = new LinkedHashSet<>(block(0, 0, 2, 2));
		claimed.addAll(block(2, 2, 2, 2));
		Footprint f = Footprint.of(claimed, ALL_LAND);
		assertEquals(4, f.size());
		assertEquals(4, f.diag().droppedCells());
		assertEquals(1, f.diag().droppedClumps());
	}

	@Test
	void anEnclosedPocketOfLandIsFilled() {
		// the town built around a plot it never claimed — an artefact of claim order, not a feature
		Set<Cell> claimed = new LinkedHashSet<>(block(0, 0, 3, 3));
		claimed.remove(new Cell(1, 1));
		Footprint f = Footprint.of(claimed, ALL_LAND);
		assertEquals(9, f.size(), "the pocket joins the footprint");
		assertTrue(f.cellSet().contains(new Cell(1, 1)));
		assertEquals(1, f.diag().filledPockets());
		assertTrue(f.waterHoles().isEmpty(), "a filled pocket is not a hole");
		assertEquals(9.0, f.outer().area(), EPS);
	}

	@Test
	void anEnclosedLakeIsKeptAsAHole() {
		// §7a: the fill must distinguish unbuilt land from water, or a town on a lake swallows it
		Set<Cell> claimed = new LinkedHashSet<>(block(0, 0, 3, 3));
		claimed.remove(new Cell(1, 1));
		Footprint f = Footprint.of(claimed, NO_LAND);
		assertEquals(8, f.size(), "the lake stays out of the footprint");
		assertFalse(f.cellSet().contains(new Cell(1, 1)));
		assertEquals(0, f.diag().filledPockets());
		assertEquals(1, f.diag().waterHoles());
		assertEquals(1, f.waterHoles().size());
		assertEquals(1.0, f.waterHoles().get(0).area(), EPS);
		assertTrue(f.waterHoles().get(0).signedArea() < 0, "a hole winds against the outer loop");
		assertEquals(9.0, f.outer().area(), EPS, "the outer loop still wraps the whole town");
	}

	@Test
	void aPocketWithAnyWaterInItIsKeptWhole() {
		// half-filling a shoreline pocket would put lots in the shallows, so a mixed pocket stays
		Set<Cell> claimed = new LinkedHashSet<>(block(0, 0, 4, 3));
		claimed.remove(new Cell(1, 1));
		claimed.remove(new Cell(2, 1));
		Predicate<Cell> land = c -> c.equals(new Cell(1, 1));   // one dry cell, one wet
		Footprint f = Footprint.of(claimed, land);
		assertEquals(10, f.size());
		assertEquals(0, f.diag().filledPockets());
		assertEquals(1, f.diag().waterHoles());
		assertEquals(2.0, f.waterHoles().get(0).area(), EPS);
	}

	@Test
	void aLandPocketAndALakeAreJudgedSeparately() {
		Set<Cell> claimed = new LinkedHashSet<>(block(0, 0, 5, 3));
		claimed.remove(new Cell(1, 1));                         // dry pocket
		claimed.remove(new Cell(3, 1));                         // lake
		Predicate<Cell> land = c -> c.equals(new Cell(1, 1));
		Footprint f = Footprint.of(claimed, land);
		assertEquals(14, f.size());
		assertEquals(1, f.diag().filledPockets());
		assertEquals(1, f.diag().waterHoles());
		assertTrue(f.cellSet().contains(new Cell(1, 1)));
		assertFalse(f.cellSet().contains(new Cell(3, 1)));
	}

	@Test
	void theOutlineAlwaysEnclosesExactlyTheFootprint() {
		// the invariant everything downstream leans on: signed areas sum to the plot count, so the
		// wall encloses the plots and the lakes are not counted as town
		Set<Cell> claimed = new LinkedHashSet<>(block(0, 0, 6, 5));
		claimed.remove(new Cell(2, 2));
		claimed.remove(new Cell(4, 3));
		Footprint f = Footprint.of(claimed, NO_LAND);
		double enclosed = f.outer().signedArea();
		for (Poly hole : f.waterHoles()) {
			enclosed += hole.signedArea();
		}
		assertEquals(f.size(), enclosed, EPS);
	}

	@Test
	void cellsComeBackInAStableOrder() {
		// the mesh draws its jitter per cell in this order, so it must not depend on how the
		// caller happened to build the set
		Set<Cell> a = new LinkedHashSet<>(block(0, 0, 3, 3));
		Set<Cell> b = new LinkedHashSet<>();
		List<Cell> reversed = List.copyOf(a).reversed();
		b.addAll(reversed);
		assertEquals(Footprint.of(a, ALL_LAND).cells(), Footprint.of(b, ALL_LAND).cells());
		List<Cell> cells = Footprint.of(a, ALL_LAND).cells();
		for (int i = 1; i < cells.size(); i++) {
			Cell p = cells.get(i - 1), c = cells.get(i);
			assertTrue(p.y() < c.y() || (p.y() == c.y() && p.x() < c.x()), "sorted by (y, x)");
		}
	}

	@Test
	void nearestRanksByDistanceThenStably() {
		Set<Cell> cells = block(0, 0, 5, 5);
		List<Cell> near = Footprint.nearest(cells, 5, 2.5, 2.5);
		assertEquals(new Cell(2, 2), near.get(0), "the centre plot first");
		assertEquals(5, near.size());
		// the four orthogonal neighbours are equidistant: the tie-break must be (y, x), matching
		// what district-plots.mjs has been doing, or server and client light different plots
		assertEquals(List.of(new Cell(2, 1), new Cell(1, 2), new Cell(3, 2), new Cell(2, 3)),
				near.subList(1, 5));
		assertEquals(cells.size(), Footprint.nearest(cells, 999, 2.5, 2.5).size());
		assertTrue(Footprint.nearest(cells, 0, 2.5, 2.5).isEmpty());
	}

	@Test
	void aRingTownKeepsItsCourtyardWhenItIsWater() {
		// the shape that would defeat a naive walk entirely: a town that is only a wall
		Set<Cell> ring = new LinkedHashSet<>(block(0, 0, 5, 5));
		ring.removeAll(block(1, 1, 3, 3));
		Footprint f = Footprint.of(ring, NO_LAND);
		assertEquals(16, f.size());
		assertEquals(1, f.waterHoles().size());
		assertEquals(9.0, f.waterHoles().get(0).area(), EPS);
		assertTrue(f.diag().singleOuterLoop());
	}
}
