package com.civstudio.server.town.geom;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * Open polylines ({@code docs/towngen-port.md} T5) — the corner-cutting that turns a routed street
 * into a drawn one, and the pins that keep a junction a junction.
 */
class PolylineTest {

	private static final double EPS = 1e-9;

	private static List<Pt> line(double... xy) {
		List<Pt> pts = new java.util.ArrayList<>();
		for (int i = 0; i + 1 < xy.length; i += 2) {
			pts.add(new Pt(xy[i], xy[i + 1]));
		}
		return pts;
	}

	@Test
	void smoothingKeepsBothEndsExactly() {
		List<Pt> smoothed = Polyline.smooth(line(0, 0, 1, 0, 1, 1), 3);
		assertEquals(new Pt(0, 0), smoothed.get(0));
		assertEquals(new Pt(1, 1), smoothed.get(smoothed.size() - 1));
	}

	@Test
	void smoothingNeverLeavesTheOriginalsHull() {
		// every Chaikin point is a convex combination of two input points, so the curve cannot
		// overshoot — which for a street means it cannot bulge out through a building
		List<Pt> smoothed = Polyline.smooth(line(0, 0, 2, 0, 2, 2, 0, 2), 4);
		for (Pt p : smoothed) {
			assertTrue(p.x() >= -EPS && p.x() <= 2 + EPS, "x stayed in [0,2]: " + p);
			assertTrue(p.y() >= -EPS && p.y() <= 2 + EPS, "y stayed in [0,2]: " + p);
		}
	}

	@Test
	void smoothingCutsTheCornerAndShortensTheLine() {
		List<Pt> corner = line(0, 0, 1, 0, 1, 1);
		double before = Polyline.length(corner);
		double after = Polyline.length(Polyline.smooth(corner, 2));
		assertEquals(2.0, before, EPS);
		assertTrue(after < before, "cutting a corner is shorter: " + after);
		assertTrue(after > 1.41, "but not shorter than the straight line: " + after);
	}

	@Test
	void aPinnedVertexDoesNotMove() {
		// THE JUNCTION RULE. A branch ends on this vertex of another street; if smoothing moved it,
		// the two would part company by up to a quarter of a plot and every junction would show a gap
		List<Pt> pts = line(0, 0, 1, 0, 2, 0, 2, 1, 2, 2);
		boolean[] pinned = new boolean[pts.size()];
		pinned[2] = true;
		List<Pt> smoothed = Polyline.smooth(pts, pinned, 3);
		assertTrue(smoothed.contains(new Pt(2, 0)), "the pinned vertex survived verbatim");
	}

	@Test
	void aPinnedVertexIsNotDuplicatedAtTheJoin() {
		// the runs either side of a pin both own it; appending both would leave a zero-length segment
		List<Pt> pts = line(0, 0, 1, 0, 2, 1);
		boolean[] pinned = new boolean[] {false, true, false};
		List<Pt> smoothed = Polyline.smooth(pts, pinned, 2);
		int seen = 0;
		for (Pt p : smoothed) {
			if (p.equals(new Pt(1, 0))) {
				seen++;
			}
		}
		assertEquals(1, seen, "the pin appears once");
	}

	@Test
	void pinningEveryVertexLeavesTheLineAlone() {
		List<Pt> pts = line(0, 0, 1, 0, 1, 1, 2, 1);
		boolean[] all = new boolean[] {true, true, true, true};
		assertEquals(pts, Polyline.smooth(pts, all, 4));
	}

	@Test
	void degenerateInputComesBackUnharmed() {
		assertEquals(List.of(), Polyline.smooth(null, 2));
		assertEquals(0.0, Polyline.length(List.of()), EPS);
		assertEquals(0.0, Polyline.length(line(3, 4)), EPS);
		List<Pt> two = line(0, 0, 3, 4);
		assertEquals(two, Polyline.smooth(two, 3), "a straight segment has no corner to cut");
		assertEquals(5.0, Polyline.length(two), EPS);
	}

	@Test
	void zeroIterationsIsIdentity() {
		List<Pt> pts = line(0, 0, 1, 0, 1, 1);
		assertEquals(pts, Polyline.smooth(pts, 0));
	}
}
