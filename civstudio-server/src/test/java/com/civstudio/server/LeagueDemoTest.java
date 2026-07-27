package com.civstudio.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.civstudio.scenario.LeagueFlavor;
import com.civstudio.server.town.ColonyFootprint;
import com.civstudio.server.town.Footprint;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.Settlement;

/**
 * The <b>league demo</b> — the live demo since 2026-07-28: the League of Nathalaire, its lead city
 * and nine vassal mayors around one bay.
 * <p>
 * {@code docs/city-and-league.md} settles why this is a league rather than one city with quarters,
 * and {@code docs/towngen-port.md} §2c is the hand-drawn map it is modelled on. Nathalaire proper
 * keeps province 451 and its 63 plots to itself; the vassal cities found into its land neighbours,
 * staying adjacent to it — a conurbation, which is what the site's ADM-heavy development calls for.
 */
class LeagueDemoTest {

	private static final int NATHALAIRE = 451;

	private static HostedSession league() {
		return new SessionHost().create(SessionSpec.leagueDemo(42, NATHALAIRE));
	}

	@Test
	void theDemoFoundsALeagueOfCitiesAroundOneSite() {
		// TEN is the target (the lead city and nine vassal mayors), and the site cannot hold them
		// yet: the engine caps a settlement at its province's plot count and the cities share one
		// pool, so each province seats one city. Nathalaire proper plus its three land neighbours
		// is what the map affords today — see docs/city-and-league.md §Founding a league.
		HostedSession hs = league();
		assertTrue(hs.colonies().size() >= 3,
				"a league is several cities: " + hs.colonies().size());
		assertEquals(NATHALAIRE, hs.colonies().get(0).getProvince().id(),
				"the lead city holds the site itself");
		for (Settlement c : hs.colonies()) {
			assertNotNull(c.getRuler(), c.getName() + " has no crown");
		}
		for (Settlement vassal : hs.colonies().subList(1, hs.colonies().size())) {
			assertNotEquals(NATHALAIRE, vassal.getProvince().id(),
					"Nathalaire's 63 plots belong to Nathalaire proper");
		}
	}

	@Test
	void vassalageBetweenCitiesIsNotExpressibleYet() {
		// The league founds asking each vassal's crown to take the lead city's crown as its liege,
		// and the link does not take: Ruler.isSovereign() is hardcoded true, so a crown has no
		// liege by construction. The household liege link (docs/estate-system.md P3) models
		// ruler -> nobles -> peasants WITHIN one colony; a Legate over Mayors is the rank ladder's
		// job (docs/city-and-league.md), not something to fake here. Pinned as a known gap so the
		// day it is implemented, this test says so.
		HostedSession hs = league();
		Settlement lead = hs.colonies().get(0);
		for (Settlement vassal : hs.colonies().subList(1, hs.colonies().size())) {
			assertNull(vassal.getRuler().getLiege(),
					"a crown is sovereign by construction — see docs/city-and-league.md");
		}
		assertNull(lead.getRuler().getLiege());
	}

	@Test
	void eachCityStandsOnItsOwnGround() {
		// the division the league forces: getStartingDistrictCount is derived from the PROVINCE's
		// development, so without a partition all ten cities would claim the same 27 plots and ten
		// towns would draw on top of one another
		HostedSession hs = league();
		List<Settlement> cities = hs.colonies();
		Set<Cell> taken = new HashSet<>();
		int total = 0;
		for (Settlement c : cities) {
			Footprint fp = ColonyFootprint.of(c, hs.session().plotPoolIfPresent(NATHALAIRE), cities);
			total += fp.size();
			for (Cell cell : fp.allCells()) {
				assertTrue(taken.add(cell), "plot " + cell + " is claimed by two cities");
			}
		}
		assertTrue(total > cities.size(), "and every city is more than its centre: " + total);
		assertTrue(total > 0, "and the league stands on real ground: " + total);
	}

	@Test
	void everyCityHasItsOwnCentreAndItsOwnName() {
		HostedSession hs = league();
		Set<String> names = new HashSet<>();
		Set<Cell> centres = new HashSet<>();
		for (Settlement c : hs.colonies()) {
			Plot centre = c.getCityCenter();
			assertNotNull(centre, c.getName() + " laid no centre");
			assertTrue(centres.add(new Cell(centre.x(), centre.y())),
					"two cities share a centre plot");
			assertTrue(names.add(c.getName()), "two cities share the name " + c.getName());
		}
	}

	@Test
	void nathalaireIsAnAdministrativeLeagueSoItIsAConurbation() {
		// the flavour is read off the site's own development split, not chosen: Nathalaire is
		// 10/10/7 (ADM/DIP/MIL), so it grows together rather than scattering along a coast
		HostedSession hs = league();
		LeagueFlavor flavor = LeagueFlavor.of(hs.session().getWorldMap().province(NATHALAIRE));
		assertEquals(LeagueFlavor.ADM, flavor);
		assertTrue(flavor.isContiguous());
	}

	@Test
	void theSameSpecFoundsTheSameLeague() {
		List<String> a = league().colonies().stream().map(Settlement::getName).toList();
		List<String> b = league().colonies().stream().map(Settlement::getName).toList();
		assertEquals(a, b, "a league is as reproducible as any other founding");
	}
}
