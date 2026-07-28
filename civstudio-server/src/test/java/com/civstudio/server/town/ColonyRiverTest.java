package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDate;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.civstudio.geo.Province;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Poly;
import com.civstudio.settlement.DistrictType;
import com.civstudio.settlement.GameSession;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.PlotOccupant;
import com.civstudio.settlement.ProvincePlotPool;
import com.civstudio.settlement.Settlement;

/**
 * The water against real colonies ({@code docs/towngen-port.md} T4b) — <b>Dhenijansar</b> for the
 * channel, because it is the plan's river capital (§9: 21 curtain, 3 river gates, no quay at all),
 * and <b>Nathalaire</b> for the waterfront, because it is the opposite case (20 quay, 5 curtain).
 * Between them they cover both halves of §7a: a river that cuts through plots and a coast that runs
 * along their edges.
 */
class ColonyRiverTest {

	private static final LocalDate START = LocalDate.of(1444, 12, 11);

	private record Founded(GameSession session, Settlement colony, Province province) {

		ProvincePlotPool pool() {
			return session.plotPoolIfPresent(province.id());
		}

		Footprint footprint() {
			return ColonyFootprint.of(colony, pool());
		}

		long seed() {
			return TownRng.siteSeed(session.getSeed(), province.id());
		}
	}

	private static Founded found(String name) {
		GameSession s = new GameSession(42);
		Province p = s.getWorldMap().findByName(name).orElseThrow();
		Settlement c = s.newSettlement(name, START, 30, 26, 5, 2, p);
		c.claimPlot(new PlotOccupant() {
		});
		return new Founded(s, c, p);
	}

	private static TownRiver river(Founded f) {
		return TownRiver.of(f.footprint(), ColonySite.of(f.colony(), f.pool(), null));
	}

	// --- the channel, on a river capital ------------------------------------------------------

	@Test
	void aRiverCapitalHasAChannelRunningThroughItsPlots() {
		Founded f = found("Dhenijansar");
		TownRiver r = river(f);
		assertFalse(r.isEmpty(), "the plan's river capital has a river: " + r.diag());
		for (Cell c : r.chords().keySet()) {
			assertTrue(f.footprint().allCells().contains(c), "the channel stays in town: " + c);
		}
		assertTrue(r.diag().interesting());
	}

	@Test
	void theChannelAgreesWithThePlotsOwnRiverState() {
		// the engine has already decoded this — Plot carries river()/riverAdj() as fields, which is
		// why T4b ports no decoder (§8b). This asserts the adapter reads the same fields the wall's
		// river gates read, so a water gate and a channel can never disagree about where the water is.
		Founded f = found("Dhenijansar");
		TownRiver r = river(f);
		for (Plot p : f.pool().plots()) {
			Cell c = new Cell(p.x(), p.y());
			if (!f.footprint().allCells().contains(c)) {
				continue;
			}
			boolean traced = r.runsThrough(c);
			boolean flows = p.river() && p.riverAdj() != 0;
			assertEquals(flows, traced, "the channel and the plot agree at " + c);
		}
	}

	@Test
	void lotsStandBackFromTheWaterRatherThanInIt() {
		// the point of the whole phase: a plot the river crosses gives up the channel and its banks
		Founded f = found("Dhenijansar");
		TownRiver r = river(f);
		TownMesh mesh = TownMesh.of(f.footprint(), f.seed());
		Cell wet = r.chords().keySet().stream().filter(c -> !r.isChannel(c)).findFirst().orElseThrow();
		Poly block = mesh.byCell().get(wet).poly().inset(TownLots.WARD_MARGIN);

		List<Poly> banks = r.banks(wet, block);
		assertFalse(banks.isEmpty(), "a reach still has banks to build on");
		double dry = banks.stream().mapToDouble(Poly::area).sum();
		assertTrue(dry < block.area(), "the channel took its share: " + dry + " of " + block.area());
	}

