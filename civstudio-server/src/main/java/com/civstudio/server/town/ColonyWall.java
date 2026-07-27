package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.civstudio.geo.Province;
import com.civstudio.geo.WorldMap;
import com.civstudio.server.town.TownWall.Bearing;
import com.civstudio.server.town.TownWall.EdgeInfo;
import com.civstudio.server.town.TownWall.Side;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Pt;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.ProvincePlotPool;
import com.civstudio.settlement.Settlement;
import com.civstudio.settlement.SettlementTier;

/**
 * The engine-facing half of the fortification ({@code docs/towngen-port.md} T4) — what the plots
 * themselves say about their own edges, and where the roads leave town.
 * <p>
 * Both classifications are read off engine data rather than invented, and both happen to use the
 * same orthogonal bit order as {@link Side}: {@code Plot.coast()} says which edges face water, and
 * {@code Plot.riverAdj()} says which neighbours the river runs on to. So a plot knows whether its
 * own east edge is shore, riverbank or dry ground, and the wall simply asks it.
 * <p>
 * <b>Gates come from the neighbours' border crossings, not from a die roll</b> (§6). Each
 * neighbouring province has a portal — the pixel where a route actually crosses the shared border —
 * and the bearing from the town centre to that portal is where a road leaves. Aiming gates at them
 * is what makes the main avenues T5 will lay end up pointing at the roads that really exist, and
 * line up with the standing route ribbons at the province edge.
 */
public final class ColonyWall {

	private ColonyWall() {
	}

	/**
	 * How many plots a settlement of each tier may enclose (§2b). Uncalibrated starting points: the
	 * point is that one of the ~62 all-urban provinces cannot wall a town several times the size of
	 * everyone else's, not that these are the right numbers.
	 *
	 * @param tier the settlement's tier
	 * @return the walled-core cap, or {@code 0} for a tier that is never walled
	 */
	public static int coreCap(SettlementTier tier) {
		if (tier == null) {
			return 0;
		}
		return switch (tier) {
			case METROPOLIS -> 32;
			case TOWN -> 16;
			default -> 0;                            // below TOWN nothing is permanent, so no wall
		};
	}

	/**
	 * Fortify a colony.
	 *
	 * @param colony    the settlement
	 * @param pool      its province's plot pool, or {@code null}
	 * @param map       the world map, for the neighbours' border crossings, or {@code null} to
	 *                  place no road gates
	 * @param footprint its footprint
	 * @return the fortification, or {@link TownWall#NONE}
	 */
	public static TownWall of(Settlement colony, ProvincePlotPool pool, WorldMap map,
			Footprint footprint) {
		Plot centrePlot = colony.getCityCenter();
		if (centrePlot == null || footprint.isEmpty()) {
			return TownWall.NONE;
		}
		Pt centre = new Cell(centrePlot.x(), centrePlot.y()).centre();
		return TownWall.of(footprint, colony.isPermanent(), coreCap(colony.getTier()), centre,
				edgeInfo(pool), bearings(colony, map, centre));
	}

	/**
	 * What the plots say about their own edges. A plot the pool does not know about — beyond the
	 * province, or under water — reads as water, which is the right default: the town's edge there
	 * is a shore or a border, not dry ground it chose not to build on.
	 */
	static EdgeInfo edgeInfo(ProvincePlotPool pool) {
		Map<Cell, Plot> byCell = new HashMap<>();
		if (pool != null) {
			for (Plot p : pool.plots()) {
				byCell.put(new Cell(p.x(), p.y()), p);
			}
		}
		return new EdgeInfo() {

			@Override
			public boolean water(Cell cell, Side side) {
				Plot p = byCell.get(cell);
				return p == null || side.in(p.coast());
			}

			@Override
			public boolean river(Cell cell, Side side) {
				Plot p = byCell.get(cell);
				// the river has to be ON this plot and run ON to the neighbour across this edge:
				// riverAdj alone would put a water gate on every plot beside a river, rather than
				// only where the channel actually crosses the line
				return p != null && p.river() && side.in(p.riverAdj());
			}
		};
	}

	/**
	 * Where the roads leave: one bearing per neighbouring province, aimed at the pixel where a
	 * route crosses that border. Neighbours with no recorded crossing are skipped rather than
	 * guessed at — a border nobody crosses deserves no gate.
	 */
	static List<Bearing> bearings(Settlement colony, WorldMap map, Pt centre) {
		Province province = colony.getProvince();
		if (map == null || province == null) {
			return List.of();
		}
		record Crossing(Bearing bearing, double distance) {
		}
		List<Crossing> found = new ArrayList<>();
		for (int neighbour : map.neighbors(province.id())) {
			int[] portal = map.portal(province.id(), neighbour);
			if (portal == null) {
				continue;
			}
			Pt away = new Pt(portal[0] + 0.5, portal[1] + 0.5).minus(centre);
			if (away.len() == 0) {
				continue;
			}
			Province p = map.province(neighbour);
			String toward = p == null ? String.valueOf(neighbour) : p.name();
			found.add(new Crossing(new Bearing(away.angle(), toward), away.len()));
		}
		// nearest crossing first, so when two neighbours want the same side of town the closer one
		// takes the gate and the further is dropped by the separation rule
		found.sort(Comparator.comparingDouble(Crossing::distance)
				.thenComparing(c -> c.bearing().toward()));
		List<Bearing> out = new ArrayList<>(found.size());
		for (Crossing c : found) {
			out.add(c.bearing());
		}
		return List.copyOf(out);
	}
}
