package com.civstudio.agent.ruler;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

import com.civstudio.agent.Caravan;
import com.civstudio.agent.firm.*;
import com.civstudio.agent.AbstractHousehold;
import com.civstudio.agent.Agent;
import com.civstudio.agent.Member;
import com.civstudio.agent.Rank;
import com.civstudio.agent.noble.Noble;
import com.civstudio.race.Race;
import com.civstudio.bank.Account;
import com.civstudio.bank.Bank;
import com.civstudio.good.Enjoyment;
import com.civstudio.good.Good;
import com.civstudio.good.Necessity;
import com.civstudio.good.RationSize;
import com.civstudio.market.ConsumerGoodMarket;
import com.civstudio.market.Demand;
import com.civstudio.market.LaborMarket;
import com.civstudio.settlement.Settlement;
import lombok.Getter;
import lombok.extern.java.Log;

/**
 * The <b>ruler</b> of the settlement: the owner of its gold bank. Unlike a
 * {@link Noble} the ruler is not a rentier who draws dividends —
 * it is a <b>treasury that indulges</b>. It holds its fortune (gold) at the gold
 * bank, of which it is the sole account holder (the bank has no other clients),
 * and earns nothing, but each step it spends a small fraction of the treasury on
 * <b>enjoyment</b> — a sovereign luxury habit that slowly draws the reserves down.
 * Because enjoyment is priced in copper, that spending converts gold to copper, so
 * the gold bank skims its currency-exchange fee. It also keeps a lavish table —
 * eating the {@link RationSize#GOURMET} ration each step and restocking
 * necessity toward a reserve (also copper-quoted, so it likewise fires the FX fee).
 * There is one ruler per settlement; it never starves.
 * <p>
 * Like the other households the ruler is a named {@link AbstractHousehold} that
 * ages on the mortality schedule and, when its head dies of old age, is
 * succeeded by a heir of the same dynasty who inherits the treasury (so the line
 * endures). It is skilled and tracked as a person of interest, but sells no
 * labor and owns no firms.
 */
@Log
public class Ruler extends AbstractHousehold {

	// fraction of the treasury (checking + savings) spent on enjoyment each step
	private final double consumptionRate;

	// per-step tax rates: a fraction of each bank's distributable profit and of
	// each noble's income, skimmed into the treasury (0 disables — the default).
	// Mutable: the founding value comes from config, but a player can adjust it at
	// runtime through the Phase-B command channel (see SetTaxRateCommand), applied
	// deterministically at the top of a tick; a successor inherits the live value.
	private double bankProfitTaxRate;
	private double nobleIncomeTaxRate;

	// cumulative tax collected over the ruler's life (for reporting/tests)
	@Getter
	private double taxCollected;

	// days of its GOURMET ration the ruler keeps as a stocked larder
	private static final int NECESSITY_RESERVE_DAYS = 30;

	// fraction of a POSITIVE treasury the crown grants to research each step. The crown used to fund
	// the science firm's whole wage bill at a flat rate regardless of its means, which was its single
	// largest standing outflow and drove the treasury permanently negative — measured at -3.5k after
	// one year and -80k after ten, monotonically, on a colony whose peasant pool and granary bill it
	// nothing. Sizing the grant to what the crown actually holds makes research self-limiting: a rich
	// crown researches at the old pace, a broke one slows down and lets its treasury recover, exactly
	// as its enjoyment consumption already does ("indulge only out of a positive treasury"). Chosen so
	// a healthy treasury funds roughly the science firm's configured budget.
	private static final double RESEARCH_FUNDING_RATE = 0.02;

