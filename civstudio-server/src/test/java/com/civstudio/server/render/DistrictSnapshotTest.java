package com.civstudio.server.render;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDate;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.Province;
import com.civstudio.settlement.GameSession;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.PlotOccupant;
import com.civstudio.settlement.Settlement;
import com.civstudio.tech.TechEffect;

/**
 * Verifies the Phase D3 district projection ({@code docs/district-buildout.md}): a colony's
 * {@link ColonyView} carries its starting district count, its culture, and the buildings
 * auto-build placed on its district plots, all the way through {@link Snapshots#of}.
 */
class DistrictSnapshotTest {

	private static final LocalDate START = LocalDate.of(1444, 12, 11);

	private static ColonyView project(Settlement c) {
		return Snapshots.of("t", 42, "test", "RUNNING", "LIVE", null, 0, c.getDate(), List.of(c), null,
				List.of(), List.of(), List.of()).colonies().get(0);
	}

	@Test
	void carriesStartingDistrictsAndCulture() {
		GameSession s = new GameSession(42);
		Province dh = s.getWorldMap().findByName("Dhenijansar").orElseThrow();
		Settlement c = s.newSettlement("Test", START, 30, 26, 5, 2, dh);

		ColonyView view = project(c);
		assertEquals(c.getStartingDistrictCount(), view.startingDistricts());
		assertTrue(view.startingDistricts() > 0, "the demo province carries EU4 development");
		assertNotNull(view.culture(), "a province-founded colony reports its culture");
		assertTrue(view.districts().isEmpty(), "no buildings placed yet → no district rows");
	}

	@Test
	void carriesTheCityCenterPlotNotTheProvinceAnchor() {
		GameSession s = new GameSession(42);
		Province dh = s.getWorldMap().findByName("Dhenijansar").orElseThrow();
		Settlement c = s.newSettlement("Test", START, 30, 26, 5, 2, dh);
		c.claimPlot(new PlotOccupant() {
		}); // lay plot 0 (the village center)

		ColonyView view = project(c);
		Plot center = c.getCityCenter();
		assertNotNull(center, "the colony laid its center plot");
		assertEquals(center.x(), view.centerX(), "the view reports the center plot's raster x");
		assertEquals(center.y(), view.centerY(), "the view reports the center plot's raster y");
		// the whole point of the field: lat/lon are the PROVINCE's anchor, so a client deriving the
		// centre from them can land on the wrong plot (docs/urban-plots.md). The centre is the
		// water-first pick, which need not be the plot under the province point.
		assertTrue(center.river() || center.coast() != 0 || center.riverAdj() != 0,
				"the water-first centre sits on or beside water");
	}

	@Test
	void reportsNoCenterBeforeAPlotIsLaid() {
		GameSession s = new GameSession(42);
		Province dh = s.getWorldMap().findByName("Dhenijansar").orElseThrow();
		Settlement c = s.newSettlement("Test", START, 30, 26, 5, 2, dh);

		ColonyView view = project(c);
		assertNull(view.centerX(), "no plot laid → no centre to report");
		assertNull(view.centerY());
	}

	@Test
	void projectsAutoBuiltBuildingsOntoTheCenterDistrict() {
		GameSession s = new GameSession(42);
		Province dh = s.getWorldMap().findByName("Dhenijansar").orElseThrow();
		Settlement c = s.newSettlement("Test", START, 30, 26, 5, 2, dh);
		c.claimPlot(new PlotOccupant() {
		}); // lay plot 0 (the village center)
		c.setAutoBuildDistricts(true);
		c.applyTechEffect(new TechEffect.Unlock("BUILDING_ORCHARD"));

		ColonyView view = project(c);
		assertFalse(view.districts().isEmpty(), "the auto-built building shows in the feed");
		DistrictView center = view.districts().get(0);
		assertEquals(0, center.index(), "it lands at the village center, plot 0");
		assertTrue(center.buildings().stream().anyMatch(b -> "BUILDING_ORCHARD".equals(b.id())));
	}

	@Test
	void projectsEveryPlotWithItsRasterCoordinates() {
		GameSession s = new GameSession(42);
		Province dh = s.getWorldMap().findByName("Dhenijansar").orElseThrow();
		Settlement c = s.newSettlement("Test", START, 30, 26, 5, 2, dh);
		c.claimPlot(new PlotOccupant() {
		});
		c.claimPlot(new PlotOccupant() {
		});

		ColonyView view = project(c);
		// EVERY plot projects, built or not — the city screen lays out the whole settlement
		assertEquals(c.getDistrictPlots().size(), view.districts().size(),
				"every plot of the colony is projected, not only the built ones");
		for (int i = 0; i < view.districts().size(); i++) {
			DistrictView d = view.districts().get(i);
			var plot = c.getDistrictPlots().get(i);
			// the coordinates are the whole point: without them a client cannot draw a building on
			// the plot it stands on, and everything piles onto the city center
			assertEquals(plot.x(), d.x(), "plot " + i + " reports its raster x");
			assertEquals(plot.y(), d.y(), "plot " + i + " reports its raster y");
		}
	}

	/**
	 * The improvement leg (docs/terrain-3d.md §P5a). Undeveloped ground reports {@code null}; a plot
	 * the sim has developed reports the bare {@code IMPROVEMENT_*} key. This is the ONLY path by
	 * which an improvement can reach a client — the baked world plot data carries none, improvements
	 * being built by the sim rather than world-invariant — so the sprites drew nothing until it
	 * existed.
	 */
	@Test
	void projectsTheImprovementRaisedOnAPlot() {
		GameSession s = new GameSession(42);
		Province dh = s.getWorldMap().findByName("Dhenijansar").orElseThrow();
		Settlement c = s.newSettlement("Test", START, 30, 26, 5, 2, dh);
		c.claimPlot(new PlotOccupant() {
		});

		assertNull(project(c).districts().get(0).improvement(), "undeveloped ground reports no improvement");

		Plot p = c.getDistrictPlots().get(0);
		p.raiseImprovement(s.getTerrainRegistry().improvement("IMPROVEMENT_FARM"), true);

		assertEquals("IMPROVEMENT_FARM", project(c).districts().get(0).improvement(),
				"a developed plot reports its improvement's Civ4 type key, verbatim");
	}
}
