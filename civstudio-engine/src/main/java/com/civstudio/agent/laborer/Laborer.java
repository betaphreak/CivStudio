package com.civstudio.agent.laborer;

import java.time.LocalDate;
import java.util.logging.Level;

import com.civstudio.agent.AbstractHousehold;
import com.civstudio.agent.Granary;
import com.civstudio.agent.Member;
import com.civstudio.agent.Rank;
import com.civstudio.calendar.DayType;
import com.civstudio.settlement.BuildEconomy;
import com.civstudio.io.SimLog;
import com.civstudio.race.Race;
import com.civstudio.bank.Bank;
import com.civstudio.bank.Account;
import com.civstudio.settlement.Plot;
import com.civstudio.settlement.Settlement;
import com.civstudio.good.Enjoyment;
import com.civstudio.good.Good;
import com.civstudio.good.Necessity;
import com.civstudio.market.ConsumerGoodMarket;
import com.civstudio.market.LaborMarket;
import com.civstudio.market.Demand;
import lombok.Getter;
import lombok.extern.java.Log;

/**
 * Laborer
 *
 * @author zhihongx
 *
 */
@Log
public class Laborer extends AbstractHousehold {

	// tunable model parameters
	private final LaborerConfig config;

	// true until this household's first act(): seeds consumption and the
	// interest-rate window. A successor born after step 0 must bootstrap just
	// like the founding cohort did, otherwise its multiplicative consumption
	// adjustment stays pinned at 0 and it hoards all income.
	private boolean firstAct = true;

	// enjoyment market
	private final ConsumerGoodMarket eMkt;

	// necessity market
	private final ConsumerGoodMarket nMkt;

	// labor market
	private final LaborMarket lMkt;

	// enjoyment good
	private final Enjoyment enjoyment;

	// necessity good
	private final Necessity necessity;

	// savings rate (portion of total income+savings that is saved in the last
	// step)
	@Getter
	private double savingsRate;

	// consumption (in $)
	@Getter
	private double consumption;

	// consumption of enjoyment (in $)
	@Getter
	private double eConsumption;

	// consumption of necessity (in $)
	@Getter
	private double nConsumption;

	// minimum necessity (in real quantity) to buy in the current step
	private double minN;

	// lowest real interest rate seen
	private double lowRR;

	// highest real interest rate seen
	private double highRR;

	// demand for enjoyment: spend the enjoyment budget at the going price
	private final Demand demandForE = price -> eConsumption / price;

	// demand for necessity: spend the necessity budget, but never below the
	// minimum real quantity needed to eat
	private final Demand demandForN = price -> Math.max(nConsumption / price, minN);

	// total income
	@Getter
	private double income;

	// wage from employment
	@Getter
	private double wage;

	// the home plot this landed household farms for its own subsistence food (its yield
	// drops straight into the necessity larder each step, outside the market — see act()),
	// or null for a landless household (the pool overflow, or a colony without home plots).
	// Assigned at founding/promotion by the harness; freed on death. See docs/plot-working-plan.md P1.
	@Getter
	private Plot homePlot;

	// --- the occupation choice (build economy, docs/build-queue-plan.md B1) ---------------
	// Active only on a build-economy colony (Settlement.getBuildEconomy() != null) for a
	// landed household; otherwise none of these are read and behavior is byte-identical.

	// current occupation: false = sell labor at the center (the default), true = stay and
	// work the home plot for hammers + commerce. Re-evaluated on workdays with hysteresis.
	private boolean plotWorker;

	// the last realized wage of a MARKET-chosen day (acct.priIC read the morning after) —
	// the reservation-wage comparand. A 0 here means the household offered labor and was
	// left unhired (the labor-surplus signal that pushes it toward the plot).
	private double lastMarketWage;

	// the optimism prior: until the household has been paid at least once, it assumes the
	// market beats the plot (goes to market), so founding-day behavior matches today's and
	// wages get discovered. Flips on the first positive realized wage.
	private boolean everPaid;

	// whether yesterday was a plot-chosen day, so this morning's acct.priIC (necessarily 0)
	// is NOT mistaken for a rejected market day when updating lastMarketWage
	private boolean plotDayYesterday;

	// --- housing (build economy B3, docs/build-queue-plan.md) -----------------------------

	// the house this household owns on its home plot, or null while homeless. Set on
	// completion of its housing project or by adopting an orphaned house on its plot;
	// orphaned (owner cleared) when the household dies, so the successor re-adopts it.
	@Getter
	private Plot houseOnPlot; // the plot the house stands on (== homePlot when built)
	private com.civstudio.settlement.Building house;

