package com.civstudio.scenario;

import com.civstudio.geo.Province;

/**
 * What kind of league a {@link FoundingShape#LEAGUE} founds — and the three kinds are the three EU4
 * development flavours, because a bloc of cities forms around whatever the place is <em>good at</em>
 * (owner, 2026-07-28).
 * <ul>
 * <li>{@link #ADM} — a <b>conurbation</b>: the cities are adjacent, their built ground grows
 *     together, and the league reads as one continuous urban fabric with many names in it.
 *     Nathalaire, and every historical city that swallowed its neighbours.</li>
 * <li>{@link #DIP} — a <b>maritime league</b>: the cities are far apart and connected by sea ports,
 *     not by streets. The Hansa, literally.</li>
 * <li>{@link #MIL} — a <b>war camp</b>: the encampment of many allied armies, a city that exists
 *     because a host is standing there and lasts as long as it does.</li>
 * </ul>
 * <b>The flavour is read off the site, not chosen.</b> A province's 1444 development splits into
 * {@code base_tax} (ADM), {@code base_production} (DIP) and {@code base_manpower} (MIL), and those
 * numbers already say what the place is: an administrative centre grows a conurbation, a production
 * and trade centre grows a shipping league, a manpower sink grows an army. Ties break toward the
 * more settled form — a place that is equally administrative and productive is a city before it is
 * a port.
 */
public enum LeagueFlavor {

	/** A conurbation: adjacent cities growing into one another. */
	ADM,

	/** A maritime league: distant cities tied together by sea ports. */
	DIP,

	/** A war camp: the encampment of allied armies. */
	MIL;

	/**
	 * The flavour a province's own development calls for.
	 *
	 * @param province the site, or {@code null}
	 * @return the flavour; {@link #ADM} for an unknown or featureless site, which is the form that
	 *         needs the least from the world around it
	 */
	public static LeagueFlavor of(Province province) {
		if (province == null) {
			return ADM;
		}
		int adm = province.baseTax();
		int dip = province.baseProduction();
		int mil = province.baseManpower();
		if (adm >= dip && adm >= mil) {
			return ADM;
		}
		return dip >= mil ? DIP : MIL;
	}

	/**
	 * The flavour named by a scenario flag, for a scenario that wants to say outright rather than
	 * let the site decide.
	 *
	 * @param name     the flag value ({@code "adm"}, {@code "dip"}, {@code "mil"}), case-insensitive
	 * @param fallback what to use when the name is absent or unrecognised
	 * @return the flavour
	 */
	public static LeagueFlavor named(String name, LeagueFlavor fallback) {
		if (name == null) {
			return fallback;
		}
		for (LeagueFlavor f : values()) {
			if (f.name().equalsIgnoreCase(name.trim())) {
				return f;
			}
		}
		return fallback;
	}

	/** Whether this league's cities stand together on one site, sharing a province. */
	public boolean isContiguous() {
		return this == ADM || this == MIL;
	}
}