	// --- dynamic firm provisioning thresholds (see reviewSectors) ---
	// a sector is supply-constrained — a reason to charter — when its firms run at or
	// above this smoothed utilization while demand still goes unfilled. This is the
	// price-bias-free capacity signal, and the one that cold-starts a 1-firm sector.
	private static final double OPEN_UTIL_THRESHOLD = 0.85;
	private static final double MIN_UNMET_TO_OPEN = 0.02;
	// ...or charter when demand pressure (short-run unmet above its long-run baseline)
	// surges this far above the colony's norm — the steady-state demand-growth trigger
	private static final double OPEN_PRESSURE_THRESHOLD = 0.05;
	// necessity is inelastic (every mouth eats daily), so react to a smaller surge —
	// the colony errs toward over-provisioning food
	private static final double INELASTIC_OPEN_PRESSURE_THRESHOLD = 0.03;
	// a sector is overbuilt — a reason to dissolve a firm — below this smoothed util
	private static final double CLOSE_UTIL_THRESHOLD = 0.55;
	// ...OR overbuilt by OVERSUPPLY: the sector is losing money (negative smoothed
	// sector profit) AND its market price has collapsed below this fraction of its
	// initial reference price — it has over-produced and crashed its own price. This is
	// the glut/deflation signal the utilization measure is blind to: flat-out firms
	// flooding a satiated market run at HIGH utilization (busy machines), so the
	// idle-capacity test never trips even as the price collapses. The crashed-PRICE
	// gate is what distinguishes a true glut from a merely loss-making but *needed*
	// sector (food sold at a loss in a tight colony, price still near normal): the
	// rest-day-inflated unmet/pressure signals cannot tell those apart (both ~0.26),
	// but the price can — a deflationary glut sits far below its founding level while a
	// needed sector hovers around it. Without this, the close rule wrongly dissolves
	// productive necessity firms in a normal colony and accelerates its collapse.
	private static final double GLUT_PRICE_FACTOR = 0.3;
	// never cut a sector below this many firms (food and leisure both need a floor)
	private static final int MIN_NECESSITY_FIRMS = 1;
	private static final int MIN_ENJOYMENT_FIRMS = 1;
	// hysteresis against the seasonal charter/dissolve oscillation: a firm younger
	// than this is never dissolved (so a recently-chartered firm survives a transient
	// utilization dip), and a sector waits this long after an action of one kind
	// before taking the opposite kind (damping a charter↔dissolve flip-flop). A
	// 6-month window — short enough that the (now glut-aware) close rule reacts to an
	// over-supplied sector within half a year, but long enough to damp the seasonal
	// charter↔dissolve hog cycle a quarter-long window reintroduced.
	private static final int MIN_FIRM_LIFETIME_DAYS = 180;
	private static final int REENTRY_COOLDOWN_DAYS = 180;

	// per-sector record of the last charter/dissolve step, for the re-entry cooldown
	private static final class SectorMemory {
		int lastCharterStep = Integer.MIN_VALUE / 2;
		int lastDissolveStep = Integer.MIN_VALUE / 2;
	}
	private final SectorMemory eMemory = new SectorMemory();
	private final SectorMemory nMemory = new SectorMemory();

	// the enjoyment and necessity the ruler buys, and the markets it buys from
	private final Enjoyment enjoyment;
	private final Necessity necessity;
	private final ConsumerGoodMarket eMkt;
	private final ConsumerGoodMarket nMkt;

	// the noble-only labor market the strategic export firm employs from, or null if
	// the colony has no export sector. The ruler works the strategic firm every step
	// (its head's SOCIAL drives the output, like a noble's), so the export
	// sector is never unstaffed — the aristocracy that normally staffs it is built up
	// over the first weeks by ennoblement (see SimulationHarness.topUpAristocracy).
	private final LaborMarket nobleLaborMkt;

	// the scholar labor market the science firm employs from, or null if the colony
	// has no science firm. Like the export sector above, the ruler works it during the
	// early weeks so research is staffed before the aristocracy is raised; the wages
	// it bids are funded from its own treasury (see ScienceFirm).
	private final LaborMarket scholarLaborMkt;

	// enjoyment spending ($) in the last step
	@Getter
	private double consumption;

	// necessity units to buy this step (the gap to the reserve target, set in act)
	private double nGap;

	// demand strategies: spend the whole enjoyment budget at the going price, and
	// restock necessity toward the reserve (the ruler never starves, so no floor).
	// The ruler's necessity draw is tiny (its own household), so price-inelastic
	// restocking does not move the market.
	private final Demand demandForE = price -> consumption / price;
	private final Demand demandForN = price -> nGap;

