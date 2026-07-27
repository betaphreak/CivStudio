package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.ProvincePlotPool;
import com.civstudio.settlement.Settlement;

/**
 * The engine-facing half of the footprint ({@code docs/towngen-port.md} §2.1) — the one place that
 * answers "how big is this city" from live sim state, so that nothing else has to guess.
 * <p>
 * <b>The footprint is a union, and §2.1 explains why.</b> There are two answers to a colony's
 * extent today and they disagree: the renderer lights {@code startingDistricts} urban plots (the
 * 1444 development number), while the sim claims plots one per firm starting from one. Neither
 * alone is right — the first cannot grow, the second makes a 1444 metropolis a single hut on day
 * one — so the town stands on <b>both</b>:
 * <ul>
 * <li>the <b>1444 starting core</b>: the {@link Settlement#getStartingDistrictCount()} urban plots
 *     of the province nearest the centre, plus the city centre itself, which is part of the town by
 *     definition however the ranking falls;</li>
 * <li>the <b>built plots</b>: those the colony owns and has raised a regular building on
 *     ({@link Plot#hasRegularBuilding()}).</li>
 * </ul>
 * A city therefore starts at its historical size and grows outward as firms claim and build. If the
 * engine one day claims the starting core for real, the union collapses to the claimed set and
 * nothing here changes.
 * <p>
 * <b>What counts as land.</b> A land province generates plots for its land cells and no others, so
 * "the pool has a plot here" <em>is</em> the land test, and an enclosed cell the pool does not know
 * is either water or another province's — both of which a town builds around rather than swallows.
 * Without a pool (an analytical colony founded at bare coordinates) nothing outside the footprint
 * counts as land, so no pocket is ever filled: the shape stands as claimed.
 */
public final class ColonyFootprint {

	private ColonyFootprint() {
	}

	/**
	 * The footprint of a colony.
	 *
	 * @param colony the settlement
	 * @param pool   its province's shared plot pool ({@code GameSession.plotPoolIfPresent}), or
	 *               {@code null} for a colony with no province
	 * @return the cleaned footprint, or {@link Footprint#EMPTY} for a settlement standing on
	 *         nothing yet — a camp, or a colony before it has laid its first plot
	 */
	public static Footprint of(Settlement colony, ProvincePlotPool pool) {
		Set<Cell> claimed = new LinkedHashSet<>();

		Plot centre = colony.getCityCenter();
		if (centre != null) {
			claimed.add(cell(centre));
		}
		claimed.addAll(startingCore(colony, pool, centre));
		for (Plot p : colony.getDistrictPlots()) {
			if (p.owner() == colony && p.hasRegularBuilding()) {
				claimed.add(cell(p));
			}
		}
		if (claimed.isEmpty()) {
			return Footprint.EMPTY;
		}

		Set<Cell> land = landCells(pool);
		return Footprint.of(claimed, land::contains);
	}

	/**
	 * The 1444 starting core: the urban plots of the colony's province nearest its centre, as many
	 * as its {@linkplain Settlement#getStartingDistrictCount() tier-capped development} allows.
	 * <p>
	 * Ranked by {@link Footprint#nearest} — the same ranking, with the same tie-break, the web
	 * client has been doing for itself. It is the server's answer now.
	 */
	private static List<Cell> startingCore(Settlement colony, ProvincePlotPool pool, Plot centre) {
		int n = colony.getStartingDistrictCount();
		if (pool == null || centre == null || n <= 0) {
			return List.of();
		}
		List<Cell> urban = new ArrayList<>();
		for (Plot p : pool.plots()) {
			if (p.urban()) {
				urban.add(cell(p));
			}
		}
		return Footprint.nearest(urban, n, centre.x() + 0.5, centre.y() + 0.5);
	}

	private static Set<Cell> landCells(ProvincePlotPool pool) {
		Set<Cell> land = new HashSet<>();
		if (pool != null) {
			for (Plot p : pool.plots()) {
				land.add(cell(p));
			}
		}
		return land;
	}

	private static Cell cell(Plot p) {
		return new Cell(p.x(), p.y());
	}
}
