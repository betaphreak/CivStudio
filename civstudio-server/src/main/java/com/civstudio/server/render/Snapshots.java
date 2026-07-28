package com.civstudio.server.render;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.civstudio.advisor.AdvisorRole;
import com.civstudio.agent.Agent;
import com.civstudio.agent.Caravan;
import com.civstudio.agent.Household;
import com.civstudio.agent.MarchingCaravan;
import com.civstudio.agent.Member;
import com.civstudio.agent.Retinue;
import com.civstudio.agent.firm.Firm;
import com.civstudio.geo.WorldMap;
import com.civstudio.market.ConsumerGoodMarket;
import com.civstudio.server.web.UnitBundle;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.Settlement;

/**
 * Assembles a {@link SessionSnapshot} — a read-only render projection — from a session's
 * live objects. Every read here is a plain getter over settled state; the assembler is
 * only ever called <b>on the session thread between ticks</b> (from {@code
 * HostedSession.emit}), never during {@code newDay}, so it sees no mid-step mutation and
 * never touches the live graph a client could reach. See {@code docs/client-server.md}.
 */
public final class Snapshots {

	private Snapshots() {
	}

	/**
	 * Project a hosted session's current state into a snapshot.
	 *
	 * @param sessionId  the session id
	 * @param seed       the session seed
	 * @param scenario   the founding scenario id
	 * @param clockState what the clock is doing (CREATED / RUNNING / PAUSED / STOPPED)
	 * @param outcome    the contest result (LIVE / WON / LOST / ABANDONED) — see {@code
	 *                   docs/session-management.md}
	 * @param endReason  why the run ended (display text), or {@code null} unless it ended itself — see
	 *                   {@code docs/game-over.md}
	 * @param tick       the authoritative tick (in-game days elapsed)
	 * @param date      the session's in-game date — its own clock ({@code HostedSession.date()}),
	 *                  not a poll of the colonies: a session whose colonies are all dead still
	 *                  knows what day it is. May be {@code null} for a caller with no clock, which
	 *                  reports an empty date exactly as an unknown one always did
	 * @param colonies  the session's colonies
	 * @param map       the world map (for caravan province names), or {@code null}
	 * @param caravans  the session's wandering bands
	 * @param log       the event-log lines since the previous frame (the live log bar's feed)
	 * @param routeDirty the ids of provinces whose route layer changed since the previous frame — the
	 *                   viewport-windowed feed's refetch signal (docs/route-rendering.md); drained
	 *                   from the session each emit by the caller
	 * @return the render snapshot
	 */
	public static SessionSnapshot of(String sessionId, long seed, String scenario,
			String clockState, String outcome, String endReason, long tick, LocalDate date,
			List<Settlement> colonies, WorldMap map, List<Caravan> caravans, List<LogLine> log,
			List<Integer> routeDirty) {
		List<ColonyView> colonyViews = new ArrayList<>(colonies.size());
		for (Settlement c : colonies)
			colonyViews.add(colonyView(c));
		List<CaravanView> caravanViews = new ArrayList<>(caravans.size());
		// the session's wandering bands (migration/dissolution), then each colony's own outstanding
		// explorer levies — colony-owned excursions, ticked by their home colony (docs/explorer-
		// caravan.md), so they are not in the session's caravan list. The route layer they pioneer is
		// no longer broadcast here — it rides the viewport-windowed feed (docs/route-rendering.md).
		for (Caravan band : caravans)
			caravanViews.add(caravanView(band, map));
		for (Settlement c : colonies)
			for (Caravan excursion : c.getExcursions())
				caravanViews.add(caravanView(excursion, map));
		// the B6 pause-and-choose surface: awaiting when any build-economy colony's ruler
		// queue is idle with no pending orders AND its heuristic is off (the seated-session
		// mode); candidates are the first such colony's brain-scored startable regulars
		boolean awaiting = false;
		List<String> candidates = List.of();
		for (Settlement c : colonies) {
			var be = c.getBuildEconomy();
			if (be != null && be.queueAwaitingChoice()) {
				awaiting = true;
				List<String> ids = new ArrayList<>();
				for (var b : be.buildableCandidates()) {
					ids.add(b.id());
					if (ids.size() >= 24)
						break;
				}
				candidates = ids;
				break;
			}
		}
		return new SessionSnapshot(sessionId, seed, scenario, clockState, outcome, endReason, tick,
				date == null ? "" : date.toString(), colonyViews, caravanViews, log, routeDirty,
				awaiting, candidates);
	}

