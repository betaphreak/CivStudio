package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.civstudio.server.town.geom.Cutter;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Poly;
import com.civstudio.server.town.geom.TownScale;

/**
 * The <b>lots</b> — {@code docs/towngen-port.md} T6 §4a, and the payoff of the whole port.
 * <p>
 * <b>The subdivision is fitted, not invented.</b> The reference generator decides how many buildings
 * a ward holds by bisecting its block until each half falls under a random threshold; it has to,
 * because nothing else knows. We know exactly: {@code householdsByHomePlot} says how many families
 * live on a plot and {@code Plot.buildings()} says what stands there. So the target is a count off
 * real state, and a plot with twelve households and three buildings <em>looks</em> different from
 * one with two households, because it is. The reference's chaos parameters survive only as shape
 * controls — how regular the blocks are — and never as population.
 * <p>
 * <b>Biggest block to the biggest building.</b> Pieces are sorted by area and buildings take them
 * first, so a cathedral gets a cathedral's footprint and a cottage does not (§2c's "notable
 * buildings drawn as large coloured masses"). Then one lot per household, a dwelling. Then whatever
 * is left over is yard — or, inside the walls of a town with nobody left in it, ruin (§2a: decline
 * renders <em>inside</em> the wall, and the wall never contracts).
 * <p>
 * <b>Keyed per plot, like everything else here.</b> Each patch cuts its block from a generator
 * seeded on {@code (site, x, y)}, so a plot's lots are the same whether the town was generated whole
 * or grew one plot at a time — and building on one side of town cannot re-cut the blocks on the
 * other.
 *
 * @param byCell the lots of each plot, in the footprint's {@code (y, x)} order
 * @param diag   what the subdivision did, for the caller to log
 */
public record TownLots(Map<Cell, List<Lot>> byCell, Diagnostics diag) {

	/** A town with nothing standing on it. */
	public static final TownLots NONE = new TownLots(Map.of(), new Diagnostics(0, 0, 0, 0, 0));

	/**
	 * The most lots one plot may be cut into. A bound on legibility first and payload second: a plot
	 * is one Civ4 tile, and past about a dozen blocks it stops reading as a place and starts reading
	 * as texture.
	 */
	public static final int MAX_LOTS = 12;

	/** How many ruined blocks an emptied walled plot shows. Enough to read as "this was somewhere". */
	public static final int RUIN_LOTS = 3;

	/** The margin left between a ward's lots and the ward boundary — where the street runs. */
	public static final double WARD_MARGIN = 0.055 * TownScale.PLOT;

	/** The gap left at each cut within a ward: the alleys between its blocks. */
	public static final double ALLEY_GAP = TownScale.STREET_ALLEY;

	/** What stands on a lot. */
	public enum Kind {

		/** A real building, drawn as a mass sized by the block it took. */
		BUILDING,
		/** A household's dwelling. */
		DWELLING,
		/** Yard, garden, or ground nobody has built on. */
		EMPTY,
		/** What is left of a dwelling in a town that has emptied out inside its walls (§2a). */
		RUIN
	}

	/**
	 * One lot.
	 *
	 * @param poly     its outline, in plot space
	 * @param kind     what stands on it
	 * @param building the {@code BUILDING_*} id standing here, or {@code null} for anything else —
	 *                 the client joins it against the building catalog for a name and its icon
	 */
	public record Lot(Poly poly, Kind kind, String building) {
	}

	/**
	 * What the subdivision produced.
	 *
	 * @param lots      how many lots in total
	 * @param buildings how many carry a real building
	 * @param dwellings how many carry a household
	 * @param ruins     how many are ruins
	 * @param unfitted  how many lots were asked for and could not be cut — a plot whose block is too
	 *                  small to hold what stands on it. Reported rather than forced: inventing sliver
	 *                  lots to hit a number would be worse than saying the block is full
	 */
	public record Diagnostics(int lots, int buildings, int dwellings, int ruins, int unfitted) {

		/** Whether this is worth a log line. */
		public boolean interesting() {
			return unfitted > 0 || ruins > 0;
		}