	/**
	 * Create the settlement's founding ruler, holding <tt>initSavingsBal</tt> at
	 * (and as the sole client of) the gold bank.
	 *
	 * @param initSavingsBal
	 *            the ruler's opening fortune, in copper (the base unit)
	 * @param consumptionRate
	 *            fraction of the treasury spent on enjoyment each step
	 * @param bankProfitTaxRate
	 *            fraction of each bank's distributable profit taxed each step
	 * @param nobleIncomeTaxRate
	 *            fraction of each noble's income taxed each step
	 * @param goldBank
	 *            the gold bank the ruler owns and banks at
	 * @param colony
	 *            the colony this ruler belongs to
	 */
	public Ruler(double initSavingsBal, double consumptionRate,
			double bankProfitTaxRate, double nobleIncomeTaxRate, Bank goldBank,
			Settlement colony) {
		// the founding ruler takes the colony's founding race
		this(0, initSavingsBal, consumptionRate, bankProfitTaxRate,
				nobleIncomeTaxRate, false, goldBank, colony, null,
				colony.getFoundingRace());
	}

	/**
	 * Create the ruler of a <b>re-founded</b> colony by <b>adopting a band's leader</b>
	 * as its head (the {@link Caravan Caravan}'s Captain becomes the
	 * sovereign — see {@code docs/caravan.md}): the head keeps its identity (name,
	 * skills, age, dynasty), and the band's carried hoard seeds the gold treasury. So
	 * the same bloodline that led the band out rules the colony it founds.
	 *
	 * @param head
	 *            the band's leader, adopted as the ruling head
	 * @param initSavingsBal
	 *            the opening treasury, in copper — the band's carried hoard
	 * @param consumptionRate
	 *            fraction of the treasury spent on enjoyment each step
	 * @param bankProfitTaxRate
	 *            fraction of each bank's distributable profit taxed each step
	 * @param nobleIncomeTaxRate
	 *            fraction of each noble's income taxed each step
	 * @param goldBank
	 *            the gold bank the ruler owns and banks at
	 * @param colony
	 *            the colony this ruler belongs to
	 */
	public Ruler(Member head, double initSavingsBal, double consumptionRate,
			double bankProfitTaxRate, double nobleIncomeTaxRate, Bank goldBank,
			Settlement colony) {
		super(0, initSavingsBal, false, head, goldBank, colony);
		this.consumptionRate = consumptionRate;
		this.bankProfitTaxRate = bankProfitTaxRate;
		this.nobleIncomeTaxRate = nobleIncomeTaxRate;
		this.enjoyment = new Enjoyment(0);
		this.necessity = new Necessity(0);
		this.eMkt = (ConsumerGoodMarket) colony.getMarket("Enjoyment");
		this.nMkt = (ConsumerGoodMarket) colony.getMarket("Necessity");
		this.nobleLaborMkt =
				(LaborMarket) colony.getMarket(StrategicFirm.LABOR_MARKET);
		this.scholarLaborMkt = (LaborMarket) colony
				.getMarket(ScienceFirm.LABOR_MARKET);
		setName("Ruler");
		colony.addPersonOfInterest(this);
		log.fine(getHead().fullName()
				+ " led the band to found a new settlement and rules it.");
	}

	/**
	 * Create the ruler that succeeds <tt>predecessor</tt> when its head dies: a
	 * heir of the same dynasty who inherits the treasury (funded out of the gold
	 * bank's equity, as for any household succession) and banks at the same gold
	 * bank, with the same luxury habit.
	 *
	 * @param predecessor
	 *            the deceased ruler whose estate and dynasty are inherited
	 * @param colony
	 *            the colony this ruler belongs to
	 */
	public Ruler(Ruler predecessor, Settlement colony) {
		// an heir continues its dynasty, so it keeps the line's race (no re-roll)
		this(predecessor.getEstateChecking(), predecessor.getEstateSavings(),
				predecessor.consumptionRate, predecessor.bankProfitTaxRate,
				predecessor.nobleIncomeTaxRate, true, predecessor.getBank(), colony,
				predecessor.getHead().surname(), predecessor.getHead().race());
	}

