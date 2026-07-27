package com.civstudio.market;

import java.util.ArrayList;

import com.civstudio.agent.Agent;
import com.civstudio.bank.Bank;
import com.civstudio.settlement.Settlement;
import com.civstudio.util.Averager;
import lombok.extern.java.Log;

/**
 * A market trading consumer goods.
 *
 * @author zhihongx
 *
 */
@Log
public class ConsumerGoodMarket extends Market {
	/***************** constants ********************************/
	// percentage by which price could change in each step
	private static final double zeta = 0.1;

	// price is flagged once it exceeds this multiple of its initial level
	private static final int PRICE_SKYROCKET_FACTOR = 10;

	// subsistence price floor, as a fraction of the founding reference price: the discovered price
	// is never allowed to collapse below this. A market that crashes to (near) 0 under a demand-
	// deficient transient — every buyer starts well-stocked, so demand is ~0 — zeroes the seller's
	// revenue, hence its labor-share wage budget, hence its labor, hence its production, so the
	// colony starves with NO supply despite the cheap price (a deflationary death spiral; see the
	// small booted-colony collapse). Flooring the price keeps the sector some revenue/output; kept
	// well below the glut threshold (GLUT_PRICE_FACTOR = 0.3 in Ruler.reviewSector) so overbuilt-
	// sector detection is unaffected. It also spares the output rule its price-in-the-denominator
	// (marginalProfit / pPrice) blowup at price 0.
	private static final double PRICE_FLOOR_FRACTION = 0.05;

	// Scarcity price CEILING, as a multiple of the founding reference — the floor's mirror image, and
	// for the same reason: a discovered price is only meaningful while the search actually discovers
	// something, and past a point a runaway quote is not information.
	//
	// The band search brackets [p(1-zeta), p(1+zeta)] around yesterday's price. When demand exceeds
	// supply at EVERY price in that window the search cannot converge, so it settles at the top rail
	// and the price ratchets +zeta — compounding ~10% a day, 1.1^365 ≈ 10^15 a year. Holding
	// yesterday's price on a day with NO supply (below) closed the empty-market case, but not this
	// one: a market with a TRICKLE of supply against large demand takes the same rail every day, and
	// measured 2.5e12x in 300 days. That is the "1e+30 food price" the UI was rendering.
	//
	// Deliberately far above the ordinary range (the skyrocket WARNING at 10x still fires first, so
	// the anomaly is still reported before the clamp bites) and far above any peak a healthy colony
	// reaches. Nothing is hidden by it: the shortage drives the ruler's chartering through the
	// unmet-demand pressure signal, which is computed from demand and supply directly and never
	// looks at the price.
	private static final double PRICE_CEILING_FACTOR = 50;

	// window (days) over which the unmet-demand fraction is smoothed for the
	// short-run pressure reading. Long enough to span the rest-day calendar so a
	// single closed day's zero-supply spike does not read as a chronic shortage.
	private static final int RATIONING_WIN = 30;

	// window (days) for the long-run baseline the short-run reading is measured
	// against — a year, so seasonal and rest-day structure averages out and only a
	// rise above the colony's own norm registers as demand pressure.
	private static final int BASELINE_WIN = 365;

	/**********************************************************/

	/* buy offer */
	private class BuyOffer {
		Agent buyer;
		Demand demand;
		// where the bought good is delivered when it differs from the buyer's own stock — the
		// city-of-hamlets V2 seam: a village's leader PAYS (buyer = the leader, so its account is
		// debited and its demand drives price discovery) but the food is delivered into the village
		// LARDER (deliverTo), not the leader's own necessity. Null = deliver to buyer.getGood(good),
		// the ordinary case. See addBuyOffer(Agent, Good, Demand).
		com.civstudio.good.Good deliverTo;
	}

	/* sell offer */
	private class SellOffer {
		Agent seller;
		double qty; // quantity of good available for sale
	}

	// initial min and max price
	private final double initLow, initHigh;

	// buy offers submitted in the current step
	private ArrayList<BuyOffer> buyOffers;

	// sell offers submitted in the current step
	private ArrayList<SellOffer> sellOffers;

	// last market price
	private double mktPrice;

