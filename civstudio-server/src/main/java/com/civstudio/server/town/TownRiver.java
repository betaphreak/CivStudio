package com.civstudio.server.town;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.server.town.geom.Poly;
import com.civstudio.server.town.geom.Pt;
import com.civstudio.server.town.geom.TownScale;

/**
 * The <b>river through town</b> — {@code docs/towngen-port.md} T4b, the expensive half of §7a.
 * <p>
 * <b>Coastlines are edge-based; rivers are cell-based, and that is the whole reason this is a
 * separate phase.</b> {@code Plot.coast()} is a bitmask of which of a plot's <em>edges</em> face
 * water, so a shoreline lies on patch boundaries and T4 could type it as quay for free. A river
 * comes from EU4's {@code rivers.bmp} and runs through plot <em>centres</em>, chaining cell to cell
 * — so it cuts <em>through</em> a patch, and no amount of edge classification will move it out of
 * the way. Lots have to be kept out of the channel, or a town on a river builds houses in it.
 * <p>
 * <b>What this does NOT do, and the §8b decision that goes with it.</b> The plan expected T4b to
 * port {@code web/js/river-geom.mjs}' decode to Java and then face a choice: make Java authoritative
 * and serve the polyline, or knowingly keep two decoders that can drift. Neither is needed.
 * <ul>
 * <li><b>The decode is already engine-side.</b> {@code river-geom.mjs} unpacks a plot's packed river
 *     code because the <em>client</em> receives packed codes in the plot feed. The server holds
 *     {@code Plot} objects that already carry {@code river()}, {@code riverAdj()} and {@code
 *     riverClass()} as fields. There is nothing to port.</li>
 * <li><b>Only the centre-line construction is shared, and the town never draws it.</b> The river
 *     ribbon is drawn once, by the client, for every province on the map. This class uses the same
 *     construction internally — to hold lots off the channel and to place bridges — and emits no
 *     ribbon of its own. So the drift §8b feared (two renderings disagreeing by a pixel, in public)
 *     cannot arise: there is only ever one river drawn, and the town's use of the geometry shows up
 *     as an <em>absence</em> of houses rather than as a second line that could be wrong.</li>
 * </ul>
 * <b>The chord, and where it is an approximation.</b> A cell's channel runs from its centre out to
 * the shared edge with each linked neighbour. A straight run (two opposite links) is exactly a chord
 * between two edge midpoints. A bend curves through the centre, and this takes the straight chord
 * between its two edge midpoints instead — which cuts the corner by up to a quarter of a plot and is
 * accepted: the consequence is a few lots nearer the inside of a bend than the water really allows,
 * at a scale where a lot is symbolic anyway (§3). A confluence — three or four links — is not
 * approximated at all: the cell is mostly water and gets no lots.
 *
 * @param chords the channel's chord through each river plot of the town
 * @param diag   what the river did to the town, for the caller to log
 */
public record TownRiver(Map<Cell, Chord> chords, Diagnostics diag) {

	/** A town with no river in it. */
	public static final TownRiver NONE = new TownRiver(Map.of(), new Diagnostics(0, 0));

	/**
	 * How much ground the channel takes on <b>each</b> side of its centre-line — the bank buffer, so
	 * lots stand back from the water rather than against it. A fraction of a plot, like everything
	 * else here; the widest river class fills about half a plot, and this is the margin outside it.
	 */
	public static final double BANK = 0.22 * TownScale.PLOT;

	/** How many links make a cell a confluence rather than a reach: three or more, so it is all water. */
	public static final int CONFLUENCE_LINKS = 3;

