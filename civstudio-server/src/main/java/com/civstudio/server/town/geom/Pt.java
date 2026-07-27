package com.civstudio.server.town.geom;

/**
 * A point (or a vector — the distinction is contextual) in <b>plot space</b>, where one plot is
 * 1.0 and {@code x}/{@code y} run in the same direction as the plot raster the client speaks.
 * <p>
 * A record, so equality is by value and a point can key a map — which the outline walker relies on
 * to chain edges into loops. Note that {@code y} grows <em>downward</em> (raster convention), so
 * "left" and "counter-clockwise" here read mirrored from a maths textbook; the code never depends
 * on which way is visually clockwise, only that the choice is consistent, and {@link
 * Poly#signedArea()} is the single place that convention is pinned.
 *
 * @param x the x coordinate, in plots
 * @param y the y coordinate, in plots
 */
public record Pt(double x, double y) {

	/** The origin. */
	public static final Pt ZERO = new Pt(0, 0);

	/** This point translated by {@code o}. */
	public Pt plus(Pt o) {
		return new Pt(x + o.x, y + o.y);
	}

	/** The vector from {@code o} to this point. */
	public Pt minus(Pt o) {
		return new Pt(x - o.x, y - o.y);
	}

	/** This vector scaled by {@code k}. */
	public Pt scale(double k) {
		return new Pt(x * k, y * k);
	}

	/** The midpoint of this point and {@code o}. */
	public Pt mid(Pt o) {
		return new Pt((x + o.x) / 2, (y + o.y) / 2);
	}

	/** Linear interpolation: {@code t = 0} is this point, {@code t = 1} is {@code o}. */
	public Pt lerp(Pt o, double t) {
		return new Pt(x + (o.x - x) * t, y + (o.y - y) * t);
	}

	/** The dot product with {@code o}. */
	public double dot(Pt o) {
		return x * o.x + y * o.y;
	}

	/** The 2D cross product (z of the 3D cross) with {@code o} — signed parallelogram area. */
	public double cross(Pt o) {
		return x * o.y - y * o.x;
	}

	/** This vector's length. */
	public double len() {
		return Math.hypot(x, y);
	}

	/** The squared distance to {@code o} — for comparisons, where the square root is waste. */
	public double dist2(Pt o) {
		double dx = x - o.x, dy = y - o.y;
		return dx * dx + dy * dy;
	}

	/** The distance to {@code o}. */
	public double dist(Pt o) {
		return Math.sqrt(dist2(o));
	}

	/**
	 * This vector normalised to unit length, or {@link #ZERO} if it has no length — callers that
	 * care about the degenerate case must test it, but nothing here will hand back a NaN.
	 */
	public Pt unit() {
		double l = len();
		return l == 0 ? ZERO : new Pt(x / l, y / l);
	}

	/** This vector turned a quarter turn, to {@code (-y, x)}. */
	public Pt perp() {
		return new Pt(-y, x);
	}

	/** The bearing of this vector, in radians, as {@link Math#atan2}. */
	public double angle() {
		return Math.atan2(y, x);
	}
}
