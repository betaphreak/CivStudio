package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDate;
import java.util.HashSet;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.Province;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Poly;
import com.civstudio.settlement.GameSession;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.PlotOccupant;
import com.civstudio.settlement.ProvincePlotPool;
import com.civstudio.settlement.Settlement;
import com.civstudio.settlement.SettlementTier;

/**
 * The footprint against real colonies, on the two sites {@code docs/towngen-port.md} §9 names.
 * <p>
 * <b>Nathalaire</b> (province 451, the pirate city on the Sea of Follies) is the canonical one,
 * because we have a hand-drawn reference for it (§2c): development 27 on 63 plots, sitting in a bay,
 * so it is also the site that exercises a waterfront.
 * <p>
 * <b>Dhenijansar</b> (4411, the Raj's capital) is kept as a second case — development 30 on 74
 * plots, in Haless rather than Cannor — and a third test goes looking for a province that is
 * <em>no city at all</em>, where only one plot is flagged urban and the starting core must reach
 * past it.
 */
class ColonyFootprintTest {

	private static final LocalDate START = LocalDate.of(1444, 12, 11);

	private record Founded(Settlement colony, ProvincePlotPool pool) {
	}

	private static Founded found(long seed) {
		return found(seed, "Nathalaire");
	}

	private static Founded found(long seed, String site) {
		GameSession s = new GameSession(seed);
		Province p = s.getWorldMap().findByName(site).orElseThrow();
		Settlement c = s.newSettlement("Test", START, 30, 26, 5, 2, p);
		c.claimPlot(new PlotOccupant() {
		});                                                  // lay the city centre
		return new Founded(c, s.plotPoolIfPresent(p.id()));
	}

	@Test
	void aFoundedCityStandsOnItsStartingCore() {
		Founded f = found(42);
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());

		Plot centre = f.colony().getCityCenter();
		assertNotNull(centre);
		assertTrue(fp.size() >= 1, "a founded colony stands on something: " + fp.diag());
		assertTrue(fp.cellSet().contains(new Cell(centre.x(), centre.y())),
				"the city centre is part of the town however the ranking falls");
		assertTrue(fp.size() <= f.colony().getStartingDistrictCount() + 1,
				"and no more than its 1444 development allows");
	}

	@Test
	void nathalaireIsAWholeCityOnDayOneNotASingleHut() {
		// §2.1's whole argument, as an assertion. The sim has claimed exactly one plot here; if the
		// starting core were ever dropped from the union, this falls to a one-plot town and a city
		// of 27 development would be walled as a hut.
		Founded f = found(42);
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());
		assertEquals(1, f.colony().getDistrictPlots().size(), "the sim has claimed only the centre");
		assertEquals(27, f.colony().getStartingDistrictCount(), "dev 27, under the 63-plot cap");
		assertEquals(27, fp.size(), "so the town stands on all 27: " + fp.diag());
		assertTrue(fp.outer().size() > 4,
				"and its outline is an irregular polyomino, not a box: " + fp.outer().size()
						+ " vertices");
	}

	@Test
	void anOrdinaryProvinceIsNotLimitedToItsOneUrbanPlot() {
		// the trap this caught. CityPlacement flags every plot urban only in a province that IS a
		// city (Anbennar's is_city / city_terrain); anywhere else it flags exactly ONE. Ranking the
		// starting core over urban ground alone therefore collapses every ordinary site — however
		// developed — to a single hut. Nathalaire and Dhenijansar are both cities and both hide it,
		// so this test goes looking for a province that is not.
		GameSession s = new GameSession(42);
		Province rural = s.getWorldMap().provinces().stream()
				.filter(p -> !p.city() && p.isSettleable() && p.development() >= 8 && p.plots() >= 12)
				.findFirst().orElseThrow();
		Settlement c = s.newSettlement("Rural", START, 30, 26, 5, 2, rural);
		c.claimPlot(new PlotOccupant() {
		});
		// a colony founded outside a city site starts below TOWN, where the starting core is one
		// plot by design (a village IS one plot). The urban-only trap bites when such a place grows
		// into a city, so grow it.
		c.setTier(SettlementTier.METROPOLIS);
		ProvincePlotPool pool = s.plotPoolIfPresent(rural.id());
		long urban = pool.plots().stream().filter(Plot::urban).count();
		assertEquals(1, urban, rural.name() + " is no city, so it has one urban plot");
		assertTrue(c.getStartingDistrictCount() > 1, "but it does carry 1444 development");
		assertEquals(c.getStartingDistrictCount(), ColonyFootprint.of(c, pool).size(),
				"and its town is its whole development, not its one urban plot");
	}

	@Test
	void anAllUrbanCityTerrainSiteStillWorks() {
		// the other regime: Dhenijansar flags all 74 of its plots urban
		Founded f = found(42, "Dhenijansar");
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());
		assertEquals(30, f.colony().getStartingDistrictCount(), "dev 30, capped by 74 plots");
		assertEquals(30, fp.size(), fp.diag().toString());
	}

	@Test
	void theOutlineEnclosesExactlyTheFootprint() {
		Footprint fp = ColonyFootprint.of(found(42).colony(), found(42).pool());
		double enclosed = fp.outer().signedArea();
		for (Poly hole : fp.waterHoles()) {
			enclosed += hole.signedArea();
		}
		assertEquals(fp.size(), enclosed, 1e-9, "wall encloses plots, lakes do not count as town");
		assertTrue(fp.diag().singleOuterLoop(), "one town, one wall line: " + fp.diag());
	}

	@Test
	void everyFootprintCellIsRealLandInTheProvince() {
		Founded f = found(42);
		Footprint fp = ColonyFootprint.of(f.colony(), f.pool());
		Set<Cell> land = new HashSet<>();
		for (Plot p : f.pool().plots()) {
			land.add(new Cell(p.x(), p.y()));
		}
		for (Cell c : fp.cells()) {
			assertTrue(land.contains(c), "footprint cell " + c + " is not a plot of the province");
		}
	}

	@Test
	void theFootprintIsConnected() {
		// the whole point of the components pass: whatever the claim order and wherever the 1444
		// core falls, a town is one piece — a wall cannot wrap two
		Footprint fp = ColonyFootprint.of(found(7654321L).colony(), found(7654321L).pool());
		Set<Cell> cells = fp.cellSet();
		assertEquals(1, Footprint.components(cells).size(), "one clump: " + fp.diag());
	}

	@Test
	void theSameSeedGivesTheSameTown() {
		assertEquals(ColonyFootprint.of(found(42).colony(), found(42).pool()).cells(),
				ColonyFootprint.of(found(42).colony(), found(42).pool()).cells());
	}

	@Test
	void aColonyWithNoPlotYetHasNoFootprint() {
		GameSession s = new GameSession(42);
		Province dh = s.getWorldMap().findByName("Dhenijansar").orElseThrow();
		Settlement c = s.newSettlement("Unlaid", START, 30, 26, 5, 2, dh);
		Footprint fp = ColonyFootprint.of(c, s.plotPoolIfPresent(dh.id()));
		assertTrue(fp.isEmpty(), "no centre laid yet, so there is no town to draw");
		assertTrue(fp.outer().isEmpty());
	}
}