	// volume of good traded
	private double mktGoodVol;

	// volume of money exchanged
	private double mktMoneyVol;

	// total supply of good
	private double mktSupply;

	// total demand at the clearing price (the matched demand curve, not just the
	// filled volume), recorded so the unmet-demand fraction can be derived
	private double mktDemand;

	// fraction of demand left unfilled because supply fell short
	// (max(0, (demand - supply) / demand)), smoothed two ways: a short window
	// (RATIONING_WIN) tracks current pressure, a long window (BASELINE_WIN) the
	// structural level. Their difference — getUnmetPressure() — is the entry/exit
	// signal the ruler's dynamic-firm review reads, so the chronic band-limited-
	// price bias (in an inflating colony the sticky price always lags demand) and
	// the rest-day supply gaps, which inflate both windows equally, cancel out:
	// only a *rise* in unmet demand above the colony's own norm registers.
	private final Averager unmetAvger = new Averager(RATIONING_WIN);
	private final Averager baselineAvger = new Averager(BASELINE_WIN);
	private double smoothedUnmet;
	private double unmetBaseline;

	// whether the price is currently flagged as skyrocketed
	private boolean priceSkyrocketed = false;

	/**
	 * Create a new consumer good market trading a good named good
	 * 
	 * @param good
	 *            name of the good traded in the market
	 *            <p>
	 * @param initLow
	 *            min initial price
	 *            <p>
	 * @param initHigh
	 *            max initial price
	 *            <p>
	 * @param colony
	 *            the colony this market belongs to
	 */
	public ConsumerGoodMarket(String good, double initLow, double initHigh,
			Settlement colony) {
		super(good, colony);
		buyOffers = new ArrayList<BuyOffer>();
		sellOffers = new ArrayList<SellOffer>();
		this.initLow = initLow;
		this.initHigh = initHigh;
	}

	/**
	 * Add a buy offer
	 * 
	 * @param buyer
	 *            <p>
	 * @param demand
	 */
	public void addBuyOffer(Agent buyer, Demand demand) {
		addBuyOffer(buyer, null, demand);
	}

	/**
	 * Add a buy offer whose <b>payer and delivery target differ</b> — {@code payer}'s bank account
	 * is debited and its demand joins price discovery, but the bought good is delivered into {@code
	 * deliverTo} rather than {@code payer.getGood(good)}. The city-of-hamlets V2 seam: a village's
	 * leader pays for its {@link com.civstudio.settlement.Larder larder}'s food deficit (so the
	 * village is the market's food participant) while the food lands in the larder, not the leader's
	 * own store.
	 *
	 * @param payer     the agent whose account pays for the fill
	 * @param deliverTo the good the bought quantity is added to (e.g. a village larder's Necessity);
	 *                  {@code null} delivers to {@code payer.getGood(good)} as usual
	 * @param demand    the demand curve
	 */
	public void addBuyOffer(Agent payer, com.civstudio.good.Good deliverTo, Demand demand) {
		BuyOffer offer = new BuyOffer();
		offer.buyer = payer;
		offer.deliverTo = deliverTo;
		offer.demand = demand;
		buyOffers.add(offer);
	}

	/**
	 * Add a sell offer
	 * 
	 * @param seller
	 *            <p>
	 * @param qty
	 *            quantity of good available for sale
	 */
	public void addSellOffer(Agent seller, double qty) {
		SellOffer offer = new SellOffer();
		offer.seller = seller;
		offer.qty = qty;
		sellOffers.add(offer);
	}

	/**
	 * Return the total demand given price
	 * 
	 * @param price
	 *            <p>
	 * @return total demand given price
	 */
	private double getDemand(double price) {
		double demand = 0;
		for (BuyOffer offer : buyOffers)
			demand += offer.demand.getDemand(price);
		return demand;
	}

	/**
	 * Return the total supply
	 * 
	 * @return the total supply
	 */
	private double getSupply() {
		double supply = 0;
		for (SellOffer offer : sellOffers)
			supply += offer.qty;
		return supply;
	}

