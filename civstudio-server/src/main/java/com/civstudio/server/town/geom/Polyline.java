package com.civstudio.server.town.geom;

import java.util.ArrayList;
import java.util.List;

/**
 * <b>Open</b> polylines — the shape a street is, which {@link Poly} deliberately is not.
 * <p>
 * {@code Poly} is a closed ring: it has an area, an orientation and a centroid, and every operation
 * on it assumes the last vertex joins the first. A street has none of that. It has two ends that
 * matter, and the whole question about it is how it bends between them, so it gets its own type
 * rather than a closed polygon pretending.
 * <p>
 * <b>Chaikin, not a spline.</b> Smoothing here is corner-cutting: replace each vertex with two
 * points a quarter of the way along its adjoining segments, twice. It converges on a quadratic
 * B-spline, it can never overshoot (every output point is a convex combination of two input points,
 * so the curve stays inside the original polyline's hull), and it is four lines of code. A street
 * that overshoots is a street through a building, which is the one failure mode that would be
 * expensive to discover on screen.
 * <p>
 * <b>Pinned vertices are why the smoothing is not simply Chaikin.</b> A street network is a tree:
 * branches end <em>on</em> another street, and if smoothing moves that street's vertex the branch
 * detaches by up to a quarter of a plot — a visible gap at every junction. So a vertex can be
 * pinned, and the polyline is smoothed in runs between pins, each run keeping its own ends fixed.
 * The junction is then a point both streets share exactly, before and after.
 */
public final class Polyline {

	private Polyline() {
	}

	/**
	 * How far along each segment a corner is cut. The classic Chaikin quarter — smaller barely
	 * rounds, larger starts to shorten the line visibly at its bends.
	 */
	public static final double CHAIKIN_CUT = 0.25;

	/**
	 * Smooth a polyline by corner-cutting, keeping its two ends exactly where they were.
	 *
	 * @param points     the vertices, in order
	 * @param iterations how many corner-cutting passes; {@code <= 0} returns the input unchanged
	 * @return the smoothed polyline
	 */
	public static List<Pt> smooth(List<Pt> points, int iterations) {
		return smooth(points, null, iterations);
	}

	/**
	 * Smooth a polyline, keeping its ends and every pinned vertex exactly where they were.
	 * <p>
	 * Pinned interior vertices split the line into runs, each smoothed with its own ends fixed, so a
	 * junction survives smoothing as the same point on both streets that meet there.
	 *
	 * @param points     the vertices, in order
	 * @param pinned     which vertices must not move — {@code null}, shorter or longer than
	 *                   {@code points} is fine, and out-of-range entries are ignored; the two ends
	 *                   are always pinned whatever this says
	 * @param iterations how many corner-cutting passes; {@code <= 0} returns the input unchanged
	 * @return the smoothed polyline
	 */
	public static List<Pt> smooth(List<Pt> points, boolean[] pinned, int iterations) {
		if (points == null || points.size() < 3 || iterations <= 0) {
			return points == null ? List.of() : List.copyOf(points);
		}
		List<Integer> pins = new ArrayList<>();
		pins.add(0);
		for (int i = 1; i + 1 < points.size(); i++) {
			if (pinned != null && i < pinned.length && pinned[i]) {
				pins.add(i);
			}
		}
		pins.add(points.size() - 1);

		List<Pt> out = new ArrayList<>();
		for (int r = 0; r + 1 < pins.size(); r++) {
			List<Pt> run = chaikin(points.subList(pins.get(r), pins.get(r + 1) + 1), iterations);
			// each run starts where the previous ended: append from 1 after the first run, or the
			// junction point would appear twice and a zero-length segment would sit in the middle
			out.addAll(r == 0 ? run : run.subList(1, run.size()));
		}
		return List.copyOf(out);
	}

	/**
	 * The total length of a polyline.
	 *
	 * @param points the vertices, in order
	 * @return the summed segment lengths, or {@code 0} for fewer than two points
	 */
	public static double length(List<Pt> points) {
		if (points == null || points.size() < 2) {
			return 0;
		}
		double len = 0;
		for (int i = 0; i + 1 < points.size(); i++) {
			len += points.get(i).dist(points.get(i + 1));
		}
		return len;
	}

	/** One Chaikin pass per iteration, with both ends held. */
	private static List<Pt> chaikin(List<Pt> points, int iterations) {
		List<Pt> cur = new ArrayList<>(points);
		for (int pass = 0; pass < iterations && cur.size() >= 3; pass++) {
			List<Pt> next = new ArrayList<>(cur.size() * 2);
			next.add(cur.get(0));
			for (int i = 0; i + 1 < cur.size(); i++) {
				Pt a = cur.get(i);
				Pt b = cur.get(i + 1);
				next.add(a.lerp(b, CHAIKIN_CUT));
				next.add(a.lerp(b, 1 - CHAIKIN_CUT));
			}
			next.add(cur.get(cur.size() - 1));
			cur = next;
		}
		return cur;
	}
}