	// the housing self-build project: the target rung id + cost, and the hammers paid in
	private String targetRungId;
	private double targetRungCost;
	private double houseProgress;

	/**
	 * A construction this household is paying its own plot hammers into — its house
	 * (the {@code BUILDING_HOUSING_*} rung it is raising) or, once housed, the next
	 * housing rung up it is upgrading to (B5). The read side of the two self-build slots:
	 * what is rising on this household's home plot, and how far along.
	 *
	 * @param id       the catalog id being built
	 * @param cost     the hammers the building needs in total
	 * @param progress the hammers paid in so far
	 */
	public record HomeProject(String id, double cost, double progress) {
	}

	/**
	 * The housing rung this household is currently raising on its home plot, or
	 * {@code null} when it is housed (or has nothing targeted yet).
	 *
	 * @return the housing project, or {@code null}
	 */
	public HomeProject getHousingProject() {
		return targetRungId == null ? null
				: new HomeProject(targetRungId, targetRungCost, houseProgress);
	}

	/**
	 * The housing rung this (housed) household is upgrading to on its home plot with its
	 * own hammers (B5), or {@code null} when it is building none (at the top of the ladder).
	 *
	 * @return the housing-upgrade project, or {@code null}
	 */
	public HomeProject getUpgradeProject() {
		return targetUpgradeId == null ? null
				: new HomeProject(targetUpgradeId, targetUpgradeCost, upgradeProgress);
	}

	// larder days of food required for a homeless household to stay home and build
	// rather than earn (the homeless-and-FED rule; survival wages beat house-building
	// when the larder is short). UNCALIBRATED.
	private static final double FED_DAYS = 2;

	/**
	 * Create a new laborer
	 *
	 * @param initEQty
	 *            initial enjoyment quantity
	 * @param initNQty
	 *            initial necessity quantity
	 * @param initCheckingBal
	 *            initial checking account balance
	 * @param initSavingsBal
	 *            initial savings account balance
	 * @param initSavingsRate
	 *            initial savings rate
	 * @param config
	 *            tunable model parameters
	 * @param bank
	 *            the bank at which this laborer holds its accounts
	 * @param colony
	 *            the colony this laborer belongs to
	 */
	public Laborer(double initEQty, double initNQty, double initCheckingBal,
			double initSavingsBal, double initSavingsRate, LaborerConfig config,
			Bank bank, Settlement colony) {
		// a founding (pool-less) laborer takes the colony's founding race
		this(initEQty, initNQty, initCheckingBal, initSavingsBal, false,
				initSavingsRate, config, bank, colony, null,
				colony.getFoundingRace());
	}

	/**
	 * Create a brand-new household funded out of the bank's equity rather than a
	 * fresh endowment — an externally-bankrolled immigrant settling in an open
	 * colony. It starts a new dynasty (a fresh working-age head with a unique
	 * surname); its opening balances are drawn from equity (so the external
	 * money that fed equity now circulates), as for a successor household.
	 *
	 * @param initEQty
	 *            initial enjoyment quantity
	 * @param initNQty
	 *            initial necessity quantity
	 * @param initCheckingBal
	 *            initial checking account balance (drawn from equity)
	 * @param initSavingsBal
	 *            initial savings account balance (drawn from equity)
	 * @param initSavingsRate
	 *            initial savings rate
	 * @param config
	 *            tunable model parameters
	 * @param bank
	 *            the bank at which this laborer holds its accounts
	 * @param colony
	 *            the colony this laborer belongs to
	 * @param fundedFromEquity
	 *            must be true; selects equity funding over a fresh endowment
	 *            (distinguishes this constructor from the founding one)
	 */
	public Laborer(double initEQty, double initNQty, double initCheckingBal,
			double initSavingsBal, double initSavingsRate, LaborerConfig config,
			Bank bank, Settlement colony, boolean fundedFromEquity) {
		// an immigrant is a freshly-generated person, so it rolls its ancestry against
		// the colony's race-mix (a mono-cultural colony draws nothing and gets HUMAN)
		this(initEQty, initNQty, initCheckingBal, initSavingsBal,
				fundedFromEquity, initSavingsRate, config, bank, colony, null,
				colony.getDemography().sampleRace(colony.getRaceMix()));
	}

