package com.civstudio.server.render;

import java.util.ArrayList;
import java.util.List;

import com.civstudio.server.town.Footprint;
import com.civstudio.server.town.TownMesh;
import com.civstudio.server.town.TownWall;
import com.civstudio.server.town.geom.Poly;
import com.civstudio.server.town.geom.Pt;

/**
 * A town layout on the wire — {@code docs/towngen-port.md} T7 (prototype).
 * <p>
 * Everything is in <b>plot-raster space</b>, the same {@code x}/{@code y} the plot feed and the
 * web's plot grid already speak, with fractional offsets inside a plot. So the client projects it
 * with the projector it already has and the layout survives realm crops, the homography and the 3D
 * drape without a second coordinate system (§3 Coordinates).
 * <p>
 * Points travel as {@code [x, y]} pairs rather than as objects: a 30-plot town is a few hundred
 * points and naming each coordinate would triple the payload for nothing.
 *
 * @param province the site — a layout is keyed by <b>site</b>, not by colony, because it outlives
 *                 the settlement that raised it (§2a)
 * @param colony   the settlement standing there, or {@code null} for a ruin
 * @param walled   whether the town is fortified at all (§5.3: permanent settlements, ≥4 plots)
 * @param outline  the town's boundary, closed, in canonical order
 * @param holes    enclosed water — bays and lakes the town built around (§7a)
 * @param patches  one ward-shaped patch per plot (the mesh, §4)
 * @param wall     the fortified plot edges, each typed by what lies beyond it (T4)
 * @param gates    the ways through the line, and what each faces
 */
public record TownView(int province, String colony, boolean walled, double[][] outline,
		List<double[][]> holes, List<TownView.PatchView> patches, List<TownView.WallView> wall,
		List<TownView.GateView> gates) {

	/**
	 * One plot's patch.
	 *
	 * @param x      the plot's raster x
	 * @param y      the plot's raster y
	 * @param walled whether it stands inside the wall ({@code false} for a suburb — §2b)
	 * @param poly   the patch outline
	 */
	public record PatchView(int x, int y, boolean walled, double[][] poly) {
	}

	/**
	 * One fortified plot edge.
	 *
	 * @param x    the plot's raster x
	 * @param y    the plot's raster y
	 * @param side which edge of that plot ({@code N}/{@code E}/{@code S}/{@code W})
	 * @param kind what stands here ({@code CURTAIN}/{@code QUAY}/{@code ROAD_GATE}/{@code RIVER_GATE})
	 * @param line the segment, as two points
	 */
	public record WallView(int x, int y, String side, String kind, double[][] line) {
	}

	/**
	 * One gate.
	 *
	 * @param x      the gate plot's raster x
	 * @param y      the gate plot's raster y
	 * @param toward what lies through it — a neighbouring province's name
	 * @param at     the gate's midpoint, where a street meets the line
	 */
	public record GateView(int x, int y, String toward, double[] at) {
	}

	/** An empty layout — a site with no town on it. */
	public static TownView empty(int province) {
		return new TownView(province, null, false, new double[0][], List.of(), List.of(), List.of(),
				List.of());
	}

	/**
	 * Project a computed layout for the wire.
	 *
	 * @param province  the site
	 * @param colony    the settlement's name, or {@code null}
	 * @param footprint its footprint
	 * @param mesh      its mesh
	 * @param wall      its fortification
	 * @return the wire projection
	 */
	public static TownView of(int province, String colony, Footprint footprint, TownMesh mesh,
			TownWall wall) {
		List<double[][]> holes = new ArrayList<>(footprint.waterHoles().size());
		for (Poly hole : footprint.waterHoles()) {
			holes.add(points(hole));
		}
		List<PatchView> patches = new ArrayList<>(mesh.patches().size());
		for (TownMesh.Patch p : mesh.patches()) {
			patches.add(new PatchView(p.cell().x(), p.cell().y(), p.walled(), points(p.poly())));
		}
		List<WallView> segments = new ArrayList<>(wall.segments().size());
		for (TownWall.Segment s : wall.segments()) {
			segments.add(new WallView(s.cell().x(), s.cell().y(), s.side().name(), s.kind().name(),
					new double[][] {{s.a().x(), s.a().y()}, {s.b().x(), s.b().y()}}));
		}
		List<GateView> gates = new ArrayList<>(wall.gates().size());
		for (TownWall.Gate g : wall.gates()) {
			Pt at = g.segment().mid();
			gates.add(new GateView(g.segment().cell().x(), g.segment().cell().y(), g.toward(),
					new double[] {at.x(), at.y()}));
		}
		return new TownView(province, colony, wall.walled(), points(footprint.outer()), holes,
				patches, segments, gates);
	}

	private static double[][] points(Poly poly) {
		double[][] out = new double[poly.size()][];
		for (int i = 0; i < poly.size(); i++) {
			out[i] = new double[] {poly.get(i).x(), poly.get(i).y()};
		}
		return out;
	}
}