	private Ruler(double initCheckingBal, double initSavingsBal,
			double consumptionRate, double bankProfitTaxRate,
			double nobleIncomeTaxRate, boolean inherited, Bank goldBank,
			Settlement colony, String surname, Race race) {
		super(initCheckingBal, initSavingsBal, inherited, surname, race, goldBank,
				colony);
		this.consumptionRate = consumptionRate;
		this.bankProfitTaxRate = bankProfitTaxRate;
		this.nobleIncomeTaxRate = nobleIncomeTaxRate;
		this.enjoyment = new Enjoyment(0);
		this.necessity = new Necessity(0);
		this.eMkt = (ConsumerGoodMarket) colony.getMarket("Enjoyment");
		this.nMkt = (ConsumerGoodMarket) colony.getMarket("Necessity");
		this.nobleLaborMkt =
				(LaborMarket) colony.getMarket(StrategicFirm.LABOR_MARKET);
		this.scholarLaborMkt = (LaborMarket) colony
				.getMarket(ScienceFirm.LABOR_MARKET);
		setName("Ruler");

		// the ruler is always a person of interest the colony tracks
		colony.addPersonOfInterest(this);
		log.fine(getHead().fullName() + (surname == null
				? " founded the ruling house" : " succeeded as ruler")
				+ " of the settlement.");
	}

	/** The Crown is the sovereign root of the feudal tree — sworn to no liege. */
	@Override
	protected boolean isSovereign() {
		return true;
	}

	/** The current bank-profit tax rate — fraction of each public bank's distributable profit. */
	public double getBankProfitTaxRate() {
		return bankProfitTaxRate;
	}

	/** The current noble-income tax rate — fraction of each noble's income. */
	public double getNobleIncomeTaxRate() {
		return nobleIncomeTaxRate;
	}

	/**
	 * Set the bank-profit tax rate, clamped to [0, 1] — the interactive tax lever (see {@code
	 * com.civstudio.server.command.SetTaxRateCommand}). Applied at the deterministic top of a
	 * tick and inherited by the ruler's successor, so a run stays a pure function of its spec
	 * and command log.
	 *
	 * @param rate the new rate (clamped to [0, 1])
	 */
	public void setBankProfitTaxRate(double rate) {
		this.bankProfitTaxRate = clampRate(rate);
	}

	/**
	 * Set the noble-income tax rate, clamped to [0, 1] — the interactive tax lever (see {@code
	 * com.civstudio.server.command.SetTaxRateCommand}).
	 *
	 * @param rate the new rate (clamped to [0, 1])
	 */
	public void setNobleIncomeTaxRate(double rate) {
		this.nobleIncomeTaxRate = clampRate(rate);
	}

	private static double clampRate(double rate) {
		return Math.max(0, Math.min(1, rate));
	}

