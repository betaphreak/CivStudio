package com.civstudio.settlement;

import java.util.Optional;

import com.civstudio.tech.Advisor;

/**
 * The <b>district identity</b> of a {@link Plot} — the CivStudio analogue of a Civ6
 * {@code DISTRICT_*} (see {@code docs/district-generator.md} §1 Layer 1), the axis the
 * web district view keys its ground tile and generator mode off. This is the
 * <b>minimal starter set</b> (the {@link #CITY_CENTER} plus one district per
 * {@link Advisor} branch); it grows as placement matures.
 * <p>
 * A district's type is <b>derived from the buildings standing on the plot</b> — the
 * {@code category} of {@link Plot#buildings()} (each building's {@code <Advisor>}
 * branch, the shared taxonomy from {@code buildings.json}), folded here by
 * {@link #fromCategory(Advisor)} — <i>not</i> from the plot's occupant firm. The
 * founding plot (plot 0, the village center) is seeded {@link #CITY_CENTER}. Because
 * the derivation is a pure function of the placed buildings, whichever layer holds the
 * building categories (the server render snapshot, joining {@code /api/buildings})
 * computes it; the engine owns the underlying state (the placed building ids and the
 * district count — {@link Settlement#getStartingDistrictCount()}).
 */
public enum DistrictType {

	/** The village center (plot 0) — the mixed core where the center-grouped firms, banks and (first cut) all buildings sit. */
	CITY_CENTER,
	/** Science district ({@link Advisor#SCIENCE}). */
	CAMPUS,
	/** Faith district ({@link Advisor#RELIGION}). */
	HOLY_SITE,
	/** Military district ({@link Advisor#MILITARY}). */
	ENCAMPMENT,
	/** Trade/economy district ({@link Advisor#ECONOMY}). */
	COMMERCIAL_HUB,
	/** Culture district ({@link Advisor#CULTURE}). */
	THEATER,
	/** Residential/growth district ({@link Advisor#GROWTH}). */
	NEIGHBORHOOD,
	/**
	 * The waterfront ({@code docs/towngen-port.md} §7a, T4b) — the wharves, warehouses and landings
	 * of a plot that fronts water on more than one side.
	 * <p>
	 * <b>The first district derived from LOCATION rather than from buildings</b>, and deliberately
	 * so: there is no {@code Advisor} branch for "is on the coast", and there could not be — the
	 * advisor axis classifies what people build, and a harbour is decided by where the water is.
	 * {@link #fromCategory} therefore never returns this, and a plot that raises harbour buildings
	 * still reads as {@link #COMMERCIAL_HUB} from its categories; the town generator's location
	 * scoring is the only thing that assigns it. If a harbour building line ever carries its own
	 * category, the two answers fold together here and nothing downstream changes.
	 */
	HARBOR;

	/**
	 * The district type a building of the given {@link Advisor} category contributes to
	 * a plot — the fold from the building taxonomy onto the district axis. A plot's type
	 * is the type of the buildings accumulated on it (the founding center overrides to
	 * {@link #CITY_CENTER}); an uncategorized building (empty advisor) contributes none.
	 *
	 * @param category the building's advisor branch, or {@link Optional#empty()} if uncategorized
	 * @return the district type it contributes, or {@link Optional#empty()} if none
	 */
	public static Optional<DistrictType> fromCategory(Optional<Advisor> category) {
		return category.map(DistrictType::fromCategory);
	}

	/**
	 * The district type a building of the given {@link Advisor} category contributes.
	 *
	 * @param category the building's advisor branch (non-null)
	 * @return the matching district type
	 */
	public static DistrictType fromCategory(Advisor category) {
		return switch (category) {
			case SCIENCE -> CAMPUS;
			case RELIGION -> HOLY_SITE;
			case MILITARY -> ENCAMPMENT;
			case ECONOMY -> COMMERCIAL_HUB;
			case CULTURE -> THEATER;
			case GROWTH -> NEIGHBORHOOD;
		};
	}
}