	/**
	 * Clear the market.
	 */
	public void clear() {
		double low, high, price;
		if (colony.getTimeStep() == 0) {
			low = initLow;
			high = initHigh;
		} else {
			low = mktPrice * (1 - zeta);
			high = mktPrice * (1 + zeta);
		}

		double supply = getSupply();
		double demand;
		
		// find market price
		int iters = 0;
		while (true) {
			price = (low + high) / 2;
			demand = getDemand(price);
			if (Math.abs(demand - supply) < 0.1 || Math.abs(high - low) < 0.01)
				break;
			if (demand > supply)
				low = price;
			else
				high = price;
			// safety net: a non-finite price (or pathological non-convergence)
			// would otherwise loop forever, since NaN/Infinity fail both exit
			// tests above. A finite search converges well within this cap.
			if (!Double.isFinite(price) || ++iters > 100) {
				// FINER, not WARN: on real ground this fires routinely (a thin/empty market has
				// supply≈0 against fixed demand, so no finite clearing price exists) and buried the log.
				log.finer(String.format(
						"%s price search did not converge (price=%.2f supply=%.2f demand=%.2f); aborting",
						good, price, supply, demand));
				break;
			}
		}

		// subsistence price floor: never clear below a small fraction of the founding reference, so a
		// demand-deficient crash cannot zero the sector's revenue/wages/production (the deflationary
		// death spiral) — the price stays low (cheap food to stockpile) but the farm keeps producing.
		double reference = (initLow + initHigh) / 2;
		double priceFloor = PRICE_FLOOR_FRACTION * reference;
		if (price < priceFloor)
			price = priceFloor;
		// …and the same clamp on the scarcity side, before anything transacts at it — see
		// PRICE_CEILING_FACTOR. Applied here rather than to mktPrice alone so the day's actual
		// transactions settle at the clamped price too: a buyer must not be charged a number the
		// market itself will not stand behind tomorrow.
		double priceCeiling = PRICE_CEILING_FACTOR * reference;
		if (price > priceCeiling)
			price = priceCeiling;

		double vol = Math.min(supply, demand);

		// carry out transactions
		if (vol > 0.1) {
			for (BuyOffer offer : buyOffers) {
				double qty = offer.demand.getDemand(price) / demand
						* vol;
				double payAmt = qty * price;
				offer.buyer.getBank().withdraw(offer.buyer.getID(), payAmt);
				// deliver to the offer's target good when it names one (a village larder), else to the
				// payer's own stock (the ordinary case)
				(offer.deliverTo != null ? offer.deliverTo : offer.buyer.getGood(good)).increase(qty);
			}
			for (SellOffer offer : sellOffers) {
				double qty = offer.qty / supply * vol;
				double payAmt = qty * price;
				offer.seller.getBank().credit(offer.seller.getID(), payAmt,
						Bank.PRIIC);
				offer.seller.getGood(good).decrease(qty);
			}
		}

		// A price is the price at which something was SOLD. When nothing was offered at all, the band
		// search has no supply to converge on: demand exceeds it at every price in the band, so the
		// search runs to the top and the price ratchets +zeta. Repeat that daily and it compounds —
		// 1.1^365 is 10^15 a year — which is exactly what a colony whose food has moved off the market
		// (home-plot subsistence and village larders feed it now) was doing on roughly half of seeds:
		// the necessity price reached 10^30 and beyond, unnoticed, because nothing depends on it to
		// survive any more. An empty market is not a dear market; it is a market with no information.
		// So on a day with NOTHING to sell, yesterday's price stands.
		//
		// Only the no-supply side is held. A glut (supply offered, no buyers) still discovers downward
		// as before — falling is bounded by the price floor, and the ruler's overbuilt-sector detection
		// reads that fall. And the shortage is NOT hidden by holding the price: the unmet-demand
		// fraction below is computed from demand and supply directly, so the pressure signal that
		// drives the ruler to charter another farm registers the shortfall exactly as it did.
		if (supply > 0 || colony.getTimeStep() == 0)
			mktPrice = price;

		// flag when the price drifts past a high multiple of its initial level,
		// and again when it returns below; log once per crossing
		double skyrocketThreshold = PRICE_SKYROCKET_FACTOR * initHigh;
		if (!priceSkyrocketed && mktPrice > skyrocketThreshold) {
			priceSkyrocketed = true;
			log.warning(String.format("%s skyrocketed to %.2f (>%dx init)",
					good, mktPrice, PRICE_SKYROCKET_FACTOR));
		} else if (priceSkyrocketed && mktPrice <= skyrocketThreshold) {
			priceSkyrocketed = false;
			log.finer(String.format("%s back below threshold (%.2f)", good,
					mktPrice));
		}

		mktGoodVol = vol;
		mktMoneyVol = price * mktGoodVol;
		mktSupply = supply;
		mktDemand = demand;

		// the fraction of this step's demand that supply could not cover; smoothed
		// over the rest-day calendar so closed-day supply gaps do not masquerade as
		// a chronic shortage. Pure bookkeeping — moves no money, draws no randomness.
		double unmet = demand > 0 ? Math.max(0, (demand - supply) / demand) : 0;
		smoothedUnmet = unmetAvger.update(unmet);
		unmetBaseline = baselineAvger.update(unmet);

		buyOffers.clear();
		sellOffers.clear();
	}