	/**
	 * Called by Settlement.newDay() in each step.
	 */
	public void act() {
		Bank bank = getBank();
		Account acct = bank.getAcct(getID());

		// the head may die of old age; its estate folds into the gold bank's
		// equity and a successor of the same dynasty inherits it (see the ruler
		// replacement policy)
		if (checkOldAgeDeath())
			return;

		// tax the colony's accumulated wealth into the treasury before spending
		collectTaxes();
		// and collect the crown's feudal dues from its DIRECT vassals — the peasants not enfeoffed
		// to a noble (docs/estate-system.md P4; the crown's own demesne render)
		collectDuesFromDirectVassals();

		// once a month, review each consumer-good sector and charter/dissolve firms
		// so their count tracks demand (see reviewSectors), and pick the colony's next
		// research focus if it has none (the cheapest researchable tech)
		if (getColony().getDate().getDayOfMonth() == 1) {
			reviewSectors();
			if (getColony().getResearch() != null)
				getColony().getResearch().review();
		}

		// a sovereign indulgence: spend a small fraction of the treasury on
		// enjoyment, posting a buy offer the market settles in clear(). Buying
		// copper-quoted enjoyment converts gold -> copper, so the gold bank skims
		// its FX fee. Move the budget into checking (drawing on savings) so the
		// purchase is funded; the rest stays on deposit.
		// indulge only out of a positive treasury; a ruler driven into debt (e.g.
		// borrowing to feed the peasant pool) stops buying luxuries rather than
		// posting a negative demand
		double wealth = acct.getChecking() + acct.getSavings();
		consumption = consumptionRate * Math.max(0, wealth);

		// the ruler keeps a lavish table: eat per member each step (it never starves)
		// and restock necessity toward its reserve. An adult eats the GOURMET ration, a
		// child the smaller child ration (a royal child eats like any colony child).
		// Necessity is copper-quoted like enjoyment, so the purchase converts gold ->
		// copper and fires the gold bank's FX fee.
		LocalDate today = getColony().getDate();
		necessity.decrease(householdDailyNeed(RationSize.GOURMET.perDay(),
				getColony().getFertilityConfig().childRation().perDay(), today));

		// bear a child: a wed ruling couple with a fertile female and a stocked larder
		// bears a child — a new child-ration-eating member of the ruling house (the
		// universal birth mechanism). A royal child becomes the hereditary heir by
		// promotion when the sovereign dies, continuing the line through its own issue
		// rather than a fresh-drawn successor. See docs/births.md.
		bearChildIfFertile(necessity.getQuantity(), RationSize.GOURMET.perDay());

		double nReserve = NECESSITY_RESERVE_DAYS * RationSize.GOURMET.perDay()
				* getMemberCount();
		nGap = Math.max(0, nReserve - necessity.getQuantity());
		double nCost = nGap * Math.max(nMkt.getLastMktPrice(), 0.01);

		// fund both purchases from the treasury (the rest stays on deposit)
		bank.deposit(getID(), acct.getChecking() - consumption - nCost);
		eMkt.addBuyOffer(this, demandForE);
		nMkt.addBuyOffer(this, demandForN);

		// if unmarried, seek a spouse on the wedding market (the sovereign weds
		// first of all, from its own wards — see WeddingMarket); on a build-economy
		// colony the housing gate applies (housedForGate below) — the vain court's
		// palace commission comes first (docs/build-queue-plan.md B3b)
		seekSpouseIfSingle();

		// work the strategic export firm: post the ruler to the noble-only labor
		// market every step (its head's SOCIAL drives its export output, exactly
		// like a noble's — see LaborMarket), so the export sector is never unstaffed
		// while the aristocracy is still being built up by ennoblement. A no-op for a
		// colony with no export sector. The export wage credits the gold treasury (FX
		// fee fires); the ruler does not draw dividends, and its reported income stays
		// 0 (getIncome) — the wage simply tops up the treasury. A child sovereign (an
		// underage heir who inherited the throne) does no labor until it comes of age.
		boolean headWorks = getHead().isAdult(today);
		if (headWorks && nobleLaborMkt != null)
			nobleLaborMkt.addEmployee(getID(), bank, 1.0, getHead().skills());

		// likewise work the science firm during the ramp, so research is staffed
		// before the scholarly aristocracy is raised (the ruler funds the science
		// wages from its treasury, so this returns part of that wage to itself)
		if (headWorks && scholarLaborMkt != null)
			scholarLaborMkt.addEmployee(getID(), bank, 1.0, getHead().skills());

		// tax revenue enters via collectTaxes (as OTHER, not income); reset the income
		// accumulators each step (the export wage is left to settle into the treasury).
		resetIncomeAccumulators(acct);
	}

	/**
	 * Tax the colony's accumulated wealth into the treasury (the first slice of
	 * the taxation feature): a fraction ({@code bankProfitTaxRate}) of each
	 * <b>public</b> bank's {@linkplain Bank#getDistributableProfit() distributable
	 * profit} — skimmed out of the bank's equity exactly as a noble dividend is,
	 * leaving estates-in-transit and injected funds alone — and a fraction
	 * ({@code nobleIncomeTaxRate}) of each living noble's income this step, withdrawn
	 * from the noble's account. A no-op when both rates are 0 (the default), so an
	 * untaxed colony is unchanged.
	 * <p>
	 * The crown's <b>own</b> (gold) bank is <b>not</b> taxed: it is a crown holding,
	 * so its retained profit <em>is</em> the treasury rather than tax revenue — taxing
	 * it would be the crown skimming its own bank into its own account (and double-dip
	 * against money it already owns). Only the public copper/silver institutions are
	 * taxed (see {@code docs/village-founding.md}).
	 * <p>
	 * Run before the ruler's own spending; because the ruler acts last each step,
	 * every noble's income field already holds this step's value, and the bank
	 * profit reflects what owners have already drawn. The revenue lands in the
	 * (gold) treasury, so copper-quoted taxes fire the gold bank's FX fee.
	 */
	// collect the crown's feudal dues from its DIRECT vassals — the peasant households sworn to no
	// noble (liegeId null, or this ruler's own id): a slice of each one's income into the treasury,
	// the crown's counterpart of a noble's dues from its fief tenants (P4). Kept separate from
	// collectTaxes so it runs regardless of the crown's tax levers.
	private void collectDuesFromDirectVassals() {
		if (Noble.VASSAL_DUES_RATE <= 0)
			return;
		Bank treasury = getBank();
		for (Agent a : getColony().getAgents()) {
			if (!(a.isAlive() && a instanceof com.civstudio.agent.laborer.Laborer l))
				continue;
			Integer liege = l.getLiegeId();
			if (liege != null && liege != getID())
				continue; // sworn to a noble — that noble collects, not the crown
			double due = Noble.VASSAL_DUES_RATE * l.getIncome();
			if (due > 0) {
				l.getBank().withdraw(l.getID(), due);
				treasury.credit(getID(), due, Bank.OTHER);
				crownDuesCollected += due; // a feudal render, tracked apart from the tax instrumentation
			}
		}
	}