	/**
	 * Create the household that succeeds <tt>predecessor</tt> when its head
	 * dies: it inherits the predecessor's estate (its account balances, funded
	 * out of the bank's equity so money stays in circulation) and continues the
	 * same dynasty (a new head, same surname), banking at the same bank. A fresh
	 * working-age head is drawn.
	 *
	 * @param predecessor
	 *            the deceased household whose estate and dynasty are inherited
	 * @param initEQty
	 *            initial enjoyment quantity
	 * @param initNQty
	 *            initial necessity quantity
	 * @param initSavingsRate
	 *            initial savings rate
	 * @param config
	 *            tunable model parameters
	 * @param colony
	 *            the colony this laborer belongs to
	 */
	public Laborer(Laborer predecessor, double initEQty, double initNQty,
			double initSavingsRate, LaborerConfig config, Settlement colony) {
		// an heir continues its dynasty, so it keeps the line's race (no re-roll)
		this(initEQty, initNQty, predecessor.getEstateChecking(),
				predecessor.getEstateSavings(), true, initSavingsRate, config,
				predecessor.getBank(), colony, predecessor.getHead().surname(),
				predecessor.getHead().race());
	}

	/**
	 * Shared constructor. Opens the account either as a fresh endowment
	 * ({@code inherited == false}) or out of the bank's equity
	 * ({@code inherited == true}, for a successor household), then initializes
	 * the rest of the household identically.
	 */
	private Laborer(double initEQty, double initNQty, double initCheckingBal,
			double initSavingsBal, boolean inherited, double initSavingsRate,
			LaborerConfig config, Bank bank, Settlement colony, String surname,
			Race race) {
		super(initCheckingBal, initSavingsBal, inherited, surname, race, bank, colony);

		// a notable arrival (skill above the threshold) is worth recording by name,
		// and is a person of interest the colony tracks (and logs yearly)
		if (isNotable()) {
			var skills = getHead().skills();
			SimLog.event(Rank.HOUSEHOLD, Level.FINE, String.format(
					"%s founded a household in the colony — notable in %s (level %d); %s",
					getHead().fullName(), skills.peakSkill(), skills.peakLevel(),
					skills));
			colony.addPersonOfInterest(this);
		} else if (colony.isStarted()) {
			// An ordinary household is still demographic narrative, so the notification board shows
			// it — as routine churn (a dim one-liner) rather than a full card, which is why this
			// wording deliberately avoids the curated-event allow-list ("founded", "settl", …) that
			// the notable line above hits. See LogLine.of / docs/notifications.md.
			//
			// isStarted() is what makes "new" mean new: the colony's whole initial population is
			// constructed BEFORE start(), so without this gate a founding would post ~400 of these
			// in a single day.
			SimLog.event(Rank.HOUSEHOLD, Level.FINE,
					String.format("the %s household was formed", getHead().surname()));
		}

		this.config = config;
		enjoyment = new Enjoyment(initEQty);
		necessity = new Necessity(initNQty);
		eMkt = (ConsumerGoodMarket) colony.getMarket("Enjoyment");
		nMkt = (ConsumerGoodMarket) colony.getMarket("Necessity");
		lMkt = (LaborMarket) colony.getMarket("Labor");
		this.savingsRate = initSavingsRate;
		lMkt.addEmployee(this);
	}

	/**
	 * Create a laborer household by <b>adopting a promoted peasant</b> as its head:
	 * the {@code head} keeps its name, skills and age (so promotion is meritocratic),
	 * the household opens with the given config balances (a fresh endowment its
	 * sponsor — the ruler — funds externally), and it starts a new dynasty (the head
	 * carries a freshly-drawn surname). Used by the pool-promotion replacement policy
	 * (see {@code SimulationHarness}).
	 *
	 * @param head
	 *            the promoted peasant this household adopts as its head
	 * @param initEQty
	 *            initial enjoyment quantity
	 * @param initNQty
	 *            initial necessity quantity
	 * @param initCheckingBal
	 *            initial checking account balance
	 * @param initSavingsBal
	 *            initial savings account balance
	 * @param initSavingsRate
	 *            initial savings rate
	 * @param config
	 *            tunable model parameters
	 * @param bank
	 *            the bank at which this laborer holds its accounts
	 * @param colony
	 *            the colony this laborer belongs to
	 */
	public Laborer(Member head, double initEQty, double initNQty,
			double initCheckingBal, double initSavingsBal, double initSavingsRate,
			LaborerConfig config, Bank bank, Settlement colony) {
		super(initCheckingBal, initSavingsBal, false, head, bank, colony);
		this.config = config;
		enjoyment = new Enjoyment(initEQty);
		necessity = new Necessity(initNQty);
		eMkt = (ConsumerGoodMarket) colony.getMarket("Enjoyment");
		nMkt = (ConsumerGoodMarket) colony.getMarket("Necessity");
		lMkt = (LaborMarket) colony.getMarket("Labor");
		this.savingsRate = initSavingsRate;
		lMkt.addEmployee(this);
		// a notable promoted head is recorded by name, like any notable arrival
		if (isNotable()) {
			var skills = getHead().skills();
			SimLog.event(Rank.HOUSEHOLD, Level.FINE, String.format(
					"%s was promoted from the peasantry — notable in %s (level %d); %s",
					getHead().fullName(), skills.peakSkill(), skills.peakLevel(),
					skills));
			colony.addPersonOfInterest(this);
		}
		// An ORDINARY promotion is deliberately silent. This ctor is the replacement path — the pool
		// promotes a peasant to succeed a laborer who died — so it fires once per death, not once per
		// new household: 258 times in a 9-year run, 36 of them on a single collapse day. A successor
		// is succession, not growth, and at that volume it buries the events it sits beside (the
		// starvation wave that caused those very deaths). Genuine new households log in the founding
		// ctor above. The yearly digest still carries the totals. See docs/notifications.md.
	}

