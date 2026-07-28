package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.civstudio.agent.laborer.Laborer;
import com.civstudio.geo.PlotType;
import com.civstudio.geo.Province;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.Building;
import com.civstudio.settlement.BuildingCatalog;
import com.civstudio.settlement.BuildingInfo;
import com.civstudio.settlement.DistrictType;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.ProvincePlotPool;
import com.civstudio.settlement.Settlement;
import com.civstudio.tech.Advisor;

/**
 * The engine-facing half of the wards and lots ({@code docs/towngen-port.md} T6) — what actually
 * stands on each plot, and how many people live on it.
 * <p>
 * <b>This is where §4a's promise is kept and §4b's compromise is made.</b> Where the sim has
 * claimed and built, the answer is real: the households are the ones {@code householdsByHomePlot}
 * says live there, the buildings are the ones on the plot, and the ward is the fold of their
 * categories. That is the whole point of the port — a plot with twelve households and three
 * buildings looks different from one with two households because it is.
 * <p>
 * <b>The 1444 core is the part that has to be invented, and it is fenced off.</b> A founded
 * metropolis walls twenty-odd plots of which the sim has claimed one, so a strict reading gives a
 * curtain wall around thirty-one empty blocks — worse than the single hut it replaced. So an
 * <em>untouched</em> plot of the starting core gets a synthetic household count derived from the
 * province's 1444 development. Three rules hold it in place, and all three are the plan's (§4b):
 * <ul>
 * <li><b>Real state always wins.</b> Any household, any building, and the synthesis does not run —
 *     not "is blended with", does not run. So a plot the sim reaches switches to real counts and
 *     stays there.</li>
 * <li><b>It is render-only.</b> Nothing here enters the engine, is counted as population, eats, or
 *     pays tax. It is the same category of thing {@code startingDistricts} already is: display
 *     metadata describing a world the sim has not simulated. Founding a colony with a real
 *     population to match is a much larger change and belongs to its own plan.</li>
 * <li><b>It is derived, not stored.</b> Same seed and same province gives the same synthetic town,
 *     so nothing about it needs persisting.</li>
 * </ul>
 * The distribution is §9a's open question and this is an answer, not <em>the</em> answer: a base off
 * development, falling away from the centre, with a nudge along the streets because that is where a
 * town thickens. It is the most visible uncalibrated number in the plan and it is all in one method
 * so it can be tuned in one place.
 */
public final class ColonySite implements TownWards.Site, TownLots.Density, TownRiver.Water {

	/**
	 * How much 1444 development one synthetic household is worth at the centre. Development runs
	 * about 3–30, so this puts a big city at the {@link #MAX_SYNTHETIC_HOUSEHOLDS} cap and an
	 * ordinary one at two or three.
	 */
	private static final int DEVELOPMENT_PER_HOUSEHOLD = 6;

	/**
	 * The ceiling on a synthetic plot's households. Deliberately near what a real hamlet reaches:
	 * §4b's second rule is that the sim claiming a plot must read as filling in rather than as a
	 * discontinuity, and a plot that visibly loses fourteen families the day it becomes real would
	 * be exactly that.
	 */
	private static final int MAX_SYNTHETIC_HOUSEHOLDS = 6;

	/** How far from the centre, in plots, the synthetic density halves. */
	private static final double FALLOFF_PLOTS = 4.0;

	/** What a street is worth to a plot's synthetic density — a town thickens along its roads. */
	private static final int STREET_BONUS = 1;

	private final Map<Cell, Plot> plots = new HashMap<>();
	private final Map<Cell, Integer> realHouseholds = new HashMap<>();
	private final Map<Cell, List<String>> buildings = new HashMap<>();
	private final java.util.Set<Cell> claimed = new java.util.HashSet<>();
	private final Cell centre;
	private final int development;
	private java.util.Set<Cell> streetCells = java.util.Set.of();