	// cumulative feudal dues the crown has collected from its DIRECT vassals (instrumentation, P4) —
	// kept apart from taxCollected so the tax levers stay independently measurable
	private double crownDuesCollected;

	/** Total feudal dues the crown has collected from its direct-vassal peasants (P4). */
	public double getCrownDuesCollected() {
		return crownDuesCollected;
	}

	/**
	 * The <b>research grant</b> the crown can fund this step — {@link #RESEARCH_FUNDING_RATE} of a
	 * positive treasury, and <b>nothing at all while the crown is in debt</b>. The science firm bids
	 * the lesser of its configured wage budget and this, so the colony's research pace is bounded by
	 * the crown's actual means rather than draining it without limit.
	 * <p>
	 * This is the same rule the crown's enjoyment {@code consumption} already follows — a sovereign
	 * driven into debt stops spending rather than borrowing forever — applied to the one outflow that
	 * was exempt from it. Research is patronage, not an obligation: a crown that cannot pay for
	 * scholars simply has fewer of them, and the tech tree slows instead of the treasury sinking.
	 *
	 * @return the research funding available this step (never negative)
	 */
	public double researchGrant() {
		Account acct = getBank().getAcct(getID());
		if (acct == null)
			return 0;
		return RESEARCH_FUNDING_RATE * Math.max(0, acct.getChecking() + acct.getSavings());
	}

	private void collectTaxes() {
		if (bankProfitTaxRate <= 0 && nobleIncomeTaxRate <= 0)
			return;
		Bank treasury = getBank();

		if (bankProfitTaxRate > 0) {
			for (Bank b : getColony().getBanks()) {
				// skip the crown's own (gold) bank: its equity is the treasury, not a
				// taxable public institution
				if (b == treasury)
					continue;
				double tax = bankProfitTaxRate * b.getDistributableProfit();
				if (tax > 0) {
					b.payDividend(tax);
					treasury.credit(getID(), tax, Bank.OTHER);
					taxCollected += tax;
				}
			}
		}

		if (nobleIncomeTaxRate > 0) {
			for (Agent a : getColony().getAgents()) {
				if (a instanceof Noble noble && noble.isAlive()) {
					double tax = nobleIncomeTaxRate * noble.getIncome();
					if (tax > 0) {
						noble.getBank().withdraw(noble.getID(), tax);
						treasury.credit(getID(), tax, Bank.OTHER);
						taxCollected += tax;
					}
				}
			}
		}
	}