	/**
	 * The offsets of the engine's river-adjacency mask, in its bit order ({@code 1}=E, {@code 2}=W,
	 * {@code 4}=S, {@code 8}=N) — the same order {@link TownWall.Side} uses, and the same order
	 * {@code river-geom.mjs NB4} uses on the client.
	 */
	private static final int[][] NB4 = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};

	/**
	 * The channel's chord through one plot: a straight line the banks are measured from.
	 *
	 * @param cell       the plot
	 * @param from       one end, on the plot's boundary or at its centre
	 * @param to         the other end
	 * @param confluence whether this plot is all water — three or more links, so nothing stands here
	 */
	public record Chord(Cell cell, Pt from, Pt to, boolean confluence) {

		/** The unit direction along the channel, or {@code null} for a chord with no length. */
		public Pt direction() {
			Pt d = to.minus(from);
			return d.len() == 0 ? null : d.unit();
		}
	}

	/**
	 * What the river did.
	 *
	 * @param reaches     how many plots the channel runs through
	 * @param confluences how many of those are all water
	 */
	public record Diagnostics(int reaches, int confluences) {

		/** Whether this is worth a log line. */
		public boolean interesting() {
			return reaches > 0;
		}

		@Override
		public String toString() {
			return reaches == 0 ? "no river"
					: reaches + " river plots"
							+ (confluences > 0 ? ", " + confluences + " confluence(s)" : "");
		}
	}

	/**
	 * What the plots say about the water on them. The engine adapter reads it off {@code Plot};
	 * tests supply it directly, and a dry town needs neither method.
	 */
	public interface Water {

		/** Whether a river runs through this plot at all. */
		default boolean river(Cell cell) {
			return false;
		}

		/**
		 * Which orthogonal neighbours the river runs on to, as the engine's {@code riverAdj} mask
		 * ({@code 1}=E, {@code 2}=W, {@code 4}=S, {@code 8}=N).
		 */
		default int links(Cell cell) {
			return 0;
		}
	}

	/**
	 * Trace a town's river.
	 *
	 * @param footprint the town's plots
	 * @param water     what the plots say
	 * @return the channel, or {@link #NONE} for a town with no river in it
	 */
	public static TownRiver of(Footprint footprint, Water water) {
		if (footprint == null || footprint.isEmpty() || water == null) {
			return NONE;
		}
		Map<Cell, Chord> out = new LinkedHashMap<>();
		int confluences = 0;
		for (Cell c : footprint.allCells()) {
			if (!water.river(c)) {
				continue;
			}
			List<Integer> links = linksOf(water.links(c));
			if (links.size() >= CONFLUENCE_LINKS) {
				out.put(c, new Chord(c, c.centre(), c.centre(), true));
				confluences++;
				continue;
			}
			Pt centre = c.centre();
			if (links.isEmpty()) {
				continue;                           // river on the plot but going nowhere: no channel
			}
			Pt a = links.size() == 2 ? edge(c, links.get(0)) : centre;
			Pt b = edge(c, links.get(links.size() - 1));
			out.put(c, new Chord(c, a, b, false));
		}
		return out.isEmpty() ? NONE
				: new TownRiver(Map.copyOf(out), new Diagnostics(out.size(), confluences));
	}

	/** Whether nothing may be built on this plot at all — a confluence is all water. */
	public boolean isChannel(Cell cell) {
		Chord ch = chords.get(cell);
		return ch != null && ch.confluence();
	}

	/** Whether the channel runs through this plot. */
	public boolean runsThrough(Cell cell) {
		return chords.containsKey(cell);
	}

	/** Whether the town has a river at all. */
	public boolean isEmpty() {
		return chords.isEmpty();
	}

	/**
	 * The buildable ground of one plot: its block, minus the channel and its banks.
	 * <p>
	 * A dry plot comes back as itself. A plot the channel crosses comes back as its <b>two banks</b>
	 * — the block clipped to each side of the chord, offset by {@link #BANK} — so a town on a river
	 * builds on both sides of it instead of forfeiting the smaller half. A bank the channel has eaten
	 * comes back absent rather than as a sliver. A confluence comes back empty.
	 *
	 * @param cell  the plot
	 * @param block the ground it would otherwise offer
	 * @return one polygon for dry ground, up to two for a river plot, none for a confluence
	 */
	public List<Poly> banks(Cell cell, Poly block) {
		Chord ch = chords.get(cell);
		if (block == null || block.isEmpty()) {
			return List.of();
		}
		if (ch == null) {
			return List.of(block);
		}
		if (ch.confluence()) {
			return List.of();
		}
		Pt dir = ch.direction();
		if (dir == null) {
			return List.of(block);
		}
		Pt normal = dir.perp();
		List<Poly> out = new ArrayList<>(2);
		Poly left = block.clipHalfPlane(ch.from().plus(normal.scale(BANK)), normal);
		Poly right = block.clipHalfPlane(ch.from().minus(normal.scale(BANK)), normal.scale(-1));
		if (usable(left)) {
			out.add(left);
		}
		if (usable(right)) {
			out.add(right);
		}
		return List.copyOf(out);
	}

	/** A bank narrower than this is the channel's edge, not a place to build. */
	private static boolean usable(Poly bank) {
		return !bank.isEmpty() && bank.area() > TownScale.MIN_BLOCK_AREA;
	}

	/** The NB4 indices set in an adjacency mask. */
	private static List<Integer> linksOf(int mask) {
		List<Integer> out = new ArrayList<>(4);
		for (int i = 0; i < 4; i++) {
			if ((mask & (1 << i)) != 0) {
				out.add(i);
			}
		}
		return out;
	}

	/** The midpoint of the edge a link crosses. */
	private static Pt edge(Cell c, int link) {
		return new Pt(c.centre().x() + NB4[link][0] * 0.5, c.centre().y() + NB4[link][1] * 0.5);
	}
}
