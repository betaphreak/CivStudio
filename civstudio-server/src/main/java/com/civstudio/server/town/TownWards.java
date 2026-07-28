package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.DistrictType;

/**
 * What each patch <b>is</b> — {@code docs/towngen-port.md} T6, the {@code rateLocation} half.
 * <p>
 * <b>A ward is a district, not a second vocabulary.</b> A patch is a plot (§4's bijection), so the
 * ward drawn on it must be the plot's own {@link DistrictType} or the client would be inventing
 * district identity, which {@code district-buildout.md} forbids outright. Where the sim has built
 * anything the answer is already decided — a plot's type is the fold of its buildings' advisor
 * categories — and this class does not get a vote. What it decides is the rest: the 1444 starting
 * core the sim has not reached yet, which would otherwise be twenty-odd identical blocks.
 * <p>
 * <b>The scoring is the reference generator's, fed real state instead of invented state.</b> Its
 * wards each rate a location — the cathedral wants the plaza, the military wants the wall, the slum
 * wants the outskirts — and ours rate the same way over things the map actually knows: distance to
 * the founding plot, the heightmap under the plot, whether the wall runs along it, whether a street
 * reaches it, whether a noble holds it. That last one is the one the reference could not have: it
 * invented a patriciate, and we have a real one (§4.1's table, {@code city-of-hamlets-plan.md}).
 * <p>
 * <b>One of each, and then everything else is where people live.</b> A town has one citadel and one
 * cathedral; markets scale with its size. Everything unclaimed falls to {@link
 * DistrictType#NEIGHBORHOOD}, which is not a failure of the scoring — most of a town <em>is</em>
 * houses, and the reference's default ward is the same admission.
 *
 * @param wards the ward of every patch, in the footprint's {@code (y, x)} order
 * @param diag  what the assignment did, for the caller to log
 */
public record TownWards(Map<Cell, DistrictType> wards, Diagnostics diag) {

	/** A town with nothing to assign. */
	public static final TownWards NONE = new TownWards(Map.of(), new Diagnostics(0, 0, Map.of()));

	/**
	 * The wards that are scored for and placed at most a few times each — the ones a town has one
	 * of. Ordered by how much the choice matters: the citadel and the cathedral take the ground they
	 * want, and the theatre takes what is left.
	 */
	private static final List<DistrictType> SPECIALS = List.of(DistrictType.ENCAMPMENT,
			DistrictType.HOLY_SITE, DistrictType.CAMPUS, DistrictType.COMMERCIAL_HUB,
			DistrictType.THEATER);

	/** How many plots of town buy one more market. Markets are the one special that scales. */
	private static final int PLOTS_PER_MARKET = 12;

	/**
	 * How much a keyed nudge may move a score. Small enough that it only ever separates near-ties,
	 * large enough that two towns of the same shape do not put their cathedral on the same corner.
	 */
	private static final double TIE_NUDGE = 0.15;

	/**
	 * What the assignment did.
	 *
	 * @param patches how many patches were assigned
	 * @param fromSim how many took the type the sim's own buildings had already decided
	 * @param counts  how many of each type the town ended up with
	 */
	public record Diagnostics(int patches, int fromSim, Map<DistrictType, Integer> counts) {

		/** Whether this is worth a log line. */
		public boolean interesting() {
			return patches > 0 && fromSim == 0;
		}

		@Override
		public String toString() {
			StringBuilder sb = new StringBuilder(patches + " wards");
			if (fromSim > 0) {
				sb.append(", ").append(fromSim).append(" from the sim");
			}
			for (Map.Entry<DistrictType, Integer> e : counts.entrySet()) {
				if (e.getKey() != DistrictType.NEIGHBORHOOD) {
					sb.append(", ").append(e.getValue()).append(' ').append(e.getKey());
				}
			}
			return sb.toString();
		}
	}

	/**
	 * What the plots themselves say. The engine adapter supplies this; tests supply it directly, and
	 * a featureless town needs none of the defaults.
	 */
	public interface Site {