	/**
	 * Called by Settlement.newDay() in each simulation step.
	 */
	public void act() {
		Bank bank = getBank();
		Account acct = bank.getAcct(this.getID());

		// the household head may die of old age; its estate folds into the bank's
		// equity, and a successor of the same dynasty inherits it
		if (checkOldAgeDeath())
			return;

		wage = acct.priIC;
		income = wage + acct.secIC + acct.interest;

		// should have used real interest rate i.e. Bank.getDepositIR() -
		// Settlement.getInflation(). But that seems to produce some instability
		// need further testing!!!
		double RR = bank.getDepositIR();

		// work my home plot: a landed household farms its own plot for subsistence food,
		// dropped straight into its larder before it eats — a non-market food source (plot
		// food never touches the consumer-good market). A landless household (homePlot ==
		// null — the pool overflow, or a colony with no home plots) relies on the market
		// as before, so this is byte-identical when no plot is assigned. This is the
		// settled analogue of the camp's forage (a generalization of campForageYield); see
		// docs/plot-working-plan.md P1.
		// the food this household eats from — its hamlet's shared village larder when provisioned
		// (city-of-hamlets V2), else its own necessity stock (byte-identical when off / landless)
		boolean provisioned = provisioned();
		Good foodStock = foodStock(provisioned);

		if (homePlot != null)
			foodStock.increase(getColony().homePlotFoodYield(homePlot));

		// the household eats per member, in priority order (head, then other adults,
		// then children): an adult eats the FINE worker ration, a child the SNACK
		// ration. The head eats first — if even it cannot be fed the household dies
		// (a successor of the same dynasty inherits the estate); a non-head adult that
		// cannot be fed starves off. A child the larder cannot feed draws its ration
		// from the colony granary (child relief) before starving, so the next generation
		// survives lean spells (see docs/granary.md §5.2 / the loop below); children are
		// appended last, so the youngest are the last to be relieved and the first to
		// starve when even the granary is empty. See docs/births.md.
		LocalDate today = getColony().getDate();
		var members = getMembers();
		double available = foodStock.getQuantity();
		double headRation = rationFor(members.get(0), today);
		if (available < headRation) {
			dieAndSettleEstate();
			return;
		}
		double remaining = available - headRation;
		Granary granary = getColony().getGranary();
		// members that starve off this step (the first member the larder cannot feed and
		// every lower-priority member after it). Removed by reference at the end, so any
		// DRAFTED member interleaved among them — away with an expedition, fed by its
		// caravan, not starving here (docs/explorer-caravan.md) — is preserved.
		java.util.List<Member> starvedOff = null;
		for (int i = 1; i < members.size(); i++) {
			Member m = members.get(i);
			// a drafted member is away on the expedition and fed by its caravan, so the
			// household neither feeds it nor starves it off (docs/explorer-caravan.md)
			if (m.isDrafted())
				continue;
			double r = rationFor(m, today);
			if (remaining >= r) {
				remaining -= r;
				continue;
			}
			// the larder cannot feed this member. A non-head ADULT starves off (and every
			// lower-priority present member after it). A CHILD instead draws its ration from
			// the granary (subsidized child relief, billed to the crown), so the next
			// generation survives lean spells to reach working age — only starving if the
			// granary too is empty. Children are appended last, so once the loop reaches
			// them every adult is already fed. See docs/granary.md §5.2.
			if (!m.isAdult(today) && granary != null && granary.getStock() >= r) {
				granary.drawStock(r);
				continue;
			}
			starvedOff = new java.util.ArrayList<>();
			for (int j = i; j < members.size(); j++) {
				Member later = members.get(j);
				if (!later.isDrafted())
					starvedOff.add(later);
			}
			break;
		}
		foodStock.decrease(available - remaining);
		if (starvedOff != null)
			for (Member m : starvedOff)
				removeMember(m);

		// bear a child: a married household (an adult couple) with a fertile female
		// and a food cushion bears a child — a new SNACK-eating member — per the
		// colony's fertility config (the universal birth mechanism, shared with
		// nobles and the ruler). The newborn is added now, so it counts toward this
		// step's necessity buffer below. See docs/births.md.
		bearChildIfFertile(foodStock.getQuantity(), config.eatAmt());

		if (!firstAct) {
			if (RR < lowRR)
				lowRR = RR;
			if (RR > highRR)
				highRR = RR;
		} else {
			// this household's first step
			lowRR = RR;
			highRR = RR;
		}

		double checking = acct.getChecking();
		double savings = acct.getSavings();

		// compute target savings
		double targetSavings = income * config.baseSavingsToIncomeRatio();
		if (highRR > lowRR)
			targetSavings *= (RR - lowRR) / (highRR - lowRR) * config.epsilon() * 2 + 1
					- config.epsilon();

		// compute target consumption
		double targetConsumption = checking + savings - targetSavings;

		// compute consumption
		if (firstAct)
			consumption = income;
		else
			consumption = Math.min(
					Math.max(consumption * (1 - config.upsilon()), targetConsumption),
					consumption * (1 + config.upsilon()));

		// compute amount to deposit
		double new_deposit = checking - consumption;
		bank.deposit(getID(), new_deposit);

		// compute savings rate
		savingsRate = (savings + new_deposit) / (checking + savings);

		// compute consumption of necessity (in $). The food buffer / minimum-buy scale
		// with the household's actual mouths, a child counting as its (smaller) SNACK
		// ration rather than a full adult — so a married household keeps the same
		// per-mouth buffer and newborns don't inflate it by a full unit each.
		// `mouths` is the daily ration in adult-equivalents (an all-adult household
		// equals its member count, preserving the prior behaviour exactly).
		double dailyNeed = dailyRation(today);
		if (provisioned) {
			// a provisioned peasant buys NO food — its village's leader imports the larder's deficit,
			// so the household's whole discretionary spend goes to enjoyment + savings (its wage flows
			// to enjoyment, dues and savings, never to its own bread). See city-of-hamlets V2.
			nConsumption = 0;
			minN = 0;
		} else {
			double mouths = dailyNeed / config.eatAmt();
			nConsumption = consumption * Math.max(0, 1 - foodStock.getQuantity()
					/ (getColony().getTargetNStock() * mouths));
			// if the household has under two days' food, buy at least a day's worth for everyone
			minN = foodStock.getQuantity() < 2 * dailyNeed ? dailyNeed : 0;
		}

		// compute consumption of enjoyment (in $)
		eConsumption = consumption - nConsumption;

		// post buy offer to enjoyment market
		eMkt.addBuyOffer(this, demandForE);

		// post buy offer to necessity market — a provisioned peasant does not (the village buys)
		if (!provisioned)
			nMkt.addBuyOffer(this, demandForN);

		// the occupation choice (build economy, docs/build-queue-plan.md B1): a landed
		// household on a build-economy colony weighs selling labor at the center against
		// working its home plot for hammers + commerce. Everyone else (flag off, landless)
		// posts labor unconditionally as before — byte-identical.
		var buildEconomy = getColony().getBuildEconomy();
		if (buildEconomy != null && homePlot != null) {
			adoptOrphanedHouse();
			updateOccupation(buildEconomy);
			// the choice binds only on workdays (rest days gate plot-working like firms);
			// on a rest day everyone goes to market as today (enjoyment firms may hire)
			boolean plotDay = plotWorker && getColony().getDayType() == DayType.WORKDAY;
			if (plotDay) {
				buildEconomy.workPlotDay(this);
			} else {
				lMkt.addEmployee(this);
				buildEconomy.registerMarketChooser(this);
			}
			plotDayYesterday = plotDay;
		} else {
			// post every household member to the labor market (head and any spouse)
			lMkt.addEmployee(this);
		}

		// if unmarried, seek a spouse on the wedding market (it weds on weekends)
		seekSpouseIfSingle();

		resetIncomeAccumulators(acct);
		firstAct = false;
	}

