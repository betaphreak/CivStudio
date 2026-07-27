package com.civstudio.server.town.geom;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * Polygon algebra — {@code docs/towngen-port.md} T1. The area centroid and the orientation
 * convention are the two things everything downstream silently depends on (Lloyd converges to the
 * centroid; inset and clipping pick their side from the signed area), so they are pinned hardest
 * here.
 */
class PolyTest {

	private static final double EPS = 1e-9;

	@Test
	void unitSquareIsCanonicalWithUnitArea() {
		Poly sq = Poly.rect(0, 0, 1, 1);
		assertEquals(1.0, sq.signedArea(), EPS, "raster-order square is canonical (positive)");
		assertEquals(1.0, sq.area(), EPS);
		assertEquals(4.0, sq.perimeter(), EPS);
		assertTrue(sq.isConvex());
		assertFalse(sq.isEmpty());
		assertEquals(0.5, sq.centroid().x(), EPS);
		assertEquals(0.5, sq.centroid().y(), EPS);
	}

	@Test
	void reversingFlipsTheSignButNothingElse() {
		Poly sq = Poly.rect(0, 0, 2, 1);
		Poly back = sq.reversed();
		assertEquals(-sq.signedArea(), back.signedArea(), EPS);
		assertEquals(sq.area(), back.area(), EPS);
		assertEquals(sq.signedArea(), back.canonical().signedArea(), EPS,
				"canonical() normalises either winding to the same orientation");
	}

	@Test
	void centroidIsTheAreaCentroidNotTheVertexMean() {
		// an L: the vertex mean and the area centroid differ, and Lloyd needs the latter
		Poly l = Poly.of(new Pt(0, 0), new Pt(2, 0), new Pt(2, 1), new Pt(1, 1),
				new Pt(1, 2), new Pt(0, 2));
		assertEquals(3.0, l.area(), EPS);
		double meanX = 0, meanY = 0;
		for (Pt p : l.points()) {
			meanX += p.x() / l.size();
			meanY += p.y() / l.size();
		}
		Pt c = l.centroid();
		assertEquals(5.0 / 6, c.x(), EPS);
		assertEquals(5.0 / 6, c.y(), EPS);
		assertTrue(Math.abs(c.x() - meanX) > 1e-3, "differs from the vertex mean " + meanX);
		assertTrue(Math.abs(c.y() - meanY) > 1e-3);
	}

	@Test
	void containsAcceptsInsideAndRejectsOutside() {
		Poly l = Poly.of(new Pt(0, 0), new Pt(2, 0), new Pt(2, 1), new Pt(1, 1),
				new Pt(1, 2), new Pt(0, 2));
		assertTrue(l.contains(new Pt(0.5, 0.5)));
		assertTrue(l.contains(new Pt(1.5, 0.5)));
		assertTrue(l.contains(new Pt(0.5, 1.5)));
		assertFalse(l.contains(new Pt(1.5, 1.5)), "the notch of the L is outside");
		assertFalse(l.contains(new Pt(3, 3)));
	}

	@Test
	void clipHalfPlaneKeepsTheInwardSide() {
		Poly sq = Poly.rect(0, 0, 2, 2);
		Poly right = sq.clipHalfPlane(new Pt(1, 0), new Pt(1, 0));
		assertEquals(2.0, right.area(), EPS, "half the square survives");
		assertTrue(right.contains(new Pt(1.5, 1)));
		assertFalse(right.contains(new Pt(0.5, 1)));
		assertTrue(sq.clipHalfPlane(new Pt(-1, 0), new Pt(-1, 0)).isEmpty(),
				"clipped entirely away is EMPTY, not an exception");
	}

	@Test
	void clipConvexIntersectsTwoBoxes() {
		Poly a = Poly.rect(0, 0, 2, 2);
		Poly b = Poly.rect(1, 1, 2, 2);
		assertEquals(1.0, a.clipConvex(b).area(), EPS);
		assertEquals(1.0, b.clipConvex(a).area(), EPS);
		assertTrue(a.clipConvex(Poly.rect(5, 5, 1, 1)).isEmpty());
	}

	@Test
	void insetShrinksBySameDistanceOnEveryEdge() {
		Poly sq = Poly.rect(0, 0, 4, 4);
		Poly in = sq.inset(1);
		assertEquals(4.0, in.area(), EPS, "4x4 inset by 1 is 2x2");
		Poly.Box b = in.bbox();
		assertEquals(1.0, b.x0(), EPS);
		assertEquals(3.0, b.x1(), EPS);
		assertEquals(36.0, sq.inset(-1).area(), EPS, "a negative inset grows it to 6x6");
	}

	@Test
	void perEdgeInsetMovesOnlyTheEdgesGiven() {
		Poly sq = Poly.rect(0, 0, 4, 4).canonical();
		double[] d = new double[] {1, 0, 0, 0};        // set back from the first edge only
		Poly in = sq.inset(d);
		assertEquals(12.0, in.area(), EPS, "4x4 with one edge pulled in by 1 is 4x3");
	}

	@Test
	void cutSplitsInTwoAndTheGapIsTheStreet() {
		Poly sq = Poly.rect(0, 0, 4, 2);
		List<Poly> halves = sq.cut(new Pt(2, 1), new Pt(0, 1), 0.5);
		assertEquals(2, halves.size());
		double sum = halves.get(0).area() + halves.get(1).area();
		assertEquals(8.0 - 0.5 * 2, sum, EPS, "the gap's area is what the street took");
		assertEquals(1, sq.cut(new Pt(99, 99), new Pt(0, 1), 0.5).size(), "a miss is one piece");
	}

	@Test
	void compactnessRanksSquareAboveSliver() {
		double square = Poly.rect(0, 0, 1, 1).compactness();
		double sliver = Poly.rect(0, 0, 10, 0.1).compactness();
		assertEquals(Math.PI / 4, square, 1e-6);
		assertTrue(sliver < square / 4, "a 100:1 sliver is far less compact: " + sliver);
	}

	@Test
	void interpolateWeightsTheCorners() {
		Poly sq = Poly.rect(0, 0, 2, 2);
		Pt corner = sq.interpolate(new double[] {1, 0, 0, 0});
		assertEquals(0.0, corner.x(), EPS);
		assertEquals(0.0, corner.y(), EPS);
		Pt middle = sq.interpolate(new double[] {1, 1, 1, 1});
		assertEquals(1.0, middle.x(), EPS);
		assertEquals(1.0, middle.y(), EPS);
	}

	@Test
	void degenerateInputsDegradeAndDoNotThrow() {
		assertTrue(Poly.EMPTY.isEmpty());
		assertEquals(0.0, Poly.EMPTY.area(), EPS);
		assertEquals(Pt.ZERO, Poly.EMPTY.centroid());
		Poly line = Poly.of(new Pt(0, 0), new Pt(1, 0), new Pt(2, 0));
		assertTrue(line.isEmpty(), "zero area counts as empty");
		assertEquals(1.0, line.centroid().x(), EPS, "the vertex mean is the fallback");
	}
}