	@Test
	void aRiverTownBuildsOnBothItsBanks() {
		Founded f = found("Dhenijansar");
		TownRiver r = river(f);
		TownMesh mesh = TownMesh.of(f.footprint(), f.seed());
		int twoSided = 0;
		for (Cell c : r.chords().keySet()) {
			if (r.isChannel(c)) {
				continue;
			}
			Poly block = mesh.byCell().get(c).poly().inset(TownLots.WARD_MARGIN);
			if (r.banks(c, block).size() == 2) {
				twoSided++;
			}
		}
		assertTrue(twoSided > 0, "at least one reach is built on from both sides");
	}

	@Test
	void theStreetsBridgeWhereTheChannelCrossesThem() {
		// T5 already paid the crossing; T4b turns the price into a PLACE. The bridge is the shared
		// edge midpoint of the two plots the street steps between — exactly where the river's own
		// centre-line crosses that edge, so it lands on the channel by construction.
		Founded f = found("Dhenijansar");
		Footprint fp = f.footprint();
		TownMesh mesh = TownMesh.of(fp, f.seed());
		TownWall wall = ColonyWall.of(f.colony(), f.pool(), f.session().getWorldMap(), fp);
		TownStreets streets = ColonyStreets.of(f.colony(), f.pool(), f.session().getWorldMap(), fp,
				mesh, wall);
		TownRiver r = river(f);
		for (TownStreets.Street s : streets.streets()) {
			assertEquals(s.crossings(), s.bridges().size(), "every crossing has a place");
			for (var at : s.bridges()) {
				// a plot-edge midpoint has exactly one half-integer coordinate
				boolean onAnEdge = Math.abs(at.x() % 1.0) < 1e-9 || Math.abs(at.y() % 1.0) < 1e-9;
				assertTrue(onAnEdge, "a bridge stands on a plot edge: " + at);
			}
		}
		assertFalse(r.isEmpty(), "and there is water here to bridge");
	}

	// --- the waterfront, on a pirate city -----------------------------------------------------

	@Test
	void aPirateCityGetsItsWharves() {
		// §7a's harbour ward: it needs T4's quay, and Nathalaire's line is 20 quay to 5 curtain
		Founded f = found("Nathalaire");
		Footprint fp = f.footprint();
		TownWall wall = ColonyWall.of(f.colony(), f.pool(), f.session().getWorldMap(), fp);
		ColonySite site = ColonySite.of(f.colony(), f.pool(), null);
		Cell centre = new Cell(f.colony().getCityCenter().x(), f.colony().getCityCenter().y());
		TownWards wards = TownWards.of(fp, wall, TownStreets.NONE, centre, site, f.seed());

		assertEquals(1, wards.diag().counts().getOrDefault(DistrictType.HARBOR, 0),
				"the pirate city has a waterfront: " + wards.diag());
		Cell wharves = wards.wards().entrySet().stream()
				.filter(e -> e.getValue() == DistrictType.HARBOR).map(java.util.Map.Entry::getKey)
				.findFirst().orElseThrow();
		assertTrue(site.coastEdges(wharves) > 0, "and it stands on ground that fronts water");
	}

	@Test
	void aCoastalCityNeedNotHaveARiverAndSaysSo() {
		// the two halves of §7a are genuinely independent: Nathalaire is all shoreline and (per the
		// wall's own reading) no channel, so the river stage must come back empty rather than
		// inventing water to match the quay
		Founded f = found("Nathalaire");
		ColonySite site = ColonySite.of(f.colony(), f.pool(), null);
		int wet = 0;
		for (Cell c : f.footprint().allCells()) {
			if (site.coastEdges(c) > 0) {
				wet++;
			}
		}
		assertTrue(wet > 0, "it is a coastal city");
		TownRiver r = river(f);
		assertEquals(r.chords().size(), r.diag().reaches(), "whatever the river is, it is consistent");
	}
}