	/**
	 * Re-evaluate the household's <b>occupation</b> (build economy, B1): update the wage
	 * memory from yesterday's outcome, then — on workdays only — apply the
	 * reservation-wage rule with the optimism prior and the hysteresis band.
	 * <ul>
	 * <li><b>Wage memory</b>: the morning after a market-chosen day records the realized
	 * wage ({@code acct.priIC}, already read into {@link #wage}); a plot-chosen
	 * yesterday leaves the memory untouched (its 0 income is not a market signal). A
	 * recorded 0 means the household was left unhired — the labor-surplus signal.</li>
	 * <li><b>Optimism prior</b>: never paid yet → market (founding behavior matches
	 * today's; wages get discovered).</li>
	 * <li><b>Hysteresis</b>: switch only when the plot's commerce value beats the
	 * remembered wage by {@link BuildEconomy#HYSTERESIS_BAND} (or falls below it by the
	 * same margin) — no daily flip-flop.</li>
	 * </ul>
	 */
	private void updateOccupation(BuildEconomy buildEconomy) {
		if (!firstAct && !plotDayYesterday) {
			lastMarketWage = wage;
			if (wage > 0)
				everPaid = true;
		}
		// hold the occupation on rest days (the plot value is 0 there — comparing would
		// spuriously flip every plot-worker back to market each weekend)
		if (getColony().getDayType() != DayType.WORKDAY)
			return;
		// the homeless-and-FED rule (B3): an unhoused household whose larder can carry it
		// stays home to build its house — the demographic gate makes housing worth more
		// than a wage. Homeless-and-hungry falls through to the normal rule (earn to eat).
		if (!housedForGate() && foodStock().getQuantity() >= FED_DAYS * dailyRation(getColony().getDate())) {
			plotWorker = true;
			return;
		}
		if (!everPaid) {
			plotWorker = false;
			return;
		}
		double plotValue = buildEconomy.plotCommerceValue(this);
		if (!plotWorker && plotValue > lastMarketWage * (1 + BuildEconomy.HYSTERESIS_BAND))
			plotWorker = true;
		else if (plotWorker && plotValue < lastMarketWage * (1 - BuildEconomy.HYSTERESIS_BAND))
			plotWorker = false;
	}

