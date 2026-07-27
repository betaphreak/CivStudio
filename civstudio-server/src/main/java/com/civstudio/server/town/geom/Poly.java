package com.civstudio.server.town.geom;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * A simple polygon — the workhorse of the town generator ({@code docs/towngen-port.md} §8, "the
 * workhorse everything else calls"). Immutable: every operation returns a new polygon.
 * <p>
 * <b>Orientation.</b> The signed area pins the convention, and it is the only place it is pinned:
 * a polygon with <b>positive</b> {@link #signedArea()} is in <em>canonical</em> order, and for an
 * edge {@code p[i] → p[i+1]} of a canonical polygon the <b>inward</b> normal is that edge's
 * direction turned by {@link Pt#perp()}. Because {@code y} grows downward in plot-raster space,
 * canonical order draws clockwise on screen — which matters not at all, as long as nothing assumes
 * otherwise. {@link #canonical()} normalises any polygon into it, and every operation that needs a
 * side (inset, clipping to self, containment) calls it first rather than trusting the caller.
 * <p>
 * <b>Degeneracy is allowed, not thrown.</b> Clipping can empty a polygon and inset can collapse
 * one; both return a polygon with fewer than three vertices, which {@link #isEmpty()} reports.
 * Nothing in this package throws on degenerate geometry — §5 of the plan is precisely about a
 * reference generator that escapes bad shapes by regenerating, an escape we do not have because
 * our shape is fixed by sim state.
 */
public final class Poly {

	/** The empty polygon — what a clip that removed everything returns. */
	public static final Poly EMPTY = new Poly(List.of());

	private final List<Pt> pts;

	/**
	 * A polygon over the given vertices, in order. The list is copied, so the polygon is immutable
	 * however the caller goes on to treat its own list.
	 *
	 * @param pts the vertices, in order; may be fewer than three (see {@link #isEmpty()})
	 */
	public Poly(List<Pt> pts) {
		this.pts = List.copyOf(pts);
	}

	/** A polygon over the given vertices, in order. */
	public static Poly of(Pt... pts) {
		return new Poly(Arrays.asList(pts));
	}

	/** The axis-aligned rectangle with corners {@code (x, y)} and {@code (x + w, y + h)}. */
	public static Poly rect(double x, double y, double w, double h) {
		return of(new Pt(x, y), new Pt(x + w, y), new Pt(x + w, y + h), new Pt(x, y + h));
	}

	/** The axis-aligned square of side {@code side} centred on {@code c}. */
	public static Poly square(Pt c, double side) {
		return rect(c.x() - side / 2, c.y() - side / 2, side, side);
	}

	/** The vertices, in order. Immutable. */
	public List<Pt> points() {
		return pts;
	}

	/** The vertex count. */
	public int size() {
		return pts.size();
	}

	/** Vertex {@code i}, wrapping — so {@code get(size())} is the first vertex again. */
	public Pt get(int i) {
		return pts.get(Math.floorMod(i, pts.size()));
	}

	/** Whether this polygon encloses nothing — fewer than three vertices, or zero area. */
	public boolean isEmpty() {
		return pts.size() < 3 || area() <= 1e-12;
	}

	/**
	 * The shoelace signed area: positive in canonical order (see the class note), negative when
	 * reversed. The sign is the orientation test the rest of the package uses.
	 */
	public double signedArea() {
		if (pts.size() < 3) {
			return 0;
		}
		double s = 0;
		for (int i = 0; i < pts.size(); i++) {
			Pt a = get(i), b = get(i + 1);
			s += a.x() * b.y() - b.x() * a.y();
		}
		return s / 2;
	}

	/** The (unsigned) area. */
	public double area() {
		return Math.abs(signedArea());
	}

	/** The perimeter length. */
	public double perimeter() {
		if (pts.size() < 2) {
			return 0;
		}
		double s = 0;
		for (int i = 0; i < pts.size(); i++) {
			s += get(i).dist(get(i + 1));
		}
		return s;
	}

	/**
	 * The area centroid — the centre of mass of the enclosed region, <b>not</b> the mean of the
	 * vertices. Lloyd relaxation converges to this point and nothing else, so getting it wrong
	 * would quietly bias every mesh; a degenerate polygon falls back to the vertex mean, which is
	 * the best available answer when there is no area to weight by.
	 */
	public Pt centroid() {
		double a2 = signedArea() * 2;
		if (pts.isEmpty()) {
			return Pt.ZERO;
		}
		if (Math.abs(a2) < 1e-12) {
			double sx = 0, sy = 0;
			for (Pt p : pts) {
				sx += p.x();
				sy += p.y();
			}
			return new Pt(sx / pts.size(), sy / pts.size());
		}
		double cx = 0, cy = 0;
		for (int i = 0; i < pts.size(); i++) {
			Pt a = get(i), b = get(i + 1);
			double f = a.x() * b.y() - b.x() * a.y();
			cx += (a.x() + b.x()) * f;
			cy += (a.y() + b.y()) * f;
		}
		return new Pt(cx / (3 * a2), cy / (3 * a2));
	}

	/** This polygon in canonical (positive signed area) order — itself, or itself reversed. */
	public Poly canonical() {
		if (signedArea() >= 0) {
			return this;
		}
		List<Pt> r = new ArrayList<>(pts);
		Collections.reverse(r);
		return new Poly(r);
	}

	/** This polygon with its vertex order reversed. */
	public Poly reversed() {
		List<Pt> r = new ArrayList<>(pts);
		Collections.reverse(r);
		return new Poly(r);
	}

	/** The direction of edge {@code i}, from vertex {@code i} to vertex {@code i + 1}. */
	public Pt edgeVec(int i) {
		return get(i + 1).minus(get(i));
	}

	/** The midpoint of edge {@code i}. */
	public Pt edgeMid(int i) {
		return get(i).mid(get(i + 1));
	}

	/** The length of edge {@code i}. */
	public double edgeLen(int i) {
		return edgeVec(i).len();
	}

	/** The index of the longest edge, or {@code -1} for a polygon with no edges. */
	public int longestEdge() {
		int best = -1;
		double bl = -1;
		for (int i = 0; i < pts.size(); i++) {
			double l = edgeLen(i);
			if (l > bl) {
				bl = l;
				best = i;
			}
		}
		return best;
	}

	/** The axis-aligned bounding box. */
	public Box bbox() {
		if (pts.isEmpty()) {
			return new Box(0, 0, 0, 0);
		}
		double x0 = Double.MAX_VALUE, y0 = Double.MAX_VALUE;
		double x1 = -Double.MAX_VALUE, y1 = -Double.MAX_VALUE;
		for (Pt p : pts) {
			x0 = Math.min(x0, p.x());
			y0 = Math.min(y0, p.y());
			x1 = Math.max(x1, p.x());
			y1 = Math.max(y1, p.y());
		}
		return new Box(x0, y0, x1, y1);
	}

	/**
	 * Whether {@code p} lies inside, by crossing count. Points exactly on an edge are unspecified
	 * — deliberately: no caller in this package asks about the boundary, and pretending to a
	 * precision floating point cannot deliver would be worse than saying so.
	 */
	public boolean contains(Pt p) {
		boolean in = false;
		for (int i = 0; i < pts.size(); i++) {
			Pt a = get(i), b = get(i + 1);
			if ((a.y() > p.y()) != (b.y() > p.y())) {
				double t = (p.y() - a.y()) / (b.y() - a.y());
				if (p.x() < a.x() + t * (b.x() - a.x())) {
					in = !in;
				}
			}
		}
		return in;
	}

	/** Whether every turn goes the same way — i.e. the polygon is convex. */
	public boolean isConvex() {
		if (pts.size() < 3) {
			return false;
		}
		int sign = 0;
		for (int i = 0; i < pts.size(); i++) {
			double c = edgeVec(i).cross(edgeVec(i + 1));
			if (Math.abs(c) < 1e-12) {
				continue;
			}
			int s = c > 0 ? 1 : -1;
			if (sign == 0) {
				sign = s;
			} else if (s != sign) {
				return false;
			}
		}
		return true;
	}

	/**
	 * This polygon clipped to a half-plane (Sutherland–Hodgman): the part on the {@code inward}
	 * side of the line through {@code through}. Exact for a convex subject, which is all this
	 * package clips — Voronoi cells and blocks are convex by construction.
	 *
	 * @param through any point on the cutting line
	 * @param inward  the normal pointing at the half to keep (need not be unit length)
	 * @return the clipped polygon, possibly {@link #EMPTY}
	 */
	public Poly clipHalfPlane(Pt through, Pt inward) {
		if (pts.isEmpty()) {
			return EMPTY;
		}
		List<Pt> out = new ArrayList<>(pts.size() + 2);
		for (int i = 0; i < pts.size(); i++) {
			Pt a = get(i), b = get(i + 1);
			double da = b_dist(a, through, inward), db = b_dist(b, through, inward);
			if (da >= 0) {
				out.add(a);
			}
			if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
				out.add(a.lerp(b, da / (da - db)));
			}
		}
		return out.size() < 3 ? EMPTY : new Poly(out);
	}

	private static double b_dist(Pt p, Pt through, Pt inward) {
		return p.minus(through).dot(inward);
	}

	/**
	 * This polygon clipped to a <b>convex</b> polygon, by clipping against each of its edges in
	 * turn. The clip window must be convex; the subject need not be for the common cases here, but
	 * a concave subject may produce a degenerate bridge edge — Sutherland–Hodgman's known
	 * limitation, and the reason the footprint (concave, and possibly holed) is clipped per grid
	 * square rather than as one polygon.
	 *
	 * @param window the convex clip polygon
	 * @return the intersection, possibly {@link #EMPTY}
	 */
	public Poly clipConvex(Poly window) {
		Poly w = window.canonical();
		Poly out = this;
		for (int i = 0; i < w.size() && !out.isEmpty(); i++) {
			out = out.clipHalfPlane(w.get(i), w.edgeVec(i).perp());
		}
		return out;
	}

	/**
	 * This polygon with every edge moved inward by {@code d} (outward for a negative {@code d}),
	 * new vertices being the intersections of consecutive moved edge lines.
	 * <p>
	 * A large inset can self-intersect or turn inside out — this does not detect that, by design: a
	 * general-purpose straight-skeleton offset is an order of magnitude more machinery than the
	 * plan needs.
	 * <p>
	 * <b>Checking the result is the caller's job, and neither area nor orientation will tell them.</b>
	 * Inset a unit square by 0.6 and the opposite edge lines cross, but the four new corners are
	 * still traversed the same way round: the result is a healthy-looking 0.2 square with positive
	 * area, entirely wrong. The test that works is {@link #distanceToBoundary(Pt)} — a valid uniform
	 * inset leaves every new vertex at least {@code d} from the original boundary. {@link
	 * Cutter#ring} is the worked example.
	 */
	public Poly inset(double d) {
		double[] all = new double[pts.size()];
		Arrays.fill(all, d);
		return inset(all);
	}

	/**
	 * This polygon with edge {@code i} moved inward by {@code d[i]} — the per-edge inset the ward
	 * cutters need (a block set back from a main street on one side and an alley on another).
	 *
	 * @param d one distance per edge, in polygon order
	 * @return the inset polygon, possibly degenerate
	 */
	public Poly inset(double[] d) {
		if (pts.size() < 3) {
			return this;
		}
		Poly c = canonical();
		int n = c.size();
		List<Pt> out = new ArrayList<>(n);
		for (int i = 0; i < n; i++) {
			int prev = Math.floorMod(i - 1, n);
			Pt dp = c.edgeVec(prev), di = c.edgeVec(i);
			Pt ap = c.get(prev).plus(dp.perp().unit().scale(d[prev]));
			Pt ai = c.get(i).plus(di.perp().unit().scale(d[i]));
			Pt x = lineIntersect(ap, dp, ai, di);
			out.add(x == null ? ai : x);
		}
		return new Poly(out);
	}

	/**
	 * Cut by an infinite line, leaving a gap of {@code gap} between the pieces — the street the cut
	 * stands for. Pieces that clip away to nothing are dropped, so a line that misses returns the
	 * polygon unchanged as a single piece.
	 *
	 * @param through a point on the cutting line
	 * @param dir     the line's direction (need not be unit length)
	 * @param gap     the total width removed along the cut
	 * @return one or two pieces
	 */
	public List<Poly> cut(Pt through, Pt dir, double gap) {
		Pt n = dir.perp().unit();
		if (n.equals(Pt.ZERO)) {
			return List.of(this);
		}
		Pt a = through.plus(n.scale(gap / 2));
		Pt b = through.plus(n.scale(-gap / 2));
		List<Poly> out = new ArrayList<>(2);
		Poly left = clipHalfPlane(a, n);
		Poly right = clipHalfPlane(b, n.scale(-1));
		if (!left.isEmpty()) {
			out.add(left);
		}
		if (!right.isEmpty()) {
			out.add(right);
		}
		return out.isEmpty() ? List.of(this) : out;
	}

	/**
	 * The distance from {@code p} to the nearest point of the boundary — measured to the edge
	 * <b>segments</b>, not their infinite lines, so it is meaningful for a concave polygon too.
	 * Zero-length edges contribute their endpoint. Note this is the distance to the outline
	 * whether {@code p} is inside or out; {@link #contains(Pt)} answers which.
	 */
	public double distanceToBoundary(Pt p) {
		double best = Double.MAX_VALUE;
		for (int i = 0; i < pts.size(); i++) {
			Pt a = get(i), b = get(i + 1);
			Pt ab = b.minus(a);
			double l2 = ab.dot(ab);
			double t = l2 <= 0 ? 0 : Math.max(0, Math.min(1, p.minus(a).dot(ab) / l2));
			best = Math.min(best, p.dist(a.plus(ab.scale(t))));
		}
		return best == Double.MAX_VALUE ? 0 : best;
	}

	/**
	 * Isoperimetric compactness, {@code 4πA / P²}: 1.0 for a circle, ~0.79 for a square, tending to
	 * 0 for a sliver. The ward cutters use it to reject blocks too thin to build on — the shape
	 * quality measure the reference generator spends most of its geometry budget defending.
	 */
	public double compactness() {
		double p = perimeter();
		return p <= 0 ? 0 : 4 * Math.PI * area() / (p * p);
	}

	/**
	 * A weighted average of the vertices — barycentric interpolation over the polygon's corners,
	 * used to place a point "mostly toward that corner" without caring where the corners are.
	 * Weights are normalised; all-zero weights give the vertex mean.
	 *
	 * @param weights one weight per vertex
	 * @return the interpolated point
	 */
	public Pt interpolate(double[] weights) {
		double sum = 0;
		for (double w : weights) {
			sum += w;
		}
		if (pts.isEmpty()) {
			return Pt.ZERO;
		}
		if (sum <= 0) {
			sum = pts.size();
			double sx = 0, sy = 0;
			for (Pt p : pts) {
				sx += p.x();
				sy += p.y();
			}
			return new Pt(sx / sum, sy / sum);
		}
		double x = 0, y = 0;
		for (int i = 0; i < pts.size() && i < weights.length; i++) {
			x += pts.get(i).x() * weights[i];
			y += pts.get(i).y() * weights[i];
		}
		return new Pt(x / sum, y / sum);
	}

	/**
	 * Where the lines {@code p + t·dp} and {@code q + s·dq} meet, or {@code null} when they are
	 * parallel.
	 */
	static Pt lineIntersect(Pt p, Pt dp, Pt q, Pt dq) {
		double den = dp.cross(dq);
		if (Math.abs(den) < 1e-12) {
			return null;
		}
		double t = q.minus(p).cross(dq) / den;
		return p.plus(dp.scale(t));
	}

	@Override
	public String toString() {
		return "Poly" + pts;
	}

	/**
	 * An axis-aligned bounding box.
	 *
	 * @param x0 the minimum x
	 * @param y0 the minimum y
	 * @param x1 the maximum x
	 * @param y1 the maximum y
	 */
	public record Box(double x0, double y0, double x1, double y1) {

		/** The box's width. */
		public double w() {
			return x1 - x0;
		}

		/** The box's height. */
		public double h() {
			return y1 - y0;
		}

		/** The box's centre. */
		public Pt centre() {
			return new Pt((x0 + x1) / 2, (y0 + y1) / 2);
		}

		/** This box as a polygon, in canonical order. */
		public Poly poly() {
			return rect(x0, y0, w(), h());
		}

		/** This box grown by {@code d} on every side. */
		public Box grow(double d) {
			return new Box(x0 - d, y0 - d, x1 + d, y1 + d);
		}
	}
}
