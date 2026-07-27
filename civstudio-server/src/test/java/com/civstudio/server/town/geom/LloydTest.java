package com.civstudio.server.town.geom;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.civstudio.server.town.geom.GridOutline.Cell;

/**
 * Jitter, relaxation and — the point of the exercise — the <b>clamp</b> ({@code
 * docs/towngen-port.md} §4.1).
 * <p>
 * The bijection is what the whole design rests on: every patch holds exactly one plot centre, and
 * every plot has a patch. Under the clamp it holds <em>by construction</em> for any footprint
 * shape, so these tests go looking for the shapes that would break an unclamped mesh — concave,
 * holed, and a caller who passes an over-large radius — rather than checking a happy path.
 */
class LloydTest {

	private static final double R = TownScale.JITTER_R;

	private static List<Pt> anchorsOf(Set<Cell> cells) {
		List<Pt> out = new ArrayList<>();
		for (Cell c : cells) {
			out.add(c.centre());
		}
		return out;
	}

	/** An L-shaped footprint with a hole — deliberately the worst case for an unclamped relax. */
	private static Set<Cell> awkwardFootprint() {
		Set<Cell> cells = new LinkedHashSet<>();
		for (int x = 0; x < 5; x++) {
			for (int y = 0; y < 5; y++) {
				if (x >= 3 && y >= 3) {
					continue;                  // the notch that makes it concave
				}
				if (x == 1 && y == 1) {
					continue;                  // the hole
				}
				cells.add(new Cell(x, y));
			}
		}
		return cells;
	}

	private static Poly boundsOf(List<Pt> anchors) {
		double x0 = Double.MAX_VALUE, y0 = Double.MAX_VALUE, x1 = -Double.MAX_VALUE,
				y1 = -Double.MAX_VALUE;
		for (Pt p : anchors) {
			x0 = Math.min(x0, p.x());
			y0 = Math.min(y0, p.y());
			x1 = Math.max(x1, p.x());
			y1 = Math.max(y1, p.y());
		}
		return new Poly.Box(x0, y0, x1, y1).grow(1).poly();
	}

	@Test
	void jitterStaysInsideItsRadiusAndIsReproducible() {
		List<Pt> anchors = anchorsOf(awkwardFootprint());
		List<Pt> a = Lloyd.jitter(anchors, R, new Random(7654321L));
		List<Pt> b = Lloyd.jitter(anchors, R, new Random(7654321L));
		assertEquals(a, b, "same seed, same mesh — the layout is a pure function of seed + footprint");
		for (int i = 0; i < anchors.size(); i++) {
			assertTrue(a.get(i).dist(anchors.get(i)) <= R + 1e-12,
					"seed " + i + " strayed " + a.get(i).dist(anchors.get(i)));
		}
		assertNotEquals(a, Lloyd.jitter(anchors, R, new Random(999L)), "a different seed differs");
	}

	@Test
	void relaxationOfBarePlotCentresChangesNothing() {
		// §4.1's opening observation, as an executable statement: the Voronoi of a lattice IS the
		// lattice, so on unjittered plot centres Lloyd moves nothing however long it runs — which
		// is why the irregularity has to be injected as jitter and cannot come from relaxation
		List<Pt> anchors = new ArrayList<>();
		for (int x = 0; x < 4; x++) {
			for (int y = 0; y < 4; y++) {
				anchors.add(new Pt(x + 0.5, y + 0.5));
			}
		}
		List<Pt> relaxed = Lloyd.relax(anchors, anchors, Poly.rect(0, 0, 4, 4), R, 4);
		for (int i = 0; i < anchors.size(); i++) {
			assertEquals(anchors.get(i).x(), relaxed.get(i).x(), 1e-9);
			assertEquals(anchors.get(i).y(), relaxed.get(i).y(), 1e-9);
		}
	}

	@Test
	void onAConcaveFootprintRelaxationWorksOnlyAtTheEdges() {
		// the other half of §4.1: interior cells are exactly their plot squares and sit still,
		// while cells the footprint boundary clips are the ones that genuinely reshape
		List<Pt> anchors = anchorsOf(awkwardFootprint());
		List<Pt> relaxed = Lloyd.relax(anchors, anchors, boundsOf(anchors), R, 1);
		int interior = anchors.indexOf(new Pt(3.5, 1.5));      // all four neighbours present
		assertTrue(interior >= 0);
		assertEquals(0.0, relaxed.get(interior).dist(anchors.get(interior)), 1e-9,
				"an interior seed has nothing to relax toward");
		int corner = anchors.indexOf(new Pt(0.5, 0.5));
		assertTrue(relaxed.get(corner).dist(anchors.get(corner)) > 1e-6,
				"a boundary seed pulls toward the open ground its cell reaches into");
	}

