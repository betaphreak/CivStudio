package com.civstudio.server.render;

import java.util.List;

/**
 * A read-only projection of one {@link com.civstudio.settlement.Settlement colony} for the
 * live feed — the same aggregates the annual digest and the CSV printers report, gathered
 * into an immutable, JSON-serializable record. Assembled on the session thread by {@link
 * Snapshots} between ticks (never during {@code newDay}), so its reads see a settled
 * population.
 *
 * @param name           the colony's name
 * @param alive          whether the colony is still running
 * @param date           the colony's current in-game date (ISO-8601)
 * @param population     the workforce (laborer households)
 * @param children       under-age members (household-born + pool wards)
 * @param nobles         noble households
 * @param firms          living firms
 * @param poolSize       peasant-pool reserve size
 * @param cpi            the colony's <b>average daily inflation rate</b> as a fraction, rolling-averaged
 *                       over {@code Settlement.INFLATION_TIME_WIN} ({@code Settlement#getInflation()}).
 *                       <b>The name is a legacy misnomer</b>: this is NOT the price index
 *                       ({@code Settlement#getCPI()}, the mean consumer-good price) — it is the rate at
 *                       which that index is moving, per STEP, i.e. per in-game day. A client showing it
 *                       raw shows "0.00"; the web annualizes it (see {@code web/js/num.mjs}). Kept under
 *                       the old wire name so existing consumers do not break
 * @param necessityPrice last clearing price of the necessity (food) market
 * @param enjoymentPrice last clearing price of the enjoyment market
 * @param plotCount      claimed build plots
 * @param maxPlots       the colony's plot ceiling (its province cap)
 * @param latitude       the colony's latitude (decimal degrees) — the map anchor
 * @param longitude      the colony's longitude (decimal degrees)
 * @param bankProfitTax  the ruler's bank-profit tax rate (the player-set lever), 0 if none
 * @param nobleIncomeTax the ruler's noble-income tax rate (the player-set lever), 0 if none
 * @param advisors       the colony's privy council — the court noble seated in each
 *                       filled advisor role (unfilled roles are absent)
 * @param knownTechs     the tech ids this colony knows (its pre-known baseline plus what it has
 *                       researched) — drives the web tech tree's researched (unlocked) styling;
 *                       empty when the colony has no research state
 * @param startingDistricts the number of districts the city begins with — its founding province's
 *                       EU4 1444 development (ADM+DIP+MIL), capped at the province plots; 0 for a
 *                       province-less colony (see {@code docs/district-buildout.md} Phase D1)
 * @param culture        the colony's Anbennar culture (from its founding province) — the web folds
 *                       it to a district art-style set (D5); {@code null} for a province-less colony
 * @param districts      the district plots carrying buildings (the placed-building state the district
 *                       view stamps); empty until auto-build places anything. See {@link DistrictView}
 * @param researchingTech the tech id the colony is currently researching (its research focus), or
 *                       {@code null} when nothing is being researched — drives the Technology segment
 * @param researchProgress fraction (0..1) of the current focus's cost accumulated so far; 0 when
 *                       there is no focus
 * @param tier           the rung the colony sits on the {@link com.civstudio.settlement.SettlementTier}
 *                       ladder ({@code CAMP < COTTAGE < HAMLET < SMALLHOLDING < TOWN < METROPOLIS}),
 *                       as the raw enum name — the web Title Cases it for the Settlement-band caption
 *                       (see {@code docs/zoom-bands.md} §Band caption). {@code null} for a colony with
 *                       no tier set
 * @param provinceId     the province the colony sits in, or 0 when it has none. The view already
 *                       ships {@code latitude}/{@code longitude}, but a client cannot turn those back
 *                       into a province without inverting the map projection — so the web rail reads
 *                       this to show a selected province's live colony inline
 * @param centerX        the raster x of the colony's {@linkplain com.civstudio.settlement.Settlement#getCityCenter()
 *                       city-center plot} — the water-first plot the colony actually founded on, in the
 *                       same source-pixel space as the web's plot coordinates. {@code null} when no plot
 *                       is laid yet. The colony's {@code latitude}/{@code longitude} are its
 *                       <b>province's</b> anchor, not its centre (see {@code docs/urban-plots.md}), so a
 *                       client with only those rings the wrong plot — this says the centre outright
 * @param centerY        the raster y of the city-center plot, or {@code null} when no plot is laid
 * @param queue          the crown's build queue — what it is building, how far along, and what is
 *                       ordered behind it (see {@link BuildQueueView}); {@link BuildQueueView#NONE}
 *                       for a colony with no build economy
 */
public record ColonyView(String name, boolean alive, String date, int population,
		int children, int nobles, int firms, int poolSize, double cpi,
		double necessityPrice, double enjoymentPrice, int plotCount, int maxPlots,
		double latitude, double longitude, double bankProfitTax, double nobleIncomeTax,
		List<AdvisorView> advisors, List<String> knownTechs, int startingDistricts,
		String culture, List<DistrictView> districts,
		String researchingTech, double researchProgress, String tier, int provinceId,
		Integer centerX, Integer centerY, BuildQueueView queue) {
}