	private ColonySite(Settlement colony, ProvincePlotPool pool) {
		Plot centrePlot = colony.getCityCenter();
		this.centre = centrePlot == null ? null : new Cell(centrePlot.x(), centrePlot.y());
		Province province = colony.getProvince();
		this.development = province == null ? 0 : province.development();
		if (pool != null) {
			for (Plot p : pool.plots()) {
				plots.put(new Cell(p.x(), p.y()), p);
			}
		}
		for (Plot p : colony.getDistrictPlots()) {
			plots.put(new Cell(p.x(), p.y()), p);
		}
		Map<Plot, List<Laborer>> byHome = colony.householdsByHomePlot();
		Map<Plot, Integer> counted = new IdentityHashMap<>();
		for (Map.Entry<Plot, List<Laborer>> e : byHome.entrySet()) {
			counted.put(e.getKey(), e.getValue().size());
		}
		for (Map.Entry<Cell, Plot> e : plots.entrySet()) {
			Plot p = e.getValue();
			if (p.owner() == colony) {
				claimed.add(e.getKey());
			}
			Integer homes = counted.get(p);
			if (homes != null && homes > 0) {
				realHouseholds.put(e.getKey(), homes);
			}
			List<String> ids = buildingIds(p);
			if (!ids.isEmpty()) {
				buildings.put(e.getKey(), ids);
			}
		}
	}

	/**
	 * Read a colony's plots.
	 *
	 * @param colony  the settlement
	 * @param pool    its province's plot pool, or {@code null}
	 * @param streets its streets, so the synthetic density can thicken along them; may be
	 *                {@code null}
	 * @return the site
	 */
	public static ColonySite of(Settlement colony, ProvincePlotPool pool, TownStreets streets) {
		ColonySite site = new ColonySite(colony, pool);
		if (streets != null) {
			site.streetCells = streets.streetCells();
		}
		return site;
	}

	// --- TownWards.Site -----------------------------------------------------------------------

	@Override
	public DistrictType decided(Cell cell) {
		if (cell.equals(centre)) {
			return DistrictType.CITY_CENTER;
		}
		List<String> here = buildings.getOrDefault(cell, List.of());
		if (here.isEmpty()) {
			return null;                            // the sim has said nothing; the scoring may choose
		}
		// the plot's identity is its MOST IMPORTANT building's category — the same building that
		// takes the largest lot, so the ward and the mass drawn on it never disagree
		BuildingCatalog catalog = BuildingCatalog.get();
		for (String id : here) {
			BuildingInfo info = catalog.byId(id);
			Optional<DistrictType> type = info == null ? Optional.empty()
					: DistrictType.fromCategory(advisor(info.category()));
			if (type.isPresent()) {
				return type.get();
			}
		}
		// built, but by nothing the taxonomy has an opinion about (an uncategorized C2C row): this
		// is somewhere people live, which is what NEIGHBORHOOD means
		return DistrictType.NEIGHBORHOOD;
	}

	@Override
	public int elevation(Cell cell) {
		Plot p = plots.get(cell);
		return p == null ? 0 : p.elevation();
	}

	@Override
	public boolean hill(Cell cell) {
		Plot p = plots.get(cell);
		return p != null && p.plotType() == PlotType.HILL;
	}

	@Override
	public boolean enfeoffed(Cell cell) {
		Plot p = plots.get(cell);
		return p != null && p.ownerId() != null;
	}

	@Override
	public int coastEdges(Cell cell) {
		Plot p = plots.get(cell);
		return p == null ? 0 : Integer.bitCount(p.coast() & 0xF);
	}

	// --- TownRiver.Water ----------------------------------------------------------------------

	@Override
	public boolean river(Cell cell) {
		Plot p = plots.get(cell);
		return p != null && p.river();
	}

