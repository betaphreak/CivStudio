package com.civstudio.server.town;

import java.util.List;

import com.civstudio.agent.laborer.Laborer;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.Settlement;

/**
 * <b>Has this town changed?</b> — {@code docs/towngen-port.md} T7, and the one number the stored
 * layout and the snapshot's dirty flag must both agree on.
 * <p>
 * A layout is a pure function of the colony's state, so the cheapest honest way to know whether it
 * needs recomputing is to hash the inputs it actually reads: which plots the town stands on, what
 * is built on them, how many families live there, and the tier that decides how much of it is
 * walled. Nothing else in the colony can move a single vertex.
 * <p>
 * <b>One owner, deliberately.</b> The store uses this to decide whether to recompute; the render
 * snapshot puts it on the wire so a browser knows to re-fetch. Two separate notions of "changed"
 * would drift into the case that matters most — a town that grew and did not redraw — so there is
 * one function and both callers use it.
 * <p>
 * <b>What it deliberately does not include:</b> the date. A town that has not changed must hash the
 * same on the thousandth day as on the first, or every tick would rewrite every layout on the
 * volume for nothing.
 */
public final class TownSignature {

	private TownSignature() {
	}

	/** The signature of a site with no colony standing on it. */
	public static final int RUIN = 0;

	/**
	 * The signature of a colony's layout inputs.
	 *
	 * @param colony the settlement, or {@code null} for a site whose colony is gone
	 * @return a hash that changes exactly when the layout would
	 */
	public static int of(Settlement colony) {
		// isDead(), not !isAlive(): a colony that has not started yet still has a town to draw, and
		// hashing it as a ruin would make every session redraw its whole world on its first tick
		if (colony == null || colony.isDead()) {
			return RUIN;
		}
		int h = 17;
		h = 31 * h + (colony.getTier() == null ? 0 : colony.getTier().ordinal());
		h = 31 * h + colony.getStartingDistrictCount();
		Plot centre = colony.getCityCenter();
		h = 31 * h + (centre == null ? 0 : 31 * centre.x() + centre.y());
		// Walked in the colony's own plot order, which is stable — claim order within a run, and the
		// same order again after a replayed restore. Folding the households in HERE rather than over
		// the map's own values() is the point: householdsByHomePlot is an IdentityHashMap, so its
		// iteration order is not reproducible, and a signature that flaps would rewrite every layout
		// on the volume every tick while claiming nothing had changed.
		java.util.Map<Plot, List<Laborer>> byHome = colony.householdsByHomePlot();
		for (Plot p : colony.getDistrictPlots()) {
			h = 31 * h + p.x();
			h = 31 * h + p.y();
			h = 31 * h + p.buildings().size();          // what stands here
			h = 31 * h + (p.ownerId() == null ? 0 : 1);  // crown demesne or a noble's fief
			h = 31 * h + byHome.getOrDefault(p, List.of()).size();   // and who lives here
		}
		h = 31 * h + byHome.size();
		return h;
	}
}