	// project one colony's aggregates — the same tally the annual digest and CSV printers
	// take (see Settlement.logAnnualDigest), read between ticks so the population is settled
	private static ColonyView colonyView(Settlement c) {
		LocalDate date = c.getDate();
		int population = 0, children = 0, nobles = 0, firms = 0, pool = 0;
		for (Agent a : c.getAgents()) {
			if (!a.isAlive())
				continue;
			if (a instanceof Retinue r) {
				pool += r.size();
				children += r.childCount(date);
			} else if (a instanceof Firm) {
				firms++;
			} else if (a instanceof Household h) {
				if (h.isWorkforce()) {
					population++;
					for (Member m : h.getMembers())
						if (!m.isAdult(date))
							children++;
				} else if ("Noble".equals(h.role())) {
					nobles++;
				}
			}
		}
		double necessity = marketPrice(c, "Necessity");
		double enjoyment = marketPrice(c, "Enjoyment");
		// the ruler's current tax levers (0 when the colony has no ruler) — the read-side of
		// the Phase-B tax command, so a client sees policy changes land
		com.civstudio.agent.ruler.Ruler ruler = c.getRuler();
		double bankProfitTax = ruler == null ? 0 : ruler.getBankProfitTaxRate();
		double nobleIncomeTax = ruler == null ? 0 : ruler.getNobleIncomeTaxRate();
		// the colony's known techs (pre-known baseline + researched) — drives the web tech tree's
		// unlocked styling; sorted for a stable projection, empty when research is disabled
		var research = c.getResearch();
		List<String> knownTechs = research == null ? List.of()
				: research.getKnown().stream().sorted().toList();
		// the tech currently being researched + fractional progress (the read-side of the ruler's
		// monthly research pick) — the web shows it live on the Technology segment
		String researchingTech = null;
		double researchProgress = 0;
		if (research != null && research.getFocus() != null) {
			researchingTech = research.getFocus().type();
			double cost = research.effectiveCost();
			researchProgress = cost > 0 ? Math.min(1.0, research.getProgress() / cost) : 0;
		}
		// the district state the web view stamps: the starting district count (province
		// development), the culture (→ art-style set), and the plots carrying buildings
		// (sparse — auto-build puts everything at the center in the first cut). See
		// docs/district-buildout.md Phase D3.
		String culture = c.getProvince() == null ? null : c.getProvince().culture();
		List<DistrictView> districts = districtViews(c);
		// the province the colony sits in. The view already ships lat/lon, but a client cannot turn
		// those back into a province without inverting the map projection — so a rail that wants to
		// show "this province holds the live colony" needs the id said outright.
		int provinceId = c.getProvince() == null ? 0 : c.getProvince().id();
		// the city-center plot — the water-first plot the colony founded on. The lat/lon above are
		// the PROVINCE's anchor, which can sit a plot or two off the real centre, so the district
		// view needs the centre said outright rather than inferred from them.
		Plot center = c.getCityCenter();
		Integer centerX = center == null ? null : center.x();
		Integer centerY = center == null ? null : center.y();
		return new ColonyView(c.getName(), c.isAlive(), date.toString(), population,
				children, nobles, firms, pool, c.getInflation(), necessity, enjoyment,
				c.getPlotCount(), c.getMaxPlots(), c.getLatitude(), c.getLongitude(),
				bankProfitTax, nobleIncomeTax, advisorViews(c), knownTechs,
				c.getStartingDistrictCount(), culture, districts, researchingTech, researchProgress,
				c.getTier() == null ? null : c.getTier().name(), provinceId, centerX, centerY,
				queueView(c),
				// the TOWN DIRTY FLAG (docs/towngen-port.md §1 Transport, T7). The layout itself never
				// rides the snapshot — it is hundreds of polygons and only a client past band 5.5 wants
				// any of them — so all that travels is a hash of the state the layout is derived from.
				// It changes exactly when the town would look different, which is the client's cue to
				// re-fetch and the store's cue to recompute. One function, both callers.
				com.civstudio.server.town.TownSignature.of(c));
	}

