package com.civstudio.server.town;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.civstudio.geo.WorldMap;
import com.civstudio.server.town.TownStreets.Terrain;
import com.civstudio.server.town.TownWall.Side;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.ProvincePlotPool;
import com.civstudio.settlement.Settlement;

/**
 * The engine-facing half of the streets ({@code docs/towngen-port.md} T5) — the ground the router
 * charges for, and where the roads come in when there is no wall to hang a gate on.
 * <p>
 * Both are read off the plots rather than invented. A plot knows its own heightmap elevation and
 * whether the river on it runs on to each neighbour, so the street cost is a question the map
 * already has an answer to; and the bearings are the neighbours' real border crossings, the same
 * ones {@link ColonyWall} aims gates at, so an unwalled hamlet's lanes point the same way a walled
 * town's gates would.
 */
public final class ColonyStreets {

	private ColonyStreets() {
	}

	/**
	 * Lay a colony's streets.
	 *
	 * @param colony    the settlement
	 * @param pool      its province's plot pool, or {@code null} — without one the ground reads as
	 *                  flat and riverless, and the streets come out as straight as the mesh allows
	 * @param map       the world map, for the neighbours' border crossings, or {@code null}
	 * @param footprint its footprint
	 * @param mesh      its mesh
	 * @param wall      its fortification
	 * @return the streets, or {@link TownStreets#NONE}
	 */
	public static TownStreets of(Settlement colony, ProvincePlotPool pool, WorldMap map,
			Footprint footprint, TownMesh mesh, TownWall wall) {
		Plot centrePlot = colony.getCityCenter();
		if (centrePlot == null || footprint == null || footprint.isEmpty()) {
			return TownStreets.NONE;
		}
		Cell centre = new Cell(centrePlot.x(), centrePlot.y());
		List<TownWall.Bearing> bearings = ColonyWall.bearings(colony, map, centre.centre());
		return TownStreets.of(footprint, mesh, wall, centre, terrain(pool), bearings);
	}

	/**
	 * What the plots say about the ground between them.
	 * <p>
	 * <b>The river test is symmetric, and has to be.</b> {@code Plot.riverAdj()} records which
	 * neighbours the river on <em>this</em> plot runs on to, so a channel between two plots may be
	 * recorded on either side of it depending on which way the river was traced. Asking only the
	 * plot being left would let a street cross the same water for free in one direction and pay a
	 * bridge in the other — and A* would find that, every time.
	 * <p>
	 * A plot the pool does not know about reads as flat and dry. The router never asks about one:
	 * every cell it considers is in the footprint, and the footprint is built ground.
	 *
	 * @param pool the province's plot pool, or {@code null}
	 * @return the terrain the street cost reads
	 */
	static Terrain terrain(ProvincePlotPool pool) {
		Map<Cell, Plot> byCell = new HashMap<>();
		if (pool != null) {
			for (Plot p : pool.plots()) {
				byCell.put(new Cell(p.x(), p.y()), p);
			}
		}
		return new Terrain() {

			@Override
			public int elevation(Cell cell) {
				Plot p = byCell.get(cell);
				return p == null ? 0 : p.elevation();
			}

			@Override
			public boolean river(Cell from, Cell to) {
				return runsOn(from, to) || runsOn(to, from);
			}

			/** Whether {@code a} carries a river that runs on to {@code b} across their shared edge. */
			private boolean runsOn(Cell a, Cell b) {
				Plot p = byCell.get(a);
				if (p == null || !p.river()) {
					return false;
				}
				Side side = sideBetween(a, b);
				return side != null && side.in(p.riverAdj());
			}
		};
	}

	/** Which edge of {@code a} faces {@code b}, or {@code null} if they are not orthogonal neighbours. */
	private static Side sideBetween(Cell a, Cell b) {
		for (Side side : Side.values()) {
			if (side.of(a).equals(b)) {
				return side;
			}
		}
		return null;
	}
}