		/**
		 * The ward the sim has already settled for this plot — the fold of the buildings standing on
		 * it, or {@link DistrictType#CITY_CENTER} for the founding plot. {@code null} means the sim
		 * has said nothing and the scoring may choose.
		 */
		default DistrictType decided(Cell cell) {
			return null;
		}

		/** The plot's 0..255 heightmap elevation. */
		default int elevation(Cell cell) {
			return 0;
		}

		/** Whether the plot is hill relief — more signal than raw elevation at city scale (§7). */
		default boolean hill(Cell cell) {
			return false;
		}

		/** Whether a noble holds this plot as a fief, rather than it being crown demesne. */
		default boolean enfeoffed(Cell cell) {
			return false;
		}
	}

	/**
	 * Assign a ward to every patch.
	 *
	 * @param footprint the town's plots
	 * @param wall      its fortification — the citadel wants to be on it
	 * @param streets   its streets — the market wants to be on one
	 * @param centre    the founding plot, which is the {@link DistrictType#CITY_CENTER} whatever
	 *                  else scores well there
	 * @param site      what the plots say
	 * @param siteSeed  the site's layout seed, for the tie-break nudge
	 * @return the wards, or {@link #NONE} for an empty footprint
	 */
	public static TownWards of(Footprint footprint, TownWall wall, TownStreets streets, Cell centre,
			Site site, long siteSeed) {
		if (footprint == null || footprint.isEmpty()) {
			return NONE;
		}
		List<Cell> cells = footprint.allCells();
		Map<Cell, DistrictType> wards = new LinkedHashMap<>();
		List<Cell> free = new ArrayList<>();
		int fromSim = 0;
		for (Cell c : cells) {
			DistrictType decided = site.decided(c);
			if (c.equals(centre)) {
				decided = DistrictType.CITY_CENTER;     // the founding plot, whatever else scores
			}
			if (decided != null) {
				wards.put(c, decided);
				fromSim++;
			} else {
				free.add(c);
			}
		}

		Scores scores = Scores.of(cells, wall, streets, centre, site, siteSeed);
		Map<DistrictType, Integer> quota = quotas(cells.size(), wards.values());
		for (DistrictType type : SPECIALS) {
			for (int n = quota.getOrDefault(type, 0); n > 0 && !free.isEmpty(); n--) {
				Cell best = pick(free, type, scores);
				if (best == null) {
					break;
				}
				wards.put(best, type);
				free.remove(best);
			}
		}
		for (Cell c : free) {
			wards.put(c, DistrictType.NEIGHBORHOOD);    // most of a town is where people live
		}

		Map<DistrictType, Integer> counts = new EnumMap<>(DistrictType.class);
		for (DistrictType t : wards.values()) {
			counts.merge(t, 1, Integer::sum);
		}
		// re-emit in the footprint's own order, so the wire and every downstream map agree with the
		// order the patches themselves travel in
		Map<Cell, DistrictType> ordered = new LinkedHashMap<>();
		for (Cell c : cells) {
			ordered.put(c, wards.get(c));
		}
		return new TownWards(Map.copyOf(ordered),
				new Diagnostics(ordered.size(), fromSim, Map.copyOf(counts)));
	}

	/** The ward of one plot, or {@code null} for a plot this town does not stand on. */
	public DistrictType of(Cell cell) {
		return wards.get(cell);
	}

	/** Whether anything was assigned. */
	public boolean isEmpty() {
		return wards.isEmpty();
	}

	/**
	 * How many of each special a town of this size gets, minus the ones the sim has already built.
	 * A town that raised its own cathedral does not get a second one scored onto a hill.
	 */
	private static Map<DistrictType, Integer> quotas(int size, java.util.Collection<DistrictType> built) {
		Map<DistrictType, Integer> out = new EnumMap<>(DistrictType.class);
		for (DistrictType t : SPECIALS) {
			out.put(t, t == DistrictType.COMMERCIAL_HUB ? 1 + size / PLOTS_PER_MARKET : 1);
		}
		for (DistrictType t : built) {
			out.computeIfPresent(t, (k, n) -> Math.max(0, n - 1));
		}
		return out;
	}

