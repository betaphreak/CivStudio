package com.civstudio.server.web;

import java.util.ArrayList;
import java.util.List;

import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import com.civstudio.server.HostedSession;
import com.civstudio.server.SessionHost;
import com.civstudio.server.render.TownView;
import com.civstudio.server.town.ColonyFootprint;
import com.civstudio.server.town.ColonySite;
import com.civstudio.server.town.ColonyStreets;
import com.civstudio.server.town.ColonyWall;
import com.civstudio.server.town.Footprint;
import com.civstudio.server.town.TownLots;
import com.civstudio.server.town.TownMesh;
import com.civstudio.server.town.TownRiver;
import com.civstudio.server.town.TownRng;
import com.civstudio.server.town.TownStreets;
import com.civstudio.server.town.TownWall;
import com.civstudio.server.town.TownWards;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.Settlement;

/**
 * Serves one site's <b>town layout</b> at {@code GET /api/sessions/{sid}/town/{provinceId}} —
 * {@code docs/towngen-port.md} T7, prototype.
 * <p>
 * <b>Its own endpoint, not the snapshot</b> (§1 Transport). A town is hundreds of polygons and only
 * a client zoomed past band 5.5 wants any of them, so it follows the route feed's precedent rather
 * than inflating every tick of the SSE stream for every viewer.
 * <p>
 * <b>Keyed by site, not by colony</b> (§2a): a layout outlives the settlement that raised it, so a
 * dead colony's town can persist as a ruin under the same URL.
 * <p>
 * <b>Prototype scope.</b> The layout is computed per request, which is affordable at this size (a
 * 30-plot town is microseconds of half-plane clipping) and lets the drawing be judged against the
 * reference before the storage is built. T7 proper writes it as {@code json.gz} per site (§3a), and
 * the endpoint then becomes a file read.
 */
@RestController
public class TownController {

	private final SessionHost host;

	public TownController(SessionHost host) {
		this.host = host;
	}

	/**
	 * The town standing in a province.
	 *
	 * @param sid        the session
	 * @param provinceId the site
	 * @return the layout, or an empty one when no colony stands there
	 */
	@GetMapping("/api/sessions/{sid}/town/{provinceId}")
	public ResponseEntity<TownView> town(@PathVariable String sid, @PathVariable int provinceId) {
		HostedSession hs = host.get(sid);
		if (hs == null)
			return ResponseEntity.notFound().build();
		// the colonies of this province: one of them is the town, the rest are its neighbours in a
		// league, and the footprint needs to know about them or they claim each other's ground
		List<Settlement> here = new ArrayList<>();
		for (Settlement c : hs.colonies())
			if (c.getProvince() != null && c.getProvince().id() == provinceId)
				here.add(c);
		if (here.isEmpty())
			return fresh(TownView.empty(provinceId));
		Settlement colony = here.get(0);
		Footprint footprint = ColonyFootprint.of(colony,
				hs.session().plotPoolIfPresent(provinceId), hs.colonies());
		if (footprint.isEmpty())
			return fresh(TownView.empty(provinceId));
		long seed = TownRng.siteSeed(hs.session().getSeed(), provinceId);
		TownMesh mesh = TownMesh.of(footprint, seed);
		TownWall wall = ColonyWall.of(colony, hs.session().plotPoolIfPresent(provinceId),
				hs.session().getWorldMap(), footprint);
		TownStreets streets = ColonyStreets.of(colony, hs.session().plotPoolIfPresent(provinceId),
				hs.session().getWorldMap(), footprint, mesh, wall);
		// what stands on each plot, and how crowded it is — real sim state, plus the synthetic
		// population of the 1444 core the sim has not reached (T6, §4a/§4b)
		ColonySite site = ColonySite.of(colony, hs.session().plotPoolIfPresent(provinceId), streets);
		Cell centre = colony.getCityCenter() == null ? null
				: new Cell(colony.getCityCenter().x(), colony.getCityCenter().y());
		TownRiver river = TownRiver.of(footprint, site);
		TownWards wards = TownWards.of(footprint, wall, streets, centre, site, seed);
		TownLots lots = TownLots.of(mesh, wall, river, site, seed);
		return fresh(TownView.of(provinceId, colony.getName(), footprint, mesh, wall, streets, wards,
				lots));
	}

	// a town grows as its colony builds, so it is served fresh like the route layer rather than
	// immutably cached like the static plot grid
	private static ResponseEntity<TownView> fresh(TownView view) {
		return ResponseEntity.ok().cacheControl(CacheControl.noCache()).body(view);
	}
}