	@Override
	public int links(Cell cell) {
		Plot p = plots.get(cell);
		// the engine has already decoded this: the client's river-geom.mjs unpacks a PACKED code
		// because the plot feed sends packed codes, and a Plot carries the fields outright. There is
		// no decoder to port and none to keep in step (docs/towngen-port.md §8b, settled in T4b).
		return p == null ? 0 : p.riverAdj();
	}

	// --- TownLots.Density ---------------------------------------------------------------------

	@Override
	public List<String> buildings(Cell cell) {
		return buildings.getOrDefault(cell, List.of());
	}

	@Override
	public int households(Cell cell) {
		Integer real = realHouseholds.get(cell);
		if (real != null) {
			return real;                            // real state always wins, without blending
		}
		// EMPTY IS ALSO AN ANSWER. A plot the colony has built on, or simply CLAIMED, is ground the
		// sim has an opinion about — and "nobody lives here any more" is that opinion. Reading it as
		// "the sim has not reached here yet" and inventing families onto it repopulates exactly the
		// plots §2a says should be falling into ruin, which is what this did before: a month into a
		// run, fourteen plots the colony had emptied came back full of people who were never there.
		if (buildings.containsKey(cell) || claimed.contains(cell)) {
			return 0;
		}
		return synthetic(cell);
	}

	/**
	 * The synthetic households of an untouched starting-core plot (§4b) — the open question of §9a.1,
	 * answered in one place so it can be tuned in one place.
	 *
	 * @param cell the plot
	 * @return how many families to draw there
	 */
	int synthetic(Cell cell) {
		if (centre == null || development <= 0) {
			return 0;
		}
		int base = Math.max(1,
				Math.min(MAX_SYNTHETIC_HOUSEHOLDS, development / DEVELOPMENT_PER_HOUSEHOLD));
		double falloff = 1.0 / (1.0 + cell.centre().dist(centre.centre()) / FALLOFF_PLOTS);
		int homes = (int) Math.round(base * falloff);
		if (streetCells.contains(cell)) {
			homes += STREET_BONUS;
		}
		return Math.max(0, Math.min(MAX_SYNTHETIC_HOUSEHOLDS, homes));
	}

	/** Whether this plot's households are invented rather than simulated — for the diagnostics. */
	boolean isSynthetic(Cell cell) {
		return !realHouseholds.containsKey(cell) && !buildings.containsKey(cell)
				&& !claimed.contains(cell) && synthetic(cell) > 0;
	}

	/**
	 * A plot's buildings, <b>most important first</b>. Importance is the catalog's effective cost:
	 * it is what the game already uses to say how much a thing is worth raising, so a cathedral
	 * outranks a cottage without a second table to keep in step. Ties break on the id, so the order
	 * is stable across runs and across regenerations.
	 */
	private static List<String> buildingIds(Plot plot) {
		List<Building> raised = plot.buildings();
		if (raised.isEmpty()) {
			return List.of();
		}
		BuildingCatalog catalog = BuildingCatalog.get();
		List<String> ids = new ArrayList<>(raised.size());
		for (Building b : raised) {
			ids.add(b.id());
		}
		ids.sort(Comparator.comparingInt((String id) -> -cost(catalog, id)).thenComparing(id -> id));
		return List.copyOf(ids);
	}

	private static int cost(BuildingCatalog catalog, String id) {
		BuildingInfo info = catalog.byId(id);
		Integer c = info == null ? null : info.effectiveCost();
		return c == null ? 0 : c;
	}

	/** The advisor branch of a catalog category string, which may be bare or {@code ADVISOR_}-keyed. */
	private static Optional<Advisor> advisor(String category) {
		if (category == null || category.isBlank()) {
			return Optional.empty();
		}
		Optional<Advisor> keyed = Advisor.fromKey(category);
		if (keyed.isPresent()) {
			return keyed;
		}
		try {
			return Optional.of(Advisor.valueOf(category));
		} catch (IllegalArgumentException e) {
			return Optional.empty();
		}
	}
}