	/**
	 * The housing gate (B3): a landed laborer on a build-economy colony must own a
	 * <b>current</b> (non-obsolete) house to wed or fission; everyone else — flag-off
	 * colonies, landless households (they cannot build) — passes freely. An
	 * obsolete-housed household stays sheltered but is re-gated until it modernizes.
	 */
	@Override
	public boolean housedForGate() {
		var buildEconomy = getColony().getBuildEconomy();
		if (buildEconomy == null || homePlot == null)
			return true;
		return house != null && com.civstudio.settlement.HousingCatalog.get()
				.isCurrent(house.id(), buildEconomy.knownTechs());
	}

	// adopt an orphaned (unowned) housing building standing on this household's home
	// plot — the succession/inheritance seam: a dead household's house is orphaned, and
	// the successor seated on the same plot takes it over (also covers ground inherited
	// from a previous colony). A no-op once housed.
	private void adoptOrphanedHouse() {
		if (house != null || homePlot == null)
			return;
		for (com.civstudio.settlement.Building b : homePlot.buildings())
			if (b.isHousing() && b.ownerId() == null) {
				b.setOwnerId(getID());
				house = b;
				houseOnPlot = homePlot;
				return;
			}
	}

	/**
	 * Pay plot-day hammers into this household's <b>housing project</b> (B3): while
	 * unhoused (or housed obsolete), hammers build the colony's cheapest available
	 * housing rung on the home plot; completion raises the {@link
	 * com.civstudio.settlement.Building} (owned by this household) and houses the
	 * household. Overflow beyond completion — and all hammers once currently housed —
	 * is returned for donation to the colony sink.
	 *
	 * @param hammers      the plot day's hammers
	 * @param buildEconomy the colony's build economy (the catalog/tech views)
	 * @return the hammers NOT consumed by the project (to donate)
	 */
	public double applyHammersToProject(double hammers, BuildEconomy buildEconomy) {
		if (hammers <= 0)
			return hammers;
		// housed: households build ONLY housing (user ruling 2026-07-24) — surplus hammers
		// climb the housing ladder (upgrade to the next rung up) rather than raising
		// arbitrary regular buildings; at the top of the ladder the hammers donate
		if (housedForGate())
			return upgradeHousing(hammers, buildEconomy);
		// (re)target the cheapest available rung; no rung buildable yet → all donate
		if (targetRungId == null) {
			var rung = buildEconomy.cheapestAvailableHousing();
			if (rung == null)
				return hammers;
			targetRungId = rung.type();
			// housing builds at its raw catalog cost (1x) — only the crown's REGULAR buildings
			// carry the BUILD_COST_SCALE slowdown (user ruling 2026-07-24); keeping housing fast
			// keeps the founding wave healthy so unhoused households do not sit home-building for
			// years and starve the wage economy
			targetRungCost = rung.effectiveCost();
		}
		houseProgress += hammers;
		if (houseProgress < targetRungCost)
			return 0;
		// complete: raise the house on the home plot, owned by this household
		double overflow = houseProgress - targetRungCost;
		var built = new com.civstudio.settlement.Building(targetRungId, getID());
		homePlot.addBuilding(built);
		house = built;
		houseOnPlot = homePlot;
		// Deliberately NOT SimLog.event: a hut going up is not news (owner ruling, 2026-07-27).
		// Every household raises one and then climbs the housing ladder, so at colony scale this was
		// the single loudest thing on the notification board — hundreds of identical lines about the
		// most ordinary thing a family does, burying the events that actually needed reading.
		//
		// FINER, not FINE, and that is the whole point: the live tap's floor is FINE
		// (-Deos.log.tap.level), so a plain log.fine here would still reach the board — and reach it
		// UNRANKED, which notify-rank shows unconditionally. One rung lower keeps it as
		// instrumentation for a -Deos.log.level=FINER run and off the player's screen.
		log.finer(() -> String.format("the %s household raised its %s on its home plot",
				getHead().surname(),
				com.civstudio.settlement.BuildingCatalog.displayName(targetRungId)));
		targetRungId = null;
		targetRungCost = 0;
		houseProgress = 0;
		return overflow;
	}