	@Test
	void theBijectionHoldsOnAConcaveHoledFootprint() {
		List<Pt> anchors = anchorsOf(awkwardFootprint());
		Poly bounds = boundsOf(anchors);
		List<Pt> seeds = Lloyd.jitter(anchors, R, new Random(20260727L));
		seeds = Lloyd.relax(seeds, anchors, bounds, R, TownScale.LLOYD_PASSES);
		List<Poly> cells = Voronoi.cells(seeds, bounds);

		for (int i = 0; i < anchors.size(); i++) {
			// forward: the plot centre lies in its OWN patch
			assertTrue(cells.get(i).contains(anchors.get(i)),
					"plot " + i + " is not inside its own patch");
			// and the equivalent statement the proof actually makes: no other seed is nearer
			for (int j = 0; j < seeds.size(); j++) {
				if (i != j) {
					assertTrue(anchors.get(i).dist(seeds.get(i)) < anchors.get(i).dist(seeds.get(j)),
							"seed " + j + " stole plot " + i + "'s centre");
				}
			}
			// reverse: every plot has a non-empty patch
			assertTrue(!cells.get(i).isEmpty(), "plot " + i + " has no patch at all");
		}
	}

	@Test
	void manyPassesCannotBreakTheBijectionEither() {
		// relaxation to convergence would flatten the mesh toward a honeycomb, but it must never
		// break the invariant — the clamp is re-applied every pass, not only at the end
		List<Pt> anchors = anchorsOf(awkwardFootprint());
		Poly bounds = boundsOf(anchors);
		List<Pt> seeds = Lloyd.relax(Lloyd.jitter(anchors, R, new Random(11L)), anchors, bounds,
				R, 25);
		List<Poly> cells = Voronoi.cells(seeds, bounds);
		for (int i = 0; i < anchors.size(); i++) {
			assertTrue(seeds.get(i).dist(anchors.get(i)) <= R + 1e-12, "clamp held at seed " + i);
			assertTrue(cells.get(i).contains(anchors.get(i)), "bijection held at plot " + i);
		}
	}

	@Test
	void anOverLargeRadiusIsCappedRatherThanTrusted() {
		// a caller asking for r >= 0.5 is asking for a broken mesh; the clamp refuses, because the
		// guarantee must not depend on every future call site remembering the bound
		Pt anchor = new Pt(0.5, 0.5);
		Pt far = Lloyd.clamp(new Pt(9, 9), anchor, 5.0);
		assertTrue(far.dist(anchor) < TownScale.JITTER_MAX, "clamped to below half a plot");
		List<Pt> anchors = List.of(new Pt(0.5, 0.5), new Pt(1.5, 0.5));
		List<Pt> wild = Lloyd.jitter(anchors, 5.0, new Random(3L));
		for (int i = 0; i < anchors.size(); i++) {
			assertTrue(wild.get(i).dist(anchors.get(i)) < TownScale.JITTER_MAX);
		}
	}

	@Test
	void growthMovesExistingPatchesOnlyWithinTheClampBound() {
		// §2a's stability claim, in its honest form: adding a plot perturbs the mesh, but no
		// boundary can move by more than about 2r, because no seed can
		Set<Cell> before = new LinkedHashSet<>();
		for (int x = 0; x < 4; x++) {
			for (int y = 0; y < 4; y++) {
				before.add(new Cell(x, y));
			}
		}
		List<Pt> a0 = anchorsOf(before);
		Set<Cell> after = new LinkedHashSet<>(before);
		after.add(new Cell(4, 1));                    // the town builds one more plot
		List<Pt> a1 = anchorsOf(after);

		List<Pt> s0 = Lloyd.relax(Lloyd.jitter(a0, R, new Random(42L)), a0, boundsOf(a0), R,
				TownScale.LLOYD_PASSES);
		List<Pt> s1 = Lloyd.relax(Lloyd.jitter(a1, R, new Random(42L)), a1, boundsOf(a1), R,
				TownScale.LLOYD_PASSES);
		for (int i = 0; i < a0.size(); i++) {
			assertTrue(s0.get(i).dist(s1.get(i)) <= 2 * R + 1e-9,
					"seed " + i + " migrated " + s0.get(i).dist(s1.get(i)) + " on growth");
		}
	}
}
