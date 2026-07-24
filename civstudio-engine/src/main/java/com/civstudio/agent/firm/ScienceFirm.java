package com.civstudio.agent.firm;

import java.util.Set;

import com.civstudio.agent.ruler.Ruler;
import com.civstudio.calendar.DayType;
import com.civstudio.bank.Bank;
import com.civstudio.good.Good;
import com.civstudio.market.LaborMarket;
import com.civstudio.settlement.Settlement;
import com.civstudio.skill.Skill;
import com.civstudio.tech.ResearchState;
import lombok.Getter;

/**
 * The settlement's <b>science firm</b>: a labor-only firm that produces the colony's
 * research. It mirrors {@link BuilderFirm} and {@link StrategicFirm} — it hires on a
 * dedicated {@value #LABOR_MARKET} market (whose workers are the colony's
 * <b>scholars</b>: the nobles, and the ruler during the early ennoblement ramp,
 * supplying their {@link Skill#INTELLECTUAL} labor) and converts that labor into
 * <i>research points</i> by {@code A · L^beta} — but instead of building rings or
 * exporting a good, it delivers those points to the colony's {@link ResearchState}
 * (which advances the current research focus; see {@code docs/tech-tree.md}).
 * <p>
 * Research is a <b>crown-funded public good</b>: the firm sells nothing, so its wage
 * budget is funded each step out of the {@link Ruler ruler}'s treasury — the ruler
 * both directs research (it picks the monthly focus) and pays for it. The wages then
 * flow to the scholars when the market clears, so the firm is a near zero-profit
 * conduit (ruler → firm → scholars), exactly as the builder is for its peasants. A
 * colony with no ruler funds no scholars, so research simply does not advance.
 */
public class ScienceFirm extends Firm {

	/**
	 * Name of the dedicated labor market the science firm hires from, whose workers
	 * are the colony's nobles (and the ruler). Kept separate from the general
	 * {@code "Labor"} and the export {@code "NobleLabor"} markets so the pools never
	 * mix; a noble supplies its intellectual labor to <em>both</em> the export sector
	 * and this one (a scholar-merchant doing double duty).
	 */
	public static final String LABOR_MARKET = "ScholarLabor";

	@Getter
	private final ScienceConfig config;

	// the dedicated scholar labor market the firm hires from
	private final LaborMarket lMkt;

	// research points produced last step, and cumulatively over the firm's life
	@Getter
	private double researchProduced;
	@Getter
	private double totalResearchProduced;

	/**
	 * Create the colony's science firm. Seeded with a checking balance of one
	 * {@link ScienceConfig#wageBudget()} so it can pay its first scholars before the
	 * ruler's first funding transfer; it posts no wage budget at construction (it is
	 * funded and bids in {@link #act()}).
	 *
	 * @param config
	 *            tunable model parameters
	 * @param bank
	 *            the bank at which the firm holds its account
	 * @param colony
	 *            the colony it researches for
	 */
	public ScienceFirm(ScienceConfig config, Bank bank, Settlement colony) {
		super(config.wageBudget(), 0, bank, colony);
		setName("Science Firm");
		this.config = config;
		this.lMkt = (LaborMarket) colony.getMarket(LABOR_MARKET);
		this.wageBudget = 0; // funded and bid in act()
	}

	/**
	 * Called by Settlement.newDay() in each step.
	 */
	public void act() {
		Bank bank = getBank();
		Settlement colony = getColony();

		// 1. convert last step's hired scholarly labor into research points and deliver
		//    them to the colony's research (no money moves — research is a side product
		//    of the labor, exactly as build-units are for the builder)
		double laborQty = labor.getQuantity();
		researchProduced = convertToProduct(laborQty);
		totalResearchProduced += researchProduced;
		output = researchProduced;
		ResearchState research = colony.getResearch();
		if (research != null)
			research.accrue(researchProduced);

		// 2. fund next step's wage budget out of the ruler's treasury (the crown pays
		//    for research), so the scholar market can pay the scholars when it clears.
		//    With no living ruler there is no patron, so the firm bids nothing.
		double prevBudget = wageBudget;
		double newWageBudget = config.wageBudget();
		Ruler ruler = colony.getRuler();
		if (ruler != null && ruler.isAlive()) {
			// bid the configured budget only so far as the crown can actually pay for it: research is
			// patronage out of a positive treasury, not a standing charge on it. Funding the full
			// budget regardless of means made this the crown's largest permanent outflow and drove the
			// treasury monotonically negative (-3.5k after a year, -80k after ten), which in turn left
			// the crown unable to meet its other obligations — its demesne villages' provisioning among
			// them. Now a broke crown simply keeps fewer scholars until its treasury recovers.
			newWageBudget = Math.min(newWageBudget, ruler.researchGrant());
			if (newWageBudget > 0) {
				ruler.getBank().withdraw(ruler.getID(), newWageBudget);
				bank.credit(getID(), newWageBudget, Bank.OTHER);
			}
		} else {
			newWageBudget = 0;
		}

		wage = laborQty > 0 ? prevBudget / laborQty : 0;
		totalCost = prevBudget;
		revenue = 0; // research is not sold
		profit = 0; // a near zero-profit conduit (ruler funds, scholars receive)
		wageBudget = newWageBudget;

		// 3. post the wage budget to the scholar labor market for the next round
		lMkt.addEmployer(this, labor, newWageBudget);

		labor.decrease(labor.getQuantity()); // labor consumed in research
	}

	/**
	 * Return research points produced by <tt>labor</tt> amount of scholarly labor.
	 *
	 * @param labor
	 *            amount of labor
	 * @return research points produced, {@code A · labor^beta}
	 */
	public double convertToProduct(double labor) {
		return config.A() * Math.pow(labor, config.beta());
	}

	/**
	 * Return a reference to <tt>good</tt> owned by the firm.
	 */
	public Good getGood(String good) {
		if (good.equals("Labor"))
			return labor;
		return null;
	}

	/** The export firm runs every day; scholarship likewise never rests. */
	@Override
	public boolean operatesOn(DayType day) {
		return true;
	}

	/** Scholarly research trains {@link Skill#INTELLECTUAL}. */
	@Override
	public Set<Skill> laborSkills() {
		return Set.of(Skill.INTELLECTUAL);
	}
}