	/** The free patch that suits this ward best, or {@code null} if none scores above nothing. */
	private static Cell pick(List<Cell> free, DistrictType type, Scores scores) {
		Cell best = null;
		double bestScore = 0;
		for (Cell c : free) {
			double s = scores.rate(c, type);
			if (best == null || s > bestScore) {
				best = c;
				bestScore = s;
			}
		}
		return best;
	}

	/**
	 * The location terms, computed once for the whole town.
	 * <p>
	 * Height is normalised across <em>this town</em> rather than the 0..255 range, and that is not a
	 * detail: the imported heightmap is continental and low-frequency, so a whole settlement can
	 * span forty units of it (§7's caveat). Against the absolute range every plot in town would score
	 * the same height and the term would do nothing at all.
	 */
	private record Scores(Map<Cell, Double> near, Map<Cell, Double> high, Set<Cell> onWall,
			Set<Cell> atGate, Set<Cell> onStreet, Site site, long siteSeed) {

		static Scores of(List<Cell> cells, TownWall wall, TownStreets streets, Cell centre, Site site,
				long siteSeed) {
			Map<Cell, Double> near = new LinkedHashMap<>();
			Map<Cell, Double> high = new LinkedHashMap<>();
			int lo = Integer.MAX_VALUE;
			int hi = Integer.MIN_VALUE;
			for (Cell c : cells) {
				lo = Math.min(lo, site.elevation(c));
				hi = Math.max(hi, site.elevation(c));
			}
			double span = Math.max(1, hi - lo);
			for (Cell c : cells) {
				near.put(c, 1.0 / (1.0 + c.centre().dist(centre.centre())));
				high.put(c, (site.elevation(c) - lo) / span + (site.hill(c) ? 0.25 : 0));
			}
			Set<Cell> onWall = new java.util.LinkedHashSet<>();
			Set<Cell> atGate = new java.util.LinkedHashSet<>();
			if (wall != null) {
				for (TownWall.Segment s : wall.segments()) {
					onWall.add(s.cell());
				}
				for (TownWall.Gate g : wall.gates()) {
					atGate.add(g.segment().cell());
				}
			}
			Set<Cell> onStreet = streets == null ? Set.of() : streets.streetCells();
			return new Scores(near, high, onWall, atGate, onStreet, site, siteSeed);
		}

		/**
		 * How well a plot suits a ward. The weights are the reference generator's instincts, stated
		 * over our terms: a citadel belongs on the wall and on the high ground, a cathedral on a rise
		 * near the plaza, a market on a street by a gate, a scholars' quarter somewhere quiet and
		 * central, a theatre where the patriciate is.
		 */
		double rate(Cell c, DistrictType type) {
			double n = near.getOrDefault(c, 0.0);
			double h = high.getOrDefault(c, 0.0);
			double wallish = onWall.contains(c) ? 1 : 0;
			double gate = atGate.contains(c) ? 1 : 0;
			double street = onStreet.contains(c) ? 1 : 0;
			double lord = site.enfeoffed(c) ? 1 : 0;
			double base = switch (type) {
				case ENCAMPMENT -> 2.0 * wallish + 1.2 * h + 0.5 * gate - 0.5 * n;
				case HOLY_SITE -> 1.5 * n + 1.5 * h + 0.5 * lord;
				// CAMPUS has no ward in the reference and is authored here (§4.1): a scholars'
				// quarter, large regular blocks, central and quiet — so it wants the plaza's
				// neighbourhood and a rise, and actively does not want the wall
				case CAMPUS -> 2.0 * n + 1.0 * h - 1.0 * wallish;
				case COMMERCIAL_HUB -> 1.5 * street + 1.5 * n + 1.0 * gate;
				case THEATER -> 1.5 * n + 1.0 * lord + 0.5 * street;
				default -> 0;
			};
			// a keyed nudge, so a near-tie is broken by the site rather than by (y, x) — two towns of
			// the same shape should not put their cathedral on the same corner
			return base + TIE_NUDGE * TownRng.unit(TownRng.cellKey(siteSeed, c.x(), c.y()));
		}
	}
}
