package com.civstudio.server.render;

import java.util.ArrayList;
import java.util.List;

import com.civstudio.server.town.Footprint;
import com.civstudio.server.town.TownLots;
import com.civstudio.server.town.TownMesh;
import com.civstudio.server.town.TownStreets;
import com.civstudio.server.town.TownWall;
import com.civstudio.server.town.TownWards;
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
 * @param streets  the street network, gates inward, as a tree rooted at the centre (T5)
 */
public record TownView(int province, String colony, boolean walled, double[][] outline,
		List<double[][]> holes, List<TownView.PatchView> patches, List<TownView.WallView> wall,
		List<TownView.GateView> gates, List<TownView.StreetView> streets) {

	/**
	 * One plot's patch, and what stands on it.
	 *
	 * @param x      the plot's raster x
	 * @param y      the plot's raster y
	 * @param walled whether it stands inside the wall ({@code false} for a suburb — §2b)
	 * @param ward   its {@code DistrictType} — the plot's own district, not a second vocabulary
	 *               (T6, §4): where the sim has built, this is the fold of the buildings' categories
	 * @param poly   the patch outline
	 * @param lots   the blocks within it, biggest first — buildings, then dwellings, then yard
	 */
	public record PatchView(int x, int y, boolean walled, String ward, double[][] poly,
			List<TownView.LotView> lots) {
	}

	/**
	 * One lot within a patch.
	 *
	 * @param kind     {@code BUILDING}, {@code DWELLING}, {@code EMPTY} or {@code RUIN}
	 * @param building the {@code BUILDING_*} id standing here, or {@code null} — the client joins it
	 *                 against the building catalog for a name and its C2C button icon
	 * @param poly     the lot outline
	 */
	public record LotView(String kind, String building, double[][] poly) {
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

	/**
	 * One street, already smoothed.
	 *
	 * @param kind    {@code MAIN} for an artery reaching the centre, {@code STREET} for a branch
	 *                ending on another street
	 * @param toward  what lies out through its outer end, or {@code null}
	 * @param bridges how many river crossings it makes
	 * @param line    the polyline, outer end first
	 */
	public record StreetView(String kind, String toward, int bridges, double[][] line) {
	}

	/** An empty layout — a site with no town on it. */
	public static TownView empty(int province) {
		return new TownView(province, null, false, new double[0][], List.of(), List.of(), List.of(),
				List.of(), List.of());
	}

	/**
	 * Project a computed layout for the wire.
	 *
	 * @param province  the site
	 * @param colony    the settlement's name, or {@code null}
	 * @param footprint its footprint
	 * @param mesh      its mesh
	 * @param wall      its fortification
	 * @param streets   its streets
	 * @param wards     what each patch is
	 * @param lots      the blocks within each patch
	 * @return the wire projection
	 */
	public static TownView of(int province, String colony, Footprint footprint, TownMesh mesh,
			TownWall wall, TownStreets streets, TownWards wards, TownLots lots) {
		List<double[][]> holes = new ArrayList<>(footprint.waterHoles().size());
		for (Poly hole : footprint.waterHoles()) {
			holes.add(points(hole));
		}
		List<PatchView> patches = new ArrayList<>(mesh.patches().size());
		for (TownMesh.Patch p : mesh.patches()) {
			com.civstudio.settlement.DistrictType ward = wards.of(p.cell());
			List<LotView> blocks = new ArrayList<>();
			for (TownLots.Lot lot : lots.of(p.cell())) {
				blocks.add(new LotView(lot.kind().name(), lot.building(), points(lot.poly())));
			}
			patches.add(new PatchView(p.cell().x(), p.cell().y(), p.walled(),
					ward == null ? null : ward.name(), points(p.poly()), blocks));
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
		List<StreetView> lines = new ArrayList<>(streets.streets().size());
		for (TownStreets.Street s : streets.streets()) {
			lines.add(new StreetView(s.kind().name(), s.toward(), s.bridges(), points(s.points())));
		}
		return new TownView(province, colony, wall.walled(), points(footprint.outer()), holes,
				patches, segments, gates, lines);
	}

	private static double[][] points(List<Pt> pts) {
		double[][] out = new double[pts.size()][];
		for (int i = 0; i < pts.size(); i++) {
			out[i] = new double[] {pts.get(i).x(), pts.get(i).y()};
		}
		return out;
	}

	private static double[][] points(Poly poly) {
		double[][] out = new double[poly.size()][];
		for (int i = 0; i < poly.size(); i++) {
			out[i] = new double[] {poly.get(i).x(), poly.get(i).y()};
		}
		return out;
	}
}