	// project EVERY plot of the colony — where it is, what stands on it, and what is rising
	// on it (the city screen lays out the whole settlement; the plot count is province-capped).
	// Buildings are bare ids the client joins against /api/buildings, plus whose they are; the
	// x/y is what lets a client draw a building on the plot it actually stands on. See
	// docs/district-buildout.md Phase D3 and docs/city-screen-plan.md.
	private static List<DistrictView> districtViews(Settlement c) {
		List<Plot> plots = c.getDistrictPlots();
		if (plots.isEmpty())
			return List.of();
		// index the in-flight work by the plot it rises on, so each plot's projection is one
		// map lookup rather than a scan of every household
		java.util.Map<Plot, List<DistrictView.Underway>> underway = underwayByPlot(c, plots.get(0));
		java.util.Map<Integer, String> owners = ownerKinds(c);
		java.util.Map<Integer, String> ownerNames = ownerSurnames(c);
		// resident households per plot — the same hamlet grouping the engine projects (V1), so the
		// city screen's "N households" agrees with Settlement.hamlets()
		java.util.Map<Plot, List<com.civstudio.agent.laborer.Laborer>> byHome = c.householdsByHomePlot();
		// how many necessity farms work for each hamlet (city-of-hamlets V3) — counted once rather
		// than rescanned per plot
		java.util.Map<Plot, Integer> farmsByVillage = new java.util.IdentityHashMap<>();
		for (com.civstudio.agent.Agent a : c.getAgents())
			if (a.isAlive() && a instanceof com.civstudio.agent.firm.NFirm f && f.getVillage() != null)
				farmsByVillage.merge(f.getVillage(), 1, Integer::sum);
		List<DistrictView> views = new ArrayList<>();
		for (int i = 0; i < plots.size(); i++) {
			Plot p = plots.get(i);
			List<DistrictView.PlacedBuilding> buildings = p.buildings().stream()
					.map(b -> new DistrictView.PlacedBuilding(b.id(),
							owners.getOrDefault(b.ownerId(), "NONE"),
							ownerNames.get(b.ownerId())))
					.toList();
			// the plot's fief-lord (the noble/ruler that holds it), by surname — null = Crown demesne
			String fiefLord = p.ownerId() == null ? null : ownerNames.get(p.ownerId());
			int households = byHome.getOrDefault(p, List.of()).size();
			// the improvement raised on the plot, as its bare IMPROVEMENT_* key — the client joins it
			// against the baked Civ4 improvement sprites (docs/terrain-3d.md §P5a)
			String improvement = p.improvement() == null ? null : p.improvement().type();
			views.add(new DistrictView(i, p.x(), p.y(), buildings,
					underway.getOrDefault(p, List.of()), fiefLord, households,
					c.villageLarderStock(p), c.villageLarderFloor(p),
					farmsByVillage.getOrDefault(p, 0), improvement));
		}
		return views;
	}

	// every construction in flight in the colony, keyed by the plot it rises on: the crown's
	// active queue item (at the center), each landed household's housing or own-building
	// self-build (on its home plot), and the BuilderFirm's elite housing commissions.
	private static java.util.Map<Plot, List<DistrictView.Underway>> underwayByPlot(Settlement c,
			Plot center) {
		java.util.Map<Plot, List<DistrictView.Underway>> byPlot = new java.util.IdentityHashMap<>();
		var economy = c.getBuildEconomy();
		if (economy != null && economy.getActiveBuildId() != null)
			byPlot.computeIfAbsent(center, k -> new ArrayList<>())
					.add(new DistrictView.Underway(economy.getActiveBuildId(),
							economy.getActiveCost(),
							economy.getActiveCost() - economy.getActiveRemaining(), "RULER", null));
		for (Agent a : c.getAgents()) {
			if (!a.isAlive() || !(a instanceof com.civstudio.agent.laborer.Laborer l))
				continue;
			Plot home = l.getHomePlot();
			if (home == null)
				continue;
			String surname = l.getHead() == null ? null : l.getHead().surname();
			addProject(byPlot, home, l.getHousingProject(), "HOUSEHOLD", surname);
			addProject(byPlot, home, l.getUpgradeProject(), "HOUSEHOLD", surname);
		}
		// the builder's queue: only its BUILDING legs (elite housing commissions) are a
		// construction on a standing plot — a clearance task is a plot that does not exist yet
		for (com.civstudio.settlement.BuildProject p : c.getActiveProjects()) {
			if (!p.isBuildingCommission())
				continue;
			var owner = p.getBuildingOwner();
			String ownerName = owner instanceof com.civstudio.agent.AbstractHousehold h
					&& h.getHead() != null ? h.getHead().surname() : null;
			byPlot.computeIfAbsent(p.getPlot(), k -> new ArrayList<>())
					.add(new DistrictView.Underway(p.getBuildingId(), p.getWorkTotal(),
							p.getWorkTotal() - p.getWorkRemaining(),
							owner instanceof com.civstudio.agent.ruler.Ruler ? "RULER" : "NOBLE",
							ownerName));
		}
		return byPlot;
	}

	private static void addProject(java.util.Map<Plot, List<DistrictView.Underway>> byPlot,
			Plot plot, com.civstudio.agent.laborer.Laborer.HomeProject project, String owner,
			String ownerName) {
		if (project == null || project.cost() <= 0)
			return;
		byPlot.computeIfAbsent(plot, k -> new ArrayList<>()).add(new DistrictView.Underway(
				project.id(), project.cost(), project.progress(), owner, ownerName));
	}