	/**
	 * Return market price
	 *
	 * @return market price
	 */
	public double getLastMktPrice() {
		return mktPrice;
	}

	/**
	 * The market's <b>initial reference price</b> — the midpoint of its founding price
	 * band ({@code (initLow + initHigh) / 2}). A stable anchor the price is expected to
	 * hover around; a market price far below it signals a deflationary glut (supply has
	 * outrun demand and crashed the price), which the dynamic provisioning's close rule
	 * reads to tell a true oversupply from a merely loss-making but needed sector (the
	 * rest-day-inflated unmet fraction cannot tell them apart). See {@code
	 * docs/food-balance.md}.
	 *
	 * @return the midpoint of the founding price band
	 */
	public double getInitialPrice() {
		return (initLow + initHigh) / 2;
	}

	/**
	 * Return volume of good traded
	 * 
	 * @return volume of good traded
	 */
	public double getLastMktGoodVol() {
		return mktGoodVol;
	}

	/**
	 * Return volume of money exchanged
	 * 
	 * @return volume of money exchanged
	 */
	public double getLastMktMoneyVol() {
		return mktMoneyVol;
	}

	/**
	 * Return total supply
	 *
	 * @return total supply
	 */
	public double getLastMktSupply() {
		return mktSupply;
	}

	/**
	 * Return the total demand at the last clearing price (the matched demand, which
	 * may exceed the filled volume when supply fell short).
	 *
	 * @return total demand at the last clearing price
	 */
	public double getLastMktDemand() {
		return mktDemand;
	}

	/**
	 * Return the short-run smoothed fraction of demand left unfilled for want of
	 * supply, averaged over {@link #RATIONING_WIN} days — {@code 0} when supply met
	 * demand, approaching {@code 1} as the shortfall grows. This is the raw level;
	 * the ruler's review reads {@link #getUnmetPressure()} (this minus its long-run
	 * baseline) so the chronic structural component cancels.
	 *
	 * @return smoothed unmet-demand fraction in {@code [0, 1)}
	 */
	public double getSmoothedUnmetFraction() {
		return smoothedUnmet;
	}

	/**
	 * Return the <b>demand pressure</b>: the short-run unmet fraction
	 * ({@link #getSmoothedUnmetFraction()}) minus its long-run baseline (averaged
	 * over {@link #BASELINE_WIN} days). Positive means unmet demand has risen above
	 * the colony's own norm — a genuine shortage the current firms cannot meet,
	 * net of the structural band-limited-price and rest-day bias that inflates the
	 * raw level; negative means it has eased below the norm. This relative signal,
	 * not the absolute level, drives the ruler's charter/dissolve decisions.
	 *
	 * @return short-run unmet fraction minus its long-run baseline (may be negative)
	 */
	public double getUnmetPressure() {
		return smoothedUnmet - unmetBaseline;
	}

	@Override
	public String toString() {
		return String.format(
				"%s [price=%.3f vol=%.1f supply=%.1f buys=%d sells=%d]",
				name, mktPrice, mktGoodVol, mktSupply, buyOffers.size(),
				sellOffers.size());
	}
}
