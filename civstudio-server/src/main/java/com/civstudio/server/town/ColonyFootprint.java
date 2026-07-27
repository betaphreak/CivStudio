package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Pt;
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
 * <li>the <b>1444 starting core</b>: the {@link Settlement#getStartingDistrictCount()} plots of the
 *     province nearest the centre — urban ground first, then whatever else is closest — plus the
 *     city centre itself, which is part of the town by definition however the ranking falls;</li>
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
		return of(colony, pool, List.of());
	}

	/**
	 * The footprint of one city of a <b>league</b> — several settlements sharing a province
	 * ({@code docs/city-and-league.md}, and {@code towngen-port.md} §2c for the case).
	 * <p>
	 * <b>The 1444 core has to be divided, or every city claims the whole province.</b>
	 * {@link Settlement#getStartingDistrictCount()} is derived from the <em>province's</em>
	 * development, so ten cities in one province would each lay claim to all 27 of Nathalaire's
	 * plots and ten towns would be drawn on top of one another. The division is the obvious one and
	 * needs no new state: a plot belongs to the city whose centre is <b>nearest</b> it. Cities
	 * therefore carve the site up between them, the lead city — founded first, on the best ground —
	 * takes the middle, and the total never exceeds the province's own development.
	 *
	 * @param colony   the city
	 * @param pool     its province's plot pool, or {@code null}
	 * @param siblings the other cities sharing the province; empty for a lone settlement
	 * @return the cleaned footprint
	 */
	public static Footprint of(Settlement colony, ProvincePlotPool pool,
			Collection<Settlement> siblings) {
		Set<Cell> claimed = new LinkedHashSet<>();

		Plot centre = colony.getCityCenter();
		if (centre != null) {
			claimed.add(cell(centre));
		}
		claimed.addAll(startingCore(colony, pool, centre, siblings));
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
	private static List<Cell> startingCore(Settlement colony, ProvincePlotPool pool, Plot centre,
			Collection<Settlement> siblings) {
		int n = colony.getStartingDistrictCount();
		if (pool == null || centre == null || n <= 0) {
			return List.of();
		}
		List<Pt> rivals = new ArrayList<>();
		for (Settlement other : siblings) {
			Plot c = other == colony ? null : other.getCityCenter();
			if (c != null) {
				rivals.add(new Pt(c.x() + 0.5, c.y() + 0.5));
			}
		}
		// URBAN PLOTS FIRST, BUT NOT ONLY THEM. The urban flag comes from CityPlacement, which
		// gives exactly ONE urban plot to any province that is not Anbennar `city_terrain` — and
		// only ~62 provinces are. Ranking urban plots alone therefore collapses every ordinary
		// city, however developed, to a single hut: Nathalaire is development 27 and has one urban
		// plot. So the core takes the urban ground first and then keeps going into the plots
		// nearest the centre until the site's 1444 development is housed.
		double cx = centre.x() + 0.5, cy = centre.y() + 0.5;
		List<Cell> urban = new ArrayList<>();
		List<Cell> rest = new ArrayList<>();
		for (Plot p : pool.plots()) {
			Cell c = cell(p);
			if (nearerRival(c, cx, cy, rivals)) {
				continue;                        // this ground belongs to another city of the league
			}
			(p.urban() ? urban : rest).add(c);
		}
		List<Cell> core = new ArrayList<>(Footprint.nearest(urban, n, cx, cy));
		if (core.size() < n) {
			core.addAll(Footprint.nearest(rest, n - core.size(), cx, cy));
		}
		return List.copyOf(core);
	}

	/**
	 * Whether another city of the league stands nearer this plot than we do. Ties go to the caller,
	 * so a plot exactly between two cities joins the one asking — which is stable only because the
	 * cities are asked in a fixed order, and harmless either way: a shared plot is a plot both
	 * neighbourhoods grew into.
	 */
	private static boolean nearerRival(Cell c, double cx, double cy, List<Pt> rivals) {
		if (rivals.isEmpty()) {
			return false;
		}
		double mine = sq(c.centre().x() - cx) + sq(c.centre().y() - cy);
		for (Pt r : rivals) {
			if (sq(c.centre().x() - r.x()) + sq(c.centre().y() - r.y()) < mine) {
				return true;
			}
		}
		return false;
	}

	private static double sq(double d) {
		return d * d;
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
