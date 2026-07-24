package com.civstudio.settlement;

import java.util.IdentityHashMap;
import java.util.Map;

import com.civstudio.agent.Agent;
import com.civstudio.agent.Household;
import com.civstudio.bank.Account;
import com.civstudio.bank.Bank;
import com.civstudio.good.RationSize;
import com.civstudio.market.ConsumerGoodMarket;
import com.civstudio.market.Demand;

/**
 * The <b>village-larder subsystem</b> (city-of-hamlets V2, {@code docs/city-of-hamlets-plan.md}): the
 * per-hamlet {@link Larder} food pools that organize a city's food per <b>village</b> rather than per
 * household, and the daily <b>provisioning</b> that keeps them stocked. Present only when {@code
 * SimulationConfig.villageLarder} is on ({@link Settlement#enableVillageLarders()}); a flag-off colony
 * never builds one and stays byte-identical (its {@link Settlement#getVillageLarders()} is {@code
 * null}, and food keeps running through the per-household necessity stock).
 * <p>
 * <b>The provisioned floor.</b> A village's peasant households eat from its larder for free (the lord
 * feeds his vassals); the larder is filled by their home-plot subsistence and topped up by the
 * village's <b>leader</b> (its fief-holder {@link com.civstudio.agent.noble.Noble}, or the {@link
 * com.civstudio.agent.ruler.Ruler} for Crown demesne) buying the deficit on the shared Necessity
 * market. The leader <em>pays</em> — so the village is the market's food participant and its demand
 * drives price discovery — but the food is delivered into the larder, via the market's
 * delivery-target seam ({@link ConsumerGoodMarket#addBuyOffer(Agent, com.civstudio.good.Good,
 * Demand)}). A leader buys only what its purse affords, so a poor lord under-provisions (its village
 * goes hungry — the failure the survival tests gate) rather than borrowing without bound.
 */
public final class VillageLarders {

	// the larder floor the leader tops up to, in DAYS of the village's daily ration need — a buffer so
	// a single day's timing or a thin market does not starve the village. Also the size of the
	// founding endowment a larder opens with (see larderFor).
	private static final int FLOOR_DAYS = 5;

	// the owning colony, for the hamlet grouping, market and leaders the provisioning reads
	private final Settlement colony;

	// one larder per hamlet, keyed by its seat plot identity (IdentityHashMap: two distinct plots
	// with equal fields never share a larder)
	private final Map<Plot, Larder> larders = new IdentityHashMap<>();

	// the day's larder floor targets (seat -> FLOOR_DAYS * dailyNeed), memoized per step: the V3
	// village farms ask for them mid-act, once per farm, and each answer would otherwise rescan the
	// whole agent list. One reading per day is also the honest model — a village's ration need is a
	// standing fact of the day, not something that moves as agents act.
	private final Map<Plot, Double> floors = new IdentityHashMap<>();
	private int floorsStep = -1;

	VillageLarders(Settlement colony) {
		this.colony = colony;
	}

	/**
	 * The larder for a hamlet whose seat is {@code seat}, created (and pre-stocked with the founding
	 * buffer) on first use so every hamlet the colony projects has exactly one.
	 *
	 * @param seat the hamlet's seat plot
	 * @return the hamlet's larder (never {@code null})
	 */
	Larder larderFor(Plot seat) {
		return larders.computeIfAbsent(seat, k -> {
			Larder l = new Larder();
			// the founding endowment, so the village's first day of eating — before its leader's first
			// import settles at that day's market clear — is fed: the village's OWN floor, so it opens
			// exactly at the level it is thereafter held at. A flat endowment was the first cut and
			// does not survive contact with the shipped colony — a city runs hundreds of one-household
			// villages, so any per-village constant is multiplied by hundreds into a large one-off food
			// injection out of nothing (a flat 100 was ~100 days of the whole colony's ration need).
			l.stock(floorFor(seat));
			return l;
		});
	}

	/**
	 * The larder for a hamlet whose seat is {@code seat}, or {@code null} if none has been created yet
	 * — a non-creating lookup.
	 *
	 * @param seat the hamlet's seat plot
	 * @return the existing larder, or {@code null}
	 */
	Larder larderIfPresent(Plot seat) {
		return larders.get(seat);
	}

	/** How many hamlet larders exist (a test/report seam). */
	int count() {
		return larders.size();
	}

	/**
	 * <b>Provision the village larders</b> — for each hamlet, its leader posts a buy offer for the
	 * larder's food deficit (the {@link #FLOOR_DAYS}-day floor minus what is left after the day's
	 * eating), funded by the leader's account and delivered into the larder. Called by {@link
	 * Settlement#newDay()} in the act phase, after households have eaten and before the market clears,
	 * so the fill lands for the next day. A price-sensitive, purse-capped demand: a leader buys up to
	 * the deficit but spends no more than it holds.
	 */
	void provision() {
		if (!(colony.getMarket("Necessity") instanceof ConsumerGoodMarket nMkt))
			return;
		for (Hamlet ham : colony.hamlets()) {
			Larder larder = larderFor(ham.seat());
			double deficit = floorFor(ham.seat()) - larder.available();
			if (deficit <= 0)
				continue;
			Agent leader = leaderOf(ham.seat());
			if (leader == null)
				continue;
			double budget = purseOf(leader);
			// buy up to the deficit, spending at most the leader's purse: a poor lord under-provisions
			// (its village goes hungry) rather than borrowing without bound
			Demand d = price -> price <= 0 ? deficit : Math.min(deficit, budget / price);
			nMkt.addBuyOffer(leader, larder.good(), d);
		}
	}

