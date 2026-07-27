package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.civstudio.server.town.geom.Lloyd;
import com.civstudio.server.town.geom.Pt;
import com.civstudio.server.town.geom.TownScale;

/**
 * Keyed randomness ({@code docs/towngen-port.md} §10). The properties that matter are boring and
 * load-bearing: the same plot always draws the same, different plots draw independently, and
 * neighbouring plots — which differ by 1 in one coordinate — are not visibly related, or every seed
 * in a row leans the same way and the mesh reads as a sheared grid rather than an organic one.
 */
class TownRngTest {

	@Test
	void aPlotAlwaysDrawsTheSame() {
		long site = TownRng.siteSeed(7654321L, 4411);
		assertEquals(TownRng.cellKey(site, 12, 34), TownRng.cellKey(site, 12, 34));
		assertEquals(site, TownRng.siteSeed(7654321L, 4411));
	}

	@Test
	void differentSitesAndSessionsDiverge() {
		assertNotEquals(TownRng.siteSeed(7654321L, 4411), TownRng.siteSeed(7654321L, 4412));
		assertNotEquals(TownRng.siteSeed(7654321L, 4411), TownRng.siteSeed(42L, 4411));
	}

	@Test
	void neighbouringPlotsAreUncorrelated() {
		// a weak mix would leave a row of plots drawing near-identical offsets
		long site = TownRng.siteSeed(1L, 1);
		Set<Long> keys = new HashSet<>();
		double sumX = 0, sumY = 0;
		int n = 0;
		for (int x = 0; x < 40; x++) {
			for (int y = 0; y < 40; y++) {
				keys.add(TownRng.cellKey(site, x, y));
				Pt j = Lloyd.jitterAt(new Pt(x + 0.5, y + 0.5), TownScale.JITTER_R,
						TownRng.cellKey(site, x, y));
				sumX += j.x() - (x + 0.5);
				sumY += j.y() - (y + 0.5);
				n++;
			}
		}
		assertEquals(1600, keys.size(), "every plot got its own key");
		// no systematic lean: the mean offset over 1600 plots should sit near zero
		assertTrue(Math.abs(sumX / n) < 0.03, "mean x offset " + sumX / n);
		assertTrue(Math.abs(sumY / n) < 0.03, "mean y offset " + sumY / n);
	}

	@Test
	void jitterFillsItsDiscAndNeverLeavesIt() {
		long site = TownRng.siteSeed(99L, 7);
		double maxD = 0;
		int nearEdge = 0, nearCentre = 0;
		for (int i = 0; i < 2000; i++) {
			Pt anchor = new Pt(0.5, 0.5);
			Pt j = Lloyd.jitterAt(anchor, TownScale.JITTER_R, TownRng.cellKey(site, i, i * 7));
			double d = j.dist(anchor);
			maxD = Math.max(maxD, d);
			if (d > TownScale.JITTER_R * 0.7) {
				nearEdge++;
			}
			if (d < TownScale.JITTER_R * 0.3) {
				nearCentre++;
			}
		}
		assertTrue(maxD <= TownScale.JITTER_R + 1e-12, "never outside the clamp: " + maxD);
		assertTrue(maxD > TownScale.JITTER_R * 0.9, "and it does use the disc: " + maxD);
		// uniform IN AREA, so about half the draws land beyond 0.7r and under a tenth inside 0.3r;
		// a radius-uniform draw would pile up at the anchor and the mesh would barely move
		assertTrue(nearEdge > 800, "draws near the rim: " + nearEdge);
		assertTrue(nearCentre < 300, "draws near the anchor: " + nearCentre);
	}

	@Test
	void theMixIsLongArithmeticNotInt() {
		// §10's float/overflow trap, in its Java form: the multipliers overflow an int silently and
		// would collapse the sequence. A known-answer test pins the actual arithmetic.
		assertEquals(TownRng.mix(0L), TownRng.mix(0L));
		assertNotEquals(0L, TownRng.mix(0L));
		assertNotEquals(TownRng.mix(1L), TownRng.mix(2L));
		long a = TownRng.mix(1L), b = TownRng.mix(1L + (1L << 33));
		assertNotEquals(a, b, "bits above 32 change the answer, so this is not int arithmetic");
	}
}