	/**
	 * <b>Dynamic firm provisioning.</b> Survey each consumer-good sector and, through
	 * the colony's {@link FirmFactory}, charter a firm where the colony is short of
	 * capacity or dissolve one where it is overbuilt — so the firm count tracks
	 * demand rather than being fixed at founding. A no-op when no factory is installed
	 * (the firm count then stays fixed) or a sector has no firms.
	 * <p>
	 * Called once a month — gated on the first of the month in {@link #act()} — a
	 * cadence slow relative to the production and revenue-smoothing lags, which (with
	 * the minimum-firm-lifetime and re-entry-cooldown hysteresis below) keeps the
	 * entry/exit from oscillating into a hog cycle.
	 * <p>
	 * The open rule is a hybrid of two demand signals: a <b>capacity</b> signal
	 * (smoothed utilization at/above {@link #OPEN_UTIL_THRESHOLD} with demand still
	 * unfilled), which is free of the band-limited-price bias and is what lets a
	 * one-firm sector cold-start, OR a <b>demand-growth</b> signal ({@link
	 * ConsumerGoodMarket#getUnmetPressure() pressure} — the short-run shortfall risen
	 * above the sector's own long-run baseline). Either, gated by the sector turning
	 * a profit (so a new entrant can be sustained), charters a firm. The close rule
	 * fires when the sector is overbuilt — either <b>idle capacity</b> (smoothed
	 * utilization below {@link #CLOSE_UTIL_THRESHOLD}) or an <b>unprofitable glut</b>
	 * (negative smoothed sector profit with no unmet-demand pressure — it has
	 * over-supplied and crashed its own price, which the utilization signal alone
	 * misses) — and cuts the weakest firm old enough to be eligible.
	 */
	public void reviewSectors() {
		if (getColony().getFirmFactory() == null)
			return; // nothing to act with — the colony keeps a fixed firm count
		List<ConsumerGoodFirm> eFirms = new ArrayList<>();
		List<ConsumerGoodFirm> nFirms = new ArrayList<>();
		for (Agent a : getColony().getAgents()) {
			if (a instanceof EFirm f && f.isAlive())
				eFirms.add(f);
			else if (a instanceof NFirm f && f.isAlive())
				nFirms.add(f);
		}
		reviewSector("enjoyment", eMkt, eFirms, false, eMemory);
		reviewSector("necessity", nMkt, nFirms, true, nMemory);
	}

	/**
	 * Review one consumer-good sector and charter or dissolve at most one firm. See
	 * {@link #reviewSectors()} for the open/close rules; {@code necessity} selects
	 * the inelastic-good thresholds and sector floor, and {@code mem} carries the
	 * per-sector re-entry cooldown state.
	 */
	private void reviewSector(String label, ConsumerGoodMarket mkt,
			List<ConsumerGoodFirm> firms, boolean necessity, SectorMemory mem) {
		if (firms.isEmpty())
			return;
		int now = getColony().getTimeStep();
		FirmFactory factory = getColony().getFirmFactory();

		double unmet = mkt.getSmoothedUnmetFraction();
		double pressure = mkt.getUnmetPressure();
		double sectorProfit = 0, sumUtil = 0;
		for (ConsumerGoodFirm f : firms) {
			sectorProfit += f.getSmoothedProfit();
			sumUtil += f.getSmoothedUtilization();
		}
		double avgUtil = sumUtil / firms.size();

		// charter? sector profitable AND (supply-constrained OR demand surging), and
		// not within the re-entry cooldown after a recent dissolution in this sector
		double openPressure = necessity
				? INELASTIC_OPEN_PRESSURE_THRESHOLD : OPEN_PRESSURE_THRESHOLD;
		boolean supplyConstrained =
				avgUtil >= OPEN_UTIL_THRESHOLD && unmet > MIN_UNMET_TO_OPEN;
		boolean demandSurging = pressure > openPressure;
		boolean canCharter = now - mem.lastDissolveStep >= REENTRY_COOLDOWN_DAYS;
		// only the on-plot necessity sector (the farms) is plot-capped: a colony full
		// at its (plots-capped) maximum cannot seat another farm, so skip the charter
		// (the sector stays supply-constrained, but the province has no room — Phase 2.5,
		// docs/geography.md). The enjoyment sector is center-grouped (consumes no plot),
		// so it always has room. A colony with no province cap effectively never hits this.
		boolean hasRoom = !necessity || getColony().hasRoomToExpand();
		if (sectorProfit > 0 && (supplyConstrained || demandSurging) && canCharter
				&& hasRoom) {
			ConsumerGoodFirm f = factory.charter(necessity);
			if (f != null) {
				mem.lastCharterStep = now;
				log.finer(String.format(
						"chartered a new %s firm (util=%.0f%% unmet=%.1f%% pressure=%+.1f%% sectorProfit=%.1f; now %d firms)",
						label, avgUtil * 100, unmet * 100, pressure * 100,
						sectorProfit, firms.size() + 1));
			}
			return;
		}

		// dissolve? the sector is overbuilt — by idle capacity (machines sitting unused)
		// OR by an unprofitable glut (losing money with no unmet-demand pressure: it has
		// over-supplied and crashed its own price, the deflation case the utilization
		// signal misses). Above the floor and not within the cooldown after a recent
		// charter; cut the weakest firm old enough to be eligible (the minimum-lifetime
		// rule spares a just-chartered firm).
		int minFirms = necessity ? MIN_NECESSITY_FIRMS : MIN_ENJOYMENT_FIRMS;
		boolean canDissolve = now - mem.lastCharterStep >= REENTRY_COOLDOWN_DAYS
				&& firms.size() > minFirms;
		boolean idleCapacity = avgUtil < CLOSE_UTIL_THRESHOLD;
		boolean unprofitableGlut = sectorProfit < 0
				&& mkt.getLastMktPrice() < GLUT_PRICE_FACTOR * mkt.getInitialPrice();
		if ((idleCapacity || unprofitableGlut) && canDissolve) {
			ConsumerGoodFirm weakest = null;
			for (ConsumerGoodFirm f : firms) {
				if (f.getAgeDays() < MIN_FIRM_LIFETIME_DAYS)
					continue; // too young to cut (hysteresis against seasonal churn)
				if (f.getSmoothedProfit() < 0 && (weakest == null
						|| f.getSmoothedProfit() < weakest.getSmoothedProfit()))
					weakest = f;
			}
			if (weakest != null) {
				factory.dissolve(weakest);
				mem.lastDissolveStep = now;
				log.finer(String.format(
						"dissolved %s (profit=%.1f age=%dd); %s overbuilt (%s) at util=%.0f%% pressure=%+.1f%% sectorProfit=%.1f, now %d firms",
						weakest.getName(), weakest.getSmoothedProfit(),
						weakest.getAgeDays(), label,
						idleCapacity ? "idle capacity" : "unprofitable glut",
						avgUtil * 100, pressure * 100, sectorProfit,
						firms.size() - 1));
			}
		}
	}

