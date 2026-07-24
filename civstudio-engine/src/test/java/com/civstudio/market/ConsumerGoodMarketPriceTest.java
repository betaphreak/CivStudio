package com.civstudio.market;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

import com.civstudio.agent.firm.StrategicFirmConfig;
import com.civstudio.bank.Bank;
import com.civstudio.era.Era;
import com.civstudio.settlement.Settlement;
import com.civstudio.simulation.SimulationConfig;
import com.civstudio.simulation.SimulationHarness;

/**
 * The consumer-good market's <b>price discovery under scarcity</b>: a price is the price at which
 * something was sold, so a day on which <b>nothing was offered</b> discovers no new price and
 * yesterday's stands.
 * <p>
 * Without that rule an empty market ratchets: the band search finds demand above supply at every
 * price in its {@code ±zeta} window, settles at the top, and repeats — compounding roughly 10% a day
 * into astronomical prices within a couple of in-game years. It went unnoticed for a long time
 * because since the home-plot and village-larder flips nothing depends on the food price to survive
 * (households eat from their plots and their village's larder), so the necessity market can sit
 * empty for years while its quoted price explodes and no test or colony ever notices.
 */
class ConsumerGoodMarketPriceTest {

	private static Settlement foundColony(SimulationConfig cfg, long seed) {
		SimulationHarness h = SimulationHarness.create(cfg, seed);
		Settlement colony = h.getColony();
		h.createMarkets();
		Bank copper = h.getCopperBank();
		h.createNobleLaborMarket();
		Era.Economy econ = colony.getEconomy();
		h.createFirms(copper, i -> copper, i -> econ.eFirm().savings(), i -> econ.nFirm().savings());
		h.createStrategicFirm(copper, StrategicFirmConfig.DEFAULT);
		h.primeNobleLabor();
		h.createDefaultRuler();
		h.createDefaultRetinue();
		h.foundLaborersFromRetinue(i -> copper, i -> 15);
		return colony;
	}

	// THE regression: a colony's food price must stay in a sane band over a long run, on every seed —
	// including the seeds whose necessity market is dry almost every day, which is the normal state of
	// a colony that feeds itself off its plots and larders rather than off the market.
	@Test
	void anEmptyFoodMarketDoesNotRunAwayOverAMultiYearRun() {
		for (long seed : new long[] { 7654321L, 424242L, 999983L }) {
			Settlement colony = foundColony(SimulationConfig.DEFAULT, seed);
			ConsumerGoodMarket necessity = (ConsumerGoodMarket) colony.getMarket("Necessity");
			double worst = 0;
			int dry = 0;
			for (int day = 0; day < 5 * 365; day++) {
				colony.run(1);
				if (!colony.isAlive())
					break;
				if (necessity.getLastMktSupply() < 0.1 && necessity.getLastMktDemand() > 0.1)
					dry++;
				worst = Math.max(worst, necessity.getLastMktPrice());
			}
			// a generous band — this is a runaway guard, not a calibration pin. The observed peak is a
			// couple of dozen times the reference; an unchecked ratchet reaches 1e30 and beyond.
			assertTrue(worst < 100 * necessity.getInitialPrice(),
					"seed " + seed + ": food price ran away to " + worst + " (dry on " + dry
							+ " days) — the empty-market ratchet is back");
		}
	}

	@Test
	void aDayWithNothingToSellDiscoversNoNewPrice() {
		Settlement colony = foundColony(SimulationConfig.DEFAULT, 7654321L);
		ConsumerGoodMarket necessity = (ConsumerGoodMarket) colony.getMarket("Necessity");
		colony.run(200); // past founding, so the market carries a discovered price
		double before = necessity.getLastMktPrice();
		assertTrue(before > 0, "the market has a price to hold");

		// a hungry day with no seller at all: demand posted, nothing offered
		necessity.addBuyOffer(colony.getRuler(), price -> 500);
		necessity.clear();
		assertEquals(before, necessity.getLastMktPrice(), 1e-12,
				"an empty market is not a dear market — yesterday's price stands");
		// and the shortage is still reported, so the ruler's charter signal is untouched
		assertTrue(necessity.getLastMktDemand() > 0, "the unmet demand is still recorded");
		assertEquals(0, necessity.getLastMktSupply(), 1e-12);
	}

	@Test
	void aGlutStillDiscoversDownward() {
		Settlement colony = foundColony(SimulationConfig.DEFAULT, 7654321L);
		ConsumerGoodMarket enjoyment = (ConsumerGoodMarket) colony.getMarket("Enjoyment");
		colony.run(200);
		double before = enjoyment.getLastMktPrice();

		// supply offered, nobody buying: the price must still fall, so the ruler's overbuilt-sector
		// detection keeps working. Only the NO-supply side is held.
		enjoyment.addSellOffer(colony.getRuler(), 5000);
		enjoyment.clear();
		assertTrue(enjoyment.getLastMktPrice() < before,
				"a glut still cheapens: " + enjoyment.getLastMktPrice() + " vs " + before);
	}
}