	/**
	 * <b>Deliver a village farm's produce into its own village's larder</b> (city-of-hamlets V3) — the
	 * local sale that happens instead of putting that food on the shared market. The village's leader
	 * <b>buys</b> it from {@code farm} at the going market price, so this moves money exactly as a
	 * market fill would (the farm keeps the revenue that funds its wage bill; the leader pays the
	 * provisioning cost it would otherwise have paid an outside seller) — it is a transaction routed
	 * around the market, not a free transfer.
	 * <p>
	 * Two caps make it degrade gracefully: the larder takes only up to its {@link #FLOOR_DAYS} floor
	 * (so a well-stocked village exports the rest rather than hoarding), and the leader buys only what
	 * its purse affords (a poor lord takes less in, and the remainder goes to market as usual).
	 *
	 * @param farm    the village's necessity farm, the seller
	 * @param seat    the village's seat plot
	 * @param offered the produce the farm has on hand
	 * @return the quantity actually taken into the larder (the caller decreases its stock by it)
	 */
	double deposit(Agent farm, Plot seat, double offered) {
		if (offered <= 0 || !(colony.getMarket("Necessity") instanceof ConsumerGoodMarket nMkt))
			return 0;
		Larder larder = larderFor(seat);
		double qty = Math.min(offered, floorFor(seat) - larder.available());
		if (qty <= 0)
			return 0;
		Agent leader = leaderOf(seat);
		if (leader == null)
			return 0;
		// the going price — what the food would have fetched on the market this step. Below the first
		// clearing there is none yet, so the village simply waits for the market to open.
		double price = nMkt.getLastMktPrice();
		if (!(price > 0))
			return 0;
		qty = Math.min(qty, purseOf(leader) / price);
		if (qty <= 0)
			return 0;
		leader.getBank().withdraw(leader.getID(), qty * price);
		farm.getBank().credit(farm.getID(), qty * price, Bank.PRIIC);
		larder.stock(qty);
		return qty;
	}

	// the village's leader — its fief-holder noble (resolved by id), or the Crown for a demesne
	// village. getHouseholdById returns only a LIVING household and special-cases the ruler; the ruler
	// itself (the demesne path) is re-checked, since a Noble/Ruler is always an Agent. Null when the
	// village is leaderless this step (a dead lord before its heir is seated).
	private Agent leaderOf(Plot seat) {
		Household leader = seat.ownerId() == null
				? colony.getRuler()
				: colony.getHouseholdById(seat.ownerId());
		return leader instanceof Agent a && a.isAlive() ? a : null;
	}

	/**
	 * What a leader can spend on its village's food today: its whole liquid purse — a lord's
	 * provisioning is not budgeted separately from the rest of its money — <b>except for the Crown,
	 * which provisions on credit</b> (an unbounded purse).
	 * <p>
	 * The purse cap exists so a poor <em>noble</em> under-provisions rather than borrowing without
	 * bound. The sovereign is not that kind of lord: it already runs its whole treasury as a standing
	 * overdraft (its savings <em>is</em> a loan, funding research and the firms it charters), it has
	 * the taxing power the nobles do not, and feeding its demesne is an obligation of the realm rather
	 * than a discretionary purchase. Capping it just meant a demesne village was never provisioned at
	 * all — the crown's treasury is structurally negative from the first year, so {@code max(0, …)}
	 * read as zero forever, and the duty was nominal.
	 * <p>
	 * The credit line is its <b>bank's equity</b> — the realm's accumulated wealth, which is what a
	 * sovereign actually borrows against — rather than an unbounded purse. Finite on purpose: the
	 * demand curve is {@code min(deficit, budget / price)}, so an unbounded budget would make the
	 * crown's food demand perfectly <em>inelastic</em>, bidding for the full deficit at any price. A
	 * price-insensitive buyer against a thin market is a price ratchet, and it would also poison the
	 * market's binary search (a demand of {@code Infinity} never converges on supply). The equity line
	 * is a few thousand against a provisioning bill measured in tens, so it binds in practice only
	 * when the realm itself is destitute.
	 *
	 * @param leader the village's leader
	 * @return what it may spend on its villages' food today
	 */
	private double purseOf(Agent leader) {
		Account acct = leader.getBank().getAcct(leader.getID());
		double cash = acct == null ? 0 : Math.max(0, acct.getChecking() + acct.getSavings());
		return leader == colony.getRuler()
				? cash + Math.max(0, leader.getBank().getEquity())
				: cash;
	}

	/**
	 * The level a village's larder is held at — {@link #FLOOR_DAYS} days of its households' ration
	 * need, read once per step (see the floors memo). A seat with no hamlet on it this step — its
	 * households have gone — has a floor of 0, so nothing is bought or delivered into a larder no one
	 * eats from. Read against {@link Larder#available()} it also says whether a village is <b>fed</b>
	 * or going hungry, which is what the city screen reports.
	 *
	 * @param seat the hamlet's seat plot
	 * @return the larder's floor in necessity units
	 */
	double floorFor(Plot seat) {
		if (floorsStep != colony.getTimeStep()) {
			floors.clear();
			floorsStep = colony.getTimeStep();
			for (Hamlet ham : colony.hamlets())
				floors.put(ham.seat(), FLOOR_DAYS * dailyNeed(ham));
		}
		return floors.getOrDefault(seat, 0.0);
	}

	// the village's daily food need: a worker ration per resident person (an over-estimate — children
	// eat a smaller ration — so the floor carries a little slack). Reads the hamlet's households.
	private double dailyNeed(Hamlet ham) {
		double need = 0;
		for (var h : ham.households())
			need += h.getMemberCount() * RationSize.FINE.perDay();
		return need;
	}
}