		@Override
		public String toString() {
			return lots + " lots (" + buildings + " buildings, " + dwellings + " dwellings"
					+ (ruins > 0 ? ", " + ruins + " ruins" : "") + ")"
					+ (unfitted > 0 ? ", " + unfitted + " did not fit" : "");
		}
	}

	/**
	 * How crowded each plot is. The engine adapter supplies this from real sim state — plus, for the
	 * 1444 core the sim has not claimed, the synthetic population of §4b.
	 */
	public interface Density {

		/**
		 * The buildings standing on this plot, <b>most important first</b>: the order is what decides
		 * which gets the biggest block, so a cathedral must come before a cottage.
		 */
		default List<String> buildings(Cell cell) {
			return List.of();
		}

		/** How many households live on this plot. */
		default int households(Cell cell) {
			return 0;
		}
	}

	/**
	 * Lay out a town's lots.
	 *
	 * @param mesh     the mesh — one patch per plot, and the block each is cut from
	 * @param wall     its fortification, so an emptied plot inside the walls can ruin rather than
	 *                 simply vanish; may be {@code null}
	 * @param density  how crowded each plot is
	 * @param siteSeed the site's layout seed
	 * @return the lots, or {@link #NONE} for an empty mesh
	 */
	public static TownLots of(TownMesh mesh, TownWall wall, Density density, long siteSeed) {
		if (mesh == null || mesh.isEmpty()) {
			return NONE;
		}
		Map<Cell, List<Lot>> out = new LinkedHashMap<>();
		int total = 0;
		int buildings = 0;
		int dwellings = 0;
		int ruins = 0;
		int unfitted = 0;
		for (TownMesh.Patch patch : mesh.patches()) {
			Cell cell = patch.cell();
			List<String> here = density.buildings(cell);
			int homes = Math.max(0, density.households(cell));
			boolean walled = wall != null && wall.encloses(cell);
			int want = Math.min(MAX_LOTS, here.size() + homes);
			// a plot inside the walls with nobody on it is not empty ground — it is a plot that
			// emptied out, and §2a says the town hollows INSIDE its wall rather than shrinking
			boolean ruined = want == 0 && walled;
			if (ruined) {
				want = RUIN_LOTS;
			}
			if (want == 0) {
				continue;                           // open ground outside the wall: nothing to draw
			}
			Poly block = patch.poly().inset(WARD_MARGIN);
			if (block.isEmpty() || block.area() <= TownScale.MIN_BLOCK_AREA) {
				unfitted += want;
				continue;
			}
			List<Poly> pieces = Cutter.subdivide(block, want, ALLEY_GAP,
					TownRng.generator(TownRng.cellKey(siteSeed, cell.x(), cell.y())));
			pieces.removeIf(Poly::isEmpty);
			if (pieces.isEmpty()) {
				unfitted += want;
				continue;
			}
			// biggest block first, so the most important building takes the largest footprint
			pieces.sort(Comparator.comparingDouble(Poly::area).reversed());
			unfitted += Math.max(0, want - pieces.size());

			List<Lot> lots = new ArrayList<>(pieces.size());
			for (int i = 0; i < pieces.size(); i++) {
				if (ruined) {
					lots.add(new Lot(pieces.get(i), Kind.RUIN, null));
					ruins++;
				} else if (i < here.size()) {
					lots.add(new Lot(pieces.get(i), Kind.BUILDING, here.get(i)));
					buildings++;
				} else if (i < here.size() + homes) {
					lots.add(new Lot(pieces.get(i), Kind.DWELLING, null));
					dwellings++;
				} else {
					lots.add(new Lot(pieces.get(i), Kind.EMPTY, null));
				}
			}
			total += lots.size();
			out.put(cell, List.copyOf(lots));
		}
		return new TownLots(Map.copyOf(out),
				new Diagnostics(total, buildings, dwellings, ruins, unfitted));
	}

	/** The lots of one plot — empty for a plot nothing stands on. */
	public List<Lot> of(Cell cell) {
		return byCell.getOrDefault(cell, List.of());
	}

	/** Whether anything was laid out. */
	public boolean isEmpty() {
		return byCell.isEmpty();
	}
}
