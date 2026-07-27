package com.civstudio.server.town.geom;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Random;

import org.junit.jupiter.api.Test;

/**
 * The block cutters ({@code docs/towngen-port.md} T1, feeding §4a's fitted subdivision). The two
 * behaviours worth pinning are that recursive bisection <b>reaches its target</b> when the block
 * can hold it, and <b>stops</b> when it cannot — a subdivision that spun trying to fit lots into a
 * sliver would be exactly the hang §5.1 forbids.
 */
class CutterTest {

	private static final double EPS = 1e-9;

	@Test
	void bisectCutsAcrossTheLongAxis() {
		Poly block = Poly.rect(0, 0, 8, 2);
		List<Poly> halves = Cutter.bisect(block, 0, 0, new Random(1L));
		assertEquals(2, halves.size());
		assertEquals(block.area(), halves.get(0).area() + halves.get(1).area(), EPS,
				"no gap asked for, so no area lost");
		for (Poly h : halves) {
			assertEquals(8.0, h.area(), EPS, "cut across the long axis, so the halves are 4x2");
			assertTrue(h.bbox().w() < h.bbox().h() * 3, "and each half is squarer than the whole");
		}
	}

	@Test
	void theGapIsTheStreetTheCutStandsFor() {
		Poly block = Poly.rect(0, 0, 8, 2);
		List<Poly> halves = Cutter.bisect(block, TownScale.STREET_REGULAR, 0, new Random(1L));
		double lost = block.area() - halves.get(0).area() - halves.get(1).area();
		assertEquals(TownScale.STREET_REGULAR * 2, lost, EPS, "street width times block depth");
	}

	@Test
	void subdivisionReachesTheTargetCountItIsGiven() {
		// §4a: the count comes from real households and buildings, so the cutter must hit it
		Poly block = Poly.rect(0, 0, 1, 1);
		for (int target : new int[] {1, 2, 5, 12, 30}) {
			List<Poly> lots = Cutter.subdivide(block, target, TownScale.STREET_ALLEY,
					new Random(20260727L));
			assertTrue(lots.size() >= target, "asked " + target + ", got " + lots.size());
			for (Poly lot : lots) {
				assertTrue(lot.area() > 0, "no zero-area lots");
			}
		}
	}

	@Test
	void subdivisionStopsInsteadOfSpinningOnABlockTooSmall() {
		Poly tiny = Poly.rect(0, 0, 0.05, 0.05);      // area 0.0025, below MIN_BLOCK_AREA
		List<Poly> lots = Cutter.subdivide(tiny, 50, TownScale.STREET_ALLEY, new Random(1L));
		assertTrue(lots.size() < 50, "reports what fits rather than inventing slivers");
		assertTrue(lots.size() >= 1);
	}

	@Test
	void subdivisionIsReproducible() {
		Poly block = Poly.rect(0, 0, 2, 1);
		List<Poly> a = Cutter.subdivide(block, 9, TownScale.STREET_ALLEY, new Random(5L));
		List<Poly> b = Cutter.subdivide(block, 9, TownScale.STREET_ALLEY, new Random(5L));
		assertEquals(a.size(), b.size());
		for (int i = 0; i < a.size(); i++) {
			assertEquals(a.get(i).points(), b.get(i).points());
		}
	}

	@Test
	void subdividedLotsStayInsideTheBlockAndDoNotOverlap() {
		Poly block = Poly.rect(0, 0, 1, 1);
		List<Poly> lots = Cutter.subdivide(block, 16, TownScale.STREET_ALLEY, new Random(3L));
		double sum = 0;
		for (Poly lot : lots) {
			sum += lot.area();
			for (Pt p : lot.points()) {
				assertTrue(p.x() >= -EPS && p.x() <= 1 + EPS && p.y() >= -EPS && p.y() <= 1 + EPS,
						"lot vertex escaped the block: " + p);
			}
		}
		assertTrue(sum < block.area(), "the alleys took their share");
		assertTrue(sum > block.area() * 0.5, "but not most of it: " + sum);
	}

	@Test
	void ringPeelsABandAndLeavesACore() {
		Poly block = Poly.rect(0, 0, 4, 4);
		List<Poly> parts = Cutter.ring(block, 1);
		assertEquals(5, parts.size(), "the core plus one piece per edge");
		assertEquals(4.0, parts.get(0).area(), EPS, "4x4 ringed by 1 leaves a 2x2 core");
		double band = 0;
		for (int i = 1; i < parts.size(); i++) {
			band += parts.get(i).area();
		}
		assertEquals(12.0, band, EPS, "and the band is the rest of it");
	}

	@Test
	void ringThatSwallowsTheBlockLeavesNoCore() {
		List<Poly> parts = Cutter.ring(Poly.rect(0, 0, 1, 1), 0.6);
		assertTrue(parts.get(0).isEmpty(), "an over-wide band degrades to no core, not a throw");
	}

	@Test
	void radialCutsWedgesAroundAFocus() {
		Poly block = Poly.rect(0, 0, 4, 4);
		List<Poly> wedges = Cutter.radial(block, new Pt(2, 2), 4, 0, 0);
		assertEquals(4, wedges.size());
		double sum = 0;
		for (Poly w : wedges) {
			sum += w.area();
			assertTrue(w.isConvex());
		}
		assertEquals(block.area(), sum, 1e-6, "four quarters, no gap, so nothing is lost");
	}

	@Test
	void radialWithLanesLosesExactlyTheLanes() {
		Poly block = Poly.rect(0, 0, 4, 4);
		double sum = 0;
		for (Poly w : Cutter.radial(block, new Pt(2, 2), 4, 0.2, 0)) {
			sum += w.area();
		}
		assertTrue(sum < block.area(), "the lanes took area");
		assertTrue(sum > block.area() * 0.7, "but the wedges are still the bulk of it");
	}

	@Test
	void degenerateInputsComeBackUnchanged() {
		assertEquals(1, Cutter.bisect(Poly.EMPTY, 0, 0, new Random(1L)).size());
		assertEquals(1, Cutter.radial(Poly.rect(0, 0, 1, 1), Pt.ZERO, 1, 0, 0).size());
		assertTrue(Cutter.subdivide(Poly.EMPTY, 5, 0, new Random(1L)).isEmpty());
	}
}