	// the housing-upgrade slot (B5): once housed, a household pours its own plot hammers
	// into the NEXT housing rung up, climbing the ladder toward the best available housing
	// (households build ONLY housing — user ruling 2026-07-24); completion retires the old
	// house and raises the better one owned on the home plot; at the top → donate
	private String targetUpgradeId;
	private double targetUpgradeCost;
	private double upgradeProgress;

	private double upgradeHousing(double hammers, BuildEconomy buildEconomy) {
		if (targetUpgradeId == null) {
			var next = buildEconomy.nextHousingUpgrade(house);
			if (next == null)
				return hammers; // already at the best available rung — donate
			targetUpgradeId = next.type();
			// housing (base and upgrade) builds at raw catalog cost (1x); only the crown's
			// regular buildings carry BUILD_COST_SCALE (user ruling 2026-07-24)
			targetUpgradeCost = next.effectiveCost();
		}
		upgradeProgress += hammers;
		if (upgradeProgress < targetUpgradeCost)
			return 0;
		double overflow = upgradeProgress - targetUpgradeCost;
		// the family moves up: retire the house it replaces, raise the better rung
		if (house != null && houseOnPlot != null)
			houseOnPlot.removeBuilding(house);
		var built = new com.civstudio.settlement.Building(targetUpgradeId, getID());
		homePlot.addBuilding(built);
		buildEconomy.noteHousingUpgrade();
		// instrumentation, not news — see the sibling note in the raise path above
		log.finer(() -> String.format("the %s household upgraded to a %s on its home plot",
				getHead().surname(),
				com.civstudio.settlement.BuildingCatalog.displayName(targetUpgradeId)));
		house = built;
		houseOnPlot = homePlot;
		targetUpgradeId = null;
		targetUpgradeCost = 0;
		upgradeProgress = 0;
		return overflow;
	}

	/**
	 * <b>Emancipate a grown child</b> into its own household: remove and return this
	 * household's first adult, colony-born child (see {@link #releaseGrownChild}), or
	 * {@code null} if it has none. The child's food <b>dowry is granary-funded</b> (the
	 * colony's strategic store dowers the new household — see {@code docs/granary.md}
	 * §5.3), <b>not</b> drawn from this parent's larder: the parent's larder is typically
	 * depleted exactly when its child matures (a lean spell is what delays maturity), so
	 * gating fission on the parent's food was the second gate that kept it from ever
	 * firing (`docs/food-balance.md` #4). Fission grows the household <i>count</i> (the
	 * count the survival floor measures), the renewal path the finite peasant pool cannot
	 * provide.
	 *
	 * @param today
	 *            the colony's current date (sets working age)
	 * @return the released grown child, or {@code null} if none is eligible
	 */
	public Member emancipateChild(LocalDate today) {
		return releaseGrownChild(today);
	}

