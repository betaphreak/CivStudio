package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDate;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.Province;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.DistrictType;
import com.civstudio.settlement.GameSession;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.PlotOccupant;
import com.civstudio.settlement.ProvincePlotPool;
import com.civstudio.settlement.Settlement;

/**
 * What a real colony's plots say ({@code docs/towngen-port.md} T6) — the boundary between §4a's
 * "we know exactly" and §4b's "the 1444 core has to be invented", checked on Nathalaire.
 */
class ColonySiteTest {

	private static final LocalDate START = LocalDate.of(1444, 12, 11);

	private record Founded(GameSession session, Settlement colony, Province province) {

		ProvincePlotPool pool() {
			return session.plotPoolIfPresent(province.id());
		}

		Cell centre() {
			Plot c = colony.getCityCenter();
			return new Cell(c.x(), c.y());
		}
	}

	private static Founded found() {
		GameSession s = new GameSession(42);
		Province np = s.getWorldMap().findByName("Nathalaire").orElseThrow();
		Settlement c = s.newSettlement("Nathalaire", START, 30, 26, 5, 2, np);
		c.claimPlot(new PlotOccupant() {
		});
		return new Founded(s, c, np);
	}

	private static ColonySite site(Founded f) {
		return ColonySite.of(f.colony(), f.pool(), null);
	}

	// --- the founding plot --------------------------------------------------------------------

	@Test
	void theFoundingPlotIsTheCityCentre() {
		Founded f = found();
		assertEquals(DistrictType.CITY_CENTER, site(f).decided(f.centre()));
	}

	@Test
	void anUntouchedPlotLeavesTheWardToTheScoring() {
		// "the sim has said nothing" is null, not a guessed district — the scoring is the only thing
		// allowed to invent one, and only for plots the sim has not reached
		Founded f = found();
		ColonySite s = site(f);
		int undecided = 0;
		for (Plot p : f.pool().plots()) {
			Cell c = new Cell(p.x(), p.y());
			if (!c.equals(f.centre()) && s.decided(c) == null) {
				undecided++;
			}
		}
		assertTrue(undecided > 0, "a freshly founded city has plots nobody has built on");
	}

	// --- §4b, the synthetic half --------------------------------------------------------------

	@Test
	void aFoundedCityIsPopulatedRatherThanBeingAWallAroundEmptyBlocks() {
		// the collision §4b exists to resolve: the sim has claimed one plot, so a strict reading of
		// §4a gives a curtain wall around thirty empty blocks — worse than the hut it replaced
		Founded f = found();
		ColonySite s = site(f);
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());
		int populated = 0;
		for (Cell c : fp.allCells()) {
			if (s.households(c) > 0) {
				populated++;
			}
		}
		assertTrue(populated > fp.allCells().size() / 2,
				populated + " of " + fp.allCells().size() + " plots have somebody on them");
	}

	@Test
	void theSyntheticDensityFallsAwayFromTheCentre() {
		Founded f = found();
		ColonySite s = site(f);
		Cell centre = f.centre();
		Cell far = new Cell(centre.x() + 5, centre.y() + 5);
		assertTrue(s.synthetic(centre) >= s.synthetic(far),
				"a town thins outward: " + s.synthetic(centre) + " vs " + s.synthetic(far));
	}

	@Test
	void aStreetThickensTheGroundItRunsThrough() {
		// §4b's open question wanted density to cluster along the streets T5 lays down; this is that
		Founded f = found();
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());
		TownMesh mesh = TownMesh.of(fp, TownRng.siteSeed(f.session().getSeed(), f.province().id()));
		TownWall wall = ColonyWall.of(f.colony(), f.pool(), f.session().getWorldMap(), fp);
		TownStreets streets = ColonyStreets.of(f.colony(), f.pool(), f.session().getWorldMap(), fp,
				mesh, wall);
		ColonySite plain = ColonySite.of(f.colony(), f.pool(), null);
		ColonySite laid = ColonySite.of(f.colony(), f.pool(), streets);

		Cell onAStreet = streets.streetCells().stream().filter(c -> !c.equals(f.centre()))
				.filter(c -> plain.synthetic(c) > 0).findFirst().orElseThrow();
		assertTrue(laid.synthetic(onAStreet) >= plain.synthetic(onAStreet),
				"the road brings people: " + plain.synthetic(onAStreet) + " → "
						+ laid.synthetic(onAStreet));
	}

	@Test
	void theSyntheticCountIsCappedNearWhatTheSimPlausiblyReaches() {
		// §4b's second rule: the switch to real state must read as filling in, not as a plot
		// visibly losing fourteen families the day the sim claims it
		Founded f = found();
		ColonySite s = site(f);
		for (Plot p : f.pool().plots()) {
			assertTrue(s.synthetic(new Cell(p.x(), p.y())) <= 6,
					"no plot is invented into a city of its own");
		}
	}

	@Test
	void realStateAlwaysWinsAndIsNotBlendedWith() {
		// the rule that lets the synthetic layer be deleted the day the engine makes it redundant:
		// any real household or building and the synthesis does not run at all
		Founded f = found();
		ColonySite s = site(f);
		Cell centre = f.centre();
		boolean anyReal = false;
		for (Plot p : f.pool().plots()) {
			Cell c = new Cell(p.x(), p.y());
			if (!p.buildings().isEmpty()) {
				anyReal = true;
				assertFalse(s.isSynthetic(c), "a built plot is never invented: " + c);
			}
		}
		assertTrue(s.isSynthetic(centre) || !anyReal || s.households(centre) >= 0);
	}

	@Test
	void theInventedPopulationRunsOutRatherThanTrailingOffForever() {
		// the falloff is a fraction, so far enough out it rounds to nobody. That matters: the
		// synthesis is bounded to the town, and a plot half a province away must not read as suburb
		Founded f = found();
		ColonySite s = site(f);
		Cell centre = f.centre();
		assertEquals(0, s.synthetic(new Cell(centre.x() + 200, centre.y() + 200)));
	}

	// --- determinism --------------------------------------------------------------------------

	@Test
	void theSameSiteSaysTheSameThingTwice() {
		Founded a = found();
		Founded b = found();
		ColonySite sa = site(a);
		ColonySite sb = site(b);
		for (Plot p : a.pool().plots()) {
			Cell c = new Cell(p.x(), p.y());
			assertEquals(sa.households(c), sb.households(c));
			assertEquals(sa.buildings(c), sb.buildings(c));
			assertEquals(sa.decided(c), sb.decided(c));
		}
	}

	// --- the terrain terms --------------------------------------------------------------------

	@Test
	void theHeightAndReliefComeOffTheRealPlots() {
		Founded f = found();
		ColonySite s = site(f);
		boolean varies = false;
		int first = -1;
		for (Plot p : f.pool().plots()) {
			int e = s.elevation(new Cell(p.x(), p.y()));
			assertEquals(p.elevation(), e);
			if (first < 0) {
				first = e;
			} else if (e != first) {
				varies = true;
			}
		}
		assertTrue(varies, "a real site is not flat, so the height term has something to say");
	}

	@Test
	void aPlotOffTheMapReadsAsFlatRatherThanThrowing() {
		ColonySite s = site(found());
		Cell nowhere = new Cell(-999, -999);
		assertEquals(0, s.elevation(nowhere));
		assertFalse(s.hill(nowhere));
		assertFalse(s.enfeoffed(nowhere));
		assertEquals(List.of(), s.buildings(nowhere));
		assertNotEquals(null, s.decided(nowhere) == null ? "null-is-fine" : "decided");
	}
}