	// agent id -> the coarse owner class the client renders (the id itself is meaningless to a
	// spectator). Built once per projection rather than scanned per building: a mature colony has
	// hundreds of buildings and hundreds of agents, and the naive form is their product. An id
	// that is absent — a null owner, or an owner that has since died — reads as unowned, which is
	// exactly right: the building outlives its builder.
	private static java.util.Map<Integer, String> ownerKinds(Settlement c) {
		java.util.Map<Integer, String> kinds = new java.util.HashMap<>();
		for (Agent a : c.getAgents())
			if (a instanceof com.civstudio.agent.AbstractHousehold)
				kinds.put(a.getID(), a instanceof com.civstudio.agent.ruler.Ruler ? "RULER"
						: a instanceof com.civstudio.agent.noble.Noble ? "NOBLE" : "HOUSEHOLD");
		return kinds;
	}

	// agent id -> the owning household's surname, so a house can be named for the family that
	// raised it. Same shape and reasoning as ownerKinds (built once, absent id reads as unnamed);
	// the head can be null on a freshly emptied household, which reads as no name.
	private static java.util.Map<Integer, String> ownerSurnames(Settlement c) {
		java.util.Map<Integer, String> names = new java.util.HashMap<>();
		for (Agent a : c.getAgents())
			if (a instanceof com.civstudio.agent.AbstractHousehold h && h.getHead() != null)
				names.put(a.getID(), h.getHead().surname());
		return names;
	}

	// the crown's build queue (B4/B6): the active item + progress + the player's pending
	// orders. NONE for a colony without the build economy.
	private static BuildQueueView queueView(Settlement c) {
		var economy = c.getBuildEconomy();
		if (economy == null)
			return BuildQueueView.NONE;
		return new BuildQueueView(economy.getActiveBuildId(), economy.getActiveCost(),
				economy.getActiveRemaining(), List.copyOf(economy.getPendingOrders()),
				economy.getDonationRate(), economy.queueAwaitingChoice());
	}

	// project the colony's privy council: the court member seated in each filled advisor
	// role (see AdvisorRoster). Unfilled roles are omitted — the frontend greys them.
	private static List<AdvisorView> advisorViews(Settlement c) {
		// the colony's Anbennar culture (from its founding province) — the finer portrait selector;
		// null for a colony founded at bare coordinates (the analytical sims have no province)
		String culture = c.getProvince() == null ? null : c.getProvince().culture();
		List<AdvisorView> views = new ArrayList<>();
		for (AdvisorRole role : AdvisorRole.values()) {
			Household seat = c.getAdvisorRoster().holder(role);
			if (seat == null)
				continue;
			Member head = seat.getHead();
			views.add(new AdvisorView(role.id(), seat.getID(), head.fullName(),
					head.race().id(), head.gender().name().toLowerCase(Locale.ROOT), culture));
		}
		return views;
	}

	// the last clearing price of a colony's consumer-good market by good name (0 if absent)
	private static double marketPrice(Settlement c, String good) {
		for (ConsumerGoodMarket m : c.getConsumerGoodMarkets())
			if (good.equals(m.getGood()))
				return m.getLastMktPrice();
		return 0;
	}

	// project one band's position + vitals; the province name needs the world map (the
	// band carries only an id), so a null map degrades the label to the raw id
	private static CaravanView caravanView(Caravan band, WorldMap map) {
		Member leader = band.getLeader();
		String leaderName = leader == null ? "?" : leader.fullName();
		boolean onGraph = band.onGraph();
		String province;
		if (!onGraph)
			province = "(off graph)";
		else if (map != null)
			province = map.province(band.getProvinceId()).name();
		else
			province = "#" + band.getProvinceId();
		int bandSize = 0;
		double larder = 0;
		boolean settled = false;
		String unitId = null, unitName = null, signatureSkill = null;
		int[] unitIcon = null;
		int leaderSkill = 0;
		if (band instanceof MarchingCaravan m) {
			// the march reads only the MarchFollowing slice (size + larder); a Retinue and a
			// DraftBand both satisfy it (docs/explorer-caravan.md)
			var following = m.getFollowing();
			bandSize = following.size();
			larder = following.getLarder();
			settled = m.hasArrived();
			// the role signature skill + leader level read out for any marching band; the embodied
			// unit's identity/art (docs/c2c-unit-import.md §1a) only when the colony fielded one
			signatureSkill = m.signatureSkill().name();
			leaderSkill = m.leaderSkillLevel();
			unitId = m.getUnitId();
			if (unitId != null) {
				unitName = m.getUnitName();
				unitIcon = UnitBundle.iconRect(unitId);
			}
		}
		return new CaravanView(band.getId(), leaderName, leaderName, band.getLatitude(),
				band.getLongitude(), onGraph ? band.getProvinceId() : -1, province, onGraph,
				settled, bandSize, larder, band.getHoard(), band.role().name(),
				unitId, unitName, unitIcon, signatureSkill, leaderSkill);
	}
}