	/**
	 * Assign (or clear, with {@code null}) this household's {@linkplain #getHomePlot() home
	 * plot} — the plot it farms for subsistence food. Set by the harness when a landed
	 * household is founded/promoted (see {@code SimulationHarness}); cleared when the plot
	 * is vacated. A no-op economically until the household next acts. See
	 * {@code docs/plot-working-plan.md} P1.
	 *
	 * @param homePlot the plot this household farms, or {@code null} to make it landless
	 */
	public void setHomePlot(Plot homePlot) {
		this.homePlot = homePlot;
		// a household living on a fief is the fief-holder's vassal (docs/estate-system.md P3): swear
		// it to the plot's holder, or back to the Crown default on unenfeoffed / no ground
		setLiegeId(homePlot == null ? null : homePlot.ownerId());
	}

	// city-of-hamlets V2: whether this household is PROVISIONED — a landed peasant on a village-larder
	// colony eats from its hamlet's shared larder (the provisioned floor), not its own necessity, and
	// buys no food itself (its village's leader imports the larder's deficit). Landless / flag-off keep
	// their own stock, byte-identical.
	private boolean provisioned() {
		// only a household on a HAMLET SEAT is provisioned: Settlement.isHamletSeat excludes a null
		// home plot (landless) and the city center (the civic core is not a village), the single
		// definition hamlets() also uses — so a household there keeps the market food path.
		return getColony().getVillageLarders() != null && getColony().isHamletSeat(homePlot);
	}

	// the food stock this household eats from and drops its home-plot food into: its hamlet's shared
	// village larder when provisioned, else its own necessity stock (the byte-identical default).
	private Good foodStock() {
		return foodStock(provisioned());
	}

	// as foodStock(), given the already-computed provisioned flag, so act() evaluates provisioned() once
	private Good foodStock(boolean provisioned) {
		if (provisioned) {
			Good larder = getColony().villageLarderGood(homePlot);
			if (larder != null)
				return larder;
		}
		return necessity;
	}

	// the daily necessity ration a member eats: an adult the FINE worker ration
	// (config.eatAmt()), a child the colony's configured child ration (SNACK)
	private double rationFor(Member m, LocalDate today) {
		return m.isAdult(today) ? config.eatAmt()
				: getColony().getFertilityConfig().childRation().perDay();
	}

	// the household's total daily necessity need: the sum of every member's ration
	// (adults at the worker ration, children at the smaller child ration)
	private double dailyRation(LocalDate today) {
		double sum = 0;
		for (Member m : getMembers())
			// a drafted member is away with the expedition (fed by its caravan), so it
			// does not size the household's necessity buy (docs/explorer-caravan.md)
			if (!m.isDrafted())
				sum += rationFor(m, today);
		return sum;
	}

	/** A laborer is the colony's workforce: its labor sustains the colony. */
	@Override
	public boolean isWorkforce() {
		return true;
	}

	/** Role label used in the persons-of-interest roster and death log. */
	@Override
	public String role() {
		return "Notable laborer";
	}

	/**
	 * Return a reference to the good with name <tt>goodName</tt>
	 */
	public Good getGood(String goodName) {
		if (goodName.equals("Enjoyment"))
			return enjoyment;
		else if (goodName.equals("Necessity"))
			return necessity;
		return null;
	}

	/**
	 * Return savings
	 *
	 * @return savings
	 */
	public double getSavings() {
		return getBank().getSavings(getID());
	}

	/**
	 * A concise, debug-friendly summary: id, household head, alive status and
	 * the latest economic snapshot. Uses only cached fields (no bank lookup),
	 * so it is safe to call even after the laborer has died and closed its
	 * account.
	 */
	@Override
	public String toString() {
		return String.format(
				"Laborer#%d %s [%s b=%s age=%d wage=%.2f income=%.2f consumption=%.2f savingsRate=%.2f]",
				getID(), getHead().fullName(), isAlive() ? "alive" : "dead",
				getBirthDate(), getAgeYears(), wage, income, consumption, savingsRate);
	}
}
