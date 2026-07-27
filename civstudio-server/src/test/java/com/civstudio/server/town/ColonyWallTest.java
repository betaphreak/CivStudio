package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDate;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.Province;
import com.civstudio.server.town.TownWall.Gate;
import com.civstudio.server.town.TownWall.Kind;
import com.civstudio.server.town.TownWall.Segment;
import com.civstudio.settlement.GameSession;
import com.civstudio.settlement.PlotOccupant;
import com.civstudio.settlement.Settlement;
import com.civstudio.settlement.SettlementTier;

/**
 * Fortification against a real colony on the canonical site — <b>Nathalaire</b> (§9), the pirate
 * city we have a hand-drawn reference for. It is founded water-first and sits in a bay, so it is
 * the case that exercises quay and river-gate classification off real plot masks rather than off a
 * test double — and the reference says the answer should be "mostly waterfront".
 */
class ColonyWallTest {

	private static final LocalDate START = LocalDate.of(1444, 12, 11);

	private record Founded(GameSession session, Settlement colony, Province province) {
	}

	private static Founded found() {
		GameSession s = new GameSession(42);
		Province dh = s.getWorldMap().findByName("Nathalaire").orElseThrow();
		Settlement c = s.newSettlement("Nathalaire", START, 30, 26, 5, 2, dh);
		c.claimPlot(new PlotOccupant() {
		});
		return new Founded(s, c, dh);
	}

	private static TownWall wallOf(Founded f) {
		Footprint fp = ColonyFootprint.of(f.colony(), f.session().plotPoolIfPresent(f.province().id()));
		return ColonyWall.of(f.colony(), f.session().plotPoolIfPresent(f.province().id()),
				f.session().getWorldMap(), fp);
	}

	@Test
	void aMetropolisIsWalledAndItsWallIsMadeOfItsPlots() {
		Founded f = found();
		TownWall w = wallOf(f);
		assertEquals(SettlementTier.METROPOLIS, f.colony().getTier());
		assertTrue(w.walled(), "a permanent settlement of 27 plots is walled");
		assertFalse(w.segments().isEmpty());
		for (Segment s : w.segments()) {
			assertTrue(w.encloses(s.cell()), "every wall piece belongs to an enclosed plot");
			assertEquals(1.0, s.a().dist(s.b()), 1e-9);
		}
		assertEquals(27, w.core().size(), "the 32-plot cap does not bite on a 27-plot town");
	}

	@Test
	void aWaterFirstSiteFrontsTheWaterWithQuayNotCurtain() {
		// CityPlacement founds water-first, so a real site almost always has a wet edge; reading it
		// off the plots' own coast mask is what keeps the line honest
		TownWall w = wallOf(found());
		long wet = w.segments().stream().filter(s -> s.kind() == Kind.QUAY
				|| s.kind() == Kind.RIVER_GATE).count();
		long dry = w.segments().stream().filter(s -> s.kind() == Kind.CURTAIN).count();
		assertTrue(wet > 0, "a water-first town has a waterfront: " + summarise(w));
		assertTrue(wet < w.segments().size(), "but it is not all waterfront: " + summarise(w));
		// and the reference picture's answer, arrived at with nothing in the code knowing this is a
		// pirate city: Nathalaire's line is overwhelmingly quay, with a short landward stretch
		assertTrue(wet > dry * 2, "a city in a bay is mostly quay: " + summarise(w));
	}

	@Test
	void gatesComeFromTheNeighboursRealBorderCrossings() {
		TownWall w = wallOf(found());
		assertFalse(w.gates().isEmpty(), "roads leave this province: " + summarise(w));
		for (Gate g : w.gates()) {
			assertEquals(Kind.ROAD_GATE, g.segment().kind());
			assertTrue(w.encloses(g.segment().cell()));
			assertNotEquals(null, g.toward(), "a gate knows which neighbour it faces");
		}
		for (int i = 0; i < w.gates().size(); i++) {
			for (int j = i + 1; j < w.gates().size(); j++) {
				assertNotEquals(w.gates().get(i).segment(), w.gates().get(j).segment(),
						"two neighbours never share one gate");
			}
		}
	}

	@Test
	void theSameColonyFortifiesTheSameWayTwice() {
		assertEquals(wallOf(found()).segments(), wallOf(found()).segments());
	}

	@Test
	void aSubTownSettlementGetsNoWall() {
		Founded f = found();
		f.colony().setTier(SettlementTier.HAMLET);
		assertFalse(wallOf(f).walled(), "walls are for permanent settlements only (§1)");
	}

	private static String summarise(TownWall w) {
		long curtain = w.segments().stream().filter(s -> s.kind() == Kind.CURTAIN).count();
		long quay = w.segments().stream().filter(s -> s.kind() == Kind.QUAY).count();
		long river = w.segments().stream().filter(s -> s.kind() == Kind.RIVER_GATE).count();
		return w.segments().size() + " segments (" + curtain + " curtain, " + quay + " quay, "
				+ river + " river gate), " + w.gates().size() + " road gates";
	}
}