	/**
	 * Return a reference to the good with name <tt>goodName</tt> (only enjoyment,
	 * which the ruler buys; it holds nothing else).
	 */
	public Good getGood(String goodName) {
		if (goodName.equals("Enjoyment"))
			return enjoyment;
		if (goodName.equals("Necessity"))
			return necessity;
		return null;
	}

	/** The ruler's income: always zero (a passive treasury). */
	public double getIncome() {
		return 0;
	}

	/** Role label used in the persons-of-interest roster and death log. */
	@Override
	public String role() {
		return "Ruler";
	}

	/**
	 * The housing gate (build economy B3b): the sovereign too needs a current house —
	 * its palace commission is the BuilderFirm's first client (housing-first).
	 */
	@Override
	public boolean housedForGate() {
		return hasCurrentHouse();
	}

	/** A ruler commands a {@link Rank#VILLAGE} — the settlement it leads. */
	@Override
	public Rank rank() {
		return Rank.VILLAGE;
	}

	/** The sovereign weds first of all (above nobles and laborers). */
	@Override
	public int weddingPriority() {
		return 2;
	}

	/**
	 * The heir who succeeds this ruler: a same-dynasty sovereign inheriting the
	 * treasury. Also updates the colony's ruler reference, so anything that bills
	 * the ruler (e.g. a builder's public works) bills the heir, not the dead
	 * sovereign's closed account. The colony's built-in replacement policy calls
	 * this, so no simulation need wire a ruler rule.
	 */
	@Override
	public Agent successor(Settlement colony) {
		Ruler heir = new Ruler(this, colony);
		colony.setRuler(heir);
		return heir;
	}

	/**
	 * A concise, debug-friendly summary using only cached fields, so it is safe
	 * even after the ruler's account has been closed.
	 */
	@Override
	public String toString() {
		return String.format("Ruler#%d %s [%s %s age=%d]", getID(),
				getHead().fullName(), isAlive() ? "alive" : "dead",
				getHead().skills(), getAgeYears());
	}
}
