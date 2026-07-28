package com.civstudio.server.town;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

import org.junit.jupiter.api.Test;

import com.civstudio.server.town.TownRiver.Water;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Poly;
import com.civstudio.server.town.geom.Pt;

/**
 * The river through town ({@code docs/towngen-port.md} T4b, §7a). A coastline lies on patch
 * boundaries and T4 typed it as quay for free; a river runs through plot <b>centres</b> and cuts
 * across a patch, so the only way lots stay out of the water is for something to take the channel
 * away from them first.
 */
class TownRiverTest {

	private static final Predicate<Cell> ALL_LAND = c -> true;

	/** The engine's mask bits: 1=E, 2=W, 4=S, 8=N. */
	private static final int E = 1, W = 2, S = 4, N = 8;

	private static Set<Cell> block(int x0, int y0, int w, int h) {
		Set<Cell> out = new LinkedHashSet<>();
		for (int y = y0; y < y0 + h; y++) {
			for (int x = x0; x < x0 + w; x++) {
				out.add(new Cell(x, y));
			}
		}
		return out;
	}

	private static Footprint town(int w, int h) {
		return Footprint.of(block(0, 0, w, h), ALL_LAND);
	}

	/** A river on exactly the given cells, each with the given links. */
	private static Water flowing(java.util.Map<Cell, Integer> links) {
		return new Water() {

			@Override
			public boolean river(Cell cell) {
				return links.containsKey(cell);
			}

			@Override
			public int links(Cell cell) {
				return links.getOrDefault(cell, 0);
			}
		};
	}

	private static final Poly UNIT = Poly.rect(1, 1, 1, 1);   // the block of cell (1, 1)

	// --- the chord ----------------------------------------------------------------------------

	@Test
	void aStraightRunIsAChordBetweenTwoEdgeMidpoints() {
		// the exact case: a river entering west and leaving east runs the full width of the plot,
		// through its centre, and the chord says so without approximating anything
		TownRiver r = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(1, 1), E | W)));
		TownRiver.Chord ch = r.chords().get(new Cell(1, 1));
		assertFalse(ch.confluence());
		assertEquals(1.5, ch.from().y(), 1e-9);
		assertEquals(1.5, ch.to().y(), 1e-9);
		assertEquals(1.0, Math.abs(ch.to().x() - ch.from().x()), 1e-9, "it crosses the whole plot");
	}

	@Test
	void aBendIsTheStraightChordAcrossIt() {
		// the documented approximation: the real channel curves through the centre, and this cuts
		// the corner. Accepted at a scale where a lot is symbolic — but it must still be a chord
		// between the two edges the water actually uses, not something invented.
		TownRiver r = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(1, 1), E | S)));
		TownRiver.Chord ch = r.chords().get(new Cell(1, 1));
		Set<Pt> ends = Set.of(ch.from(), ch.to());
		assertTrue(ends.contains(new Pt(2.0, 1.5)), "the east edge: " + ends);
		assertTrue(ends.contains(new Pt(1.5, 2.0)), "the south edge: " + ends);
	}

	@Test
	void aSourceRunsFromTheCentreToItsOneEdge() {
		TownRiver r = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(1, 1), E)));
		TownRiver.Chord ch = r.chords().get(new Cell(1, 1));
		assertEquals(new Pt(1.5, 1.5), ch.from(), "the spring is at the plot's centre");
		assertEquals(new Pt(2.0, 1.5), ch.to());
	}

	@Test
	void aConfluenceIsAllWater() {
		// three or four links and the plot is not a plot with a river on it — it is water with a
		// little land at the corners, and nothing stands there
		TownRiver r = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(1, 1), E | W | S)));
		assertTrue(r.isChannel(new Cell(1, 1)));
		assertEquals(1, r.diag().confluences());
		assertEquals(List.of(), r.banks(new Cell(1, 1), UNIT), "nothing may be built here");
	}

	@Test
	void aRiverThatGoesNowhereIsNoChannel() {
		// river() true with no adjacency: water on the plot, but nothing crossing it
		TownRiver r = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(1, 1), 0)));
		assertSame(TownRiver.NONE, r);
		assertFalse(r.runsThrough(new Cell(1, 1)));
	}

	// --- the banks ----------------------------------------------------------------------------

	@Test
	void aRiverPlotOffersTwoBanksAndTheChannelBetweenThem() {
		// the whole point: a town on a river builds on BOTH sides of it rather than forfeiting the
		// smaller half to the water
		TownRiver r = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(1, 1), E | W)));
		List<Poly> banks = r.banks(new Cell(1, 1), UNIT);
		assertEquals(2, banks.size(), "north bank and south bank");
		for (Poly b : banks) {
			assertTrue(b.area() > 0);
			for (int i = 0; i < b.size(); i++) {
				assertTrue(Math.abs(b.get(i).y() - 1.5) >= TownRiver.BANK - 1e-9,
						"no corner stands in the water: " + b.get(i));
			}
		}
		double dry = banks.get(0).area() + banks.get(1).area();
		assertTrue(dry < UNIT.area(), "the channel took its share: " + dry);
		assertEquals(UNIT.area() - 2 * TownRiver.BANK, dry, 1e-9,
				"and exactly its share — twice the bank buffer, across a unit plot");
	}

	@Test
	void aDryPlotOffersItsWholeBlockUntouched() {
		TownRiver r = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(0, 0), E)));
		assertEquals(List.of(UNIT), r.banks(new Cell(1, 1), UNIT));
	}

	@Test
	void aTownWithNoRiverTouchesNothing() {
		TownRiver r = TownRiver.of(town(3, 3), new Water() {
		});
		assertSame(TownRiver.NONE, r);
		assertTrue(r.isEmpty());
		assertEquals(List.of(UNIT), r.banks(new Cell(1, 1), UNIT));
		assertFalse(r.diag().interesting());
	}

	@Test
	void aBankTheChannelAteComesBackAbsentRatherThanAsASliver() {
		// a narrow block with the river down the middle of it: what survives is buildable ground or
		// nothing, never a splinter for the cutter to choke on
		Poly narrow = Poly.rect(1.4, 1, 0.2, 1);
		TownRiver r = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(1, 1), N | S)));
		for (Poly b : r.banks(new Cell(1, 1), narrow)) {
			assertTrue(b.area() > 0, "every bank returned is real ground");
		}
	}

	// --- totality -----------------------------------------------------------------------------

	@Test
	void nothingToTraceIsAnAnswerNotAFailure() {
		assertSame(TownRiver.NONE, TownRiver.of(Footprint.EMPTY, flowing(java.util.Map.of())));
		assertSame(TownRiver.NONE, TownRiver.of(town(3, 3), null));
		assertEquals(List.of(), TownRiver.NONE.banks(new Cell(0, 0), Poly.EMPTY));
	}

	@Test
	void theMaskBitsAreTheEnginesOwn() {
		// 1=E, 2=W, 4=S, 8=N — the same order Plot.riverAdj uses, the same order TownWall.Side uses
		// and the same order river-geom.mjs NB4 uses. A silent disagreement here would put every
		// channel at right angles to the water.
		TownRiver east = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(1, 1), E)));
		TownRiver north = TownRiver.of(town(3, 3), flowing(java.util.Map.of(new Cell(1, 1), N)));
		assertEquals(new Pt(2.0, 1.5), east.chords().get(new Cell(1, 1)).to(), "E is +x");
		assertEquals(new Pt(1.5, 1.0), north.chords().get(new Cell(1, 1)).to(), "N is -y");
	}
}
