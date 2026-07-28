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
import com.civstudio.server.render.TownRecord;
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
import com.civstudio.server.town.TownSignature;
import com.civstudio.server.town.TownStreets;
import com.civstudio.server.town.TownWall;
import com.civstudio.server.town.TownWards;
import com.civstudio.server.town.geom.GridOutline.Cell;
import com.civstudio.settlement.Settlement;

/**
 * Serves one site's <b>town layout</b> at {@code GET /api/sessions/{sid}/town/{provinceId}} —
 * {@code docs/towngen-port.md} T7.
 * <p>
 * <b>Its own endpoint, not the snapshot</b> (§1 Transport). A town is hundreds of polygons and only
 * a client zoomed past band 5.5 wants any of them, so it follows the route feed's precedent rather
 * than inflating every tick of the SSE stream for every viewer. The snapshot carries only the
 * colony's {@code townRev}, so a browser knows <em>when</em> to come back here.
 * <p>
 * <b>Keyed by site, not by colony</b> (§2a), and that is the whole reason for the store. The layout
 * is written to the {@code .map} volume as {@code json.gz} and recomputed only when the colony's
 * {@linkplain TownSignature signature} changes — so a growing town redraws, a settled one costs a
 * file read, and a <b>dead</b> one keeps its shape as a ruin. A layout held only in memory could not
 * survive a container roll, and the map would quietly forget every settlement that ever failed.
 */
@RestController
public class TownController {

	private final SessionHost host;
	private final TownStore store;

	public TownController(SessionHost host, TownStore store) {
		this.host = host;
		this.store = store;
	}

	/** The store this controller writes to — for the admin readout and the tests. */
	public TownStore store() {
		return store;
	}

	/**
	 * The town standing in a province.
	 *
	 * @param sid        the session
	 * @param provinceId the site
	 * @return the layout — recomputed if the town has changed, read from the store if not, and the
	 *         stored ruin if the colony that raised it is gone
	 */
	@GetMapping("/api/sessions/{sid}/town/{provinceId}")
	public ResponseEntity<TownView> town(@PathVariable String sid, @PathVariable int provinceId) {
		HostedSession hs = host.get(sid);
		if (hs == null)
			return ResponseEntity.notFound().build();
		TownRecord stored = store.read(sid, provinceId);
		String today = hs.date().toString();

		// the colonies of this province: one of them is the town, the rest are its neighbours in a
		// league, and the footprint needs to know about them or they claim each other's ground
		// isDead(), NOT !isAlive(): a colony that has not started yet is also not alive, and a session
		// created but not yet running would otherwise read as a field of ruins on day zero
		List<Settlement> here = new ArrayList<>();
		for (Settlement c : hs.colonies())
			if (c.getProvince() != null && c.getProvince().id() == provinceId && !c.isDead())
				here.add(c);

		if (here.isEmpty()) {
			// NOBODY LIVES HERE ANY MORE. If this site was ever a town, it still is one — a ruin
			// (§2a: the wall is a high-water mark and decline hollows out inside it). The date it
			// fell is stamped the first time we notice, and never again.
			if (stored == null)
				return fresh(TownView.empty(provinceId));
			TownRecord ruin = stored.ruinedOn(today);
			if (ruin != stored)
				store.write(sid, ruin);
			return fresh(ruin.layout());
		}

		Settlement colony = here.get(0);
		int signature = TownSignature.of(colony);
		if (stored != null && !stored.isRuin() && stored.matches(TownStore.TOWN_VERSION, signature))
			return fresh(stored.layout());        // unchanged since it was written: a file read

		// §2a's high-water mark: a town that starved back below TOWN would otherwise lose the wall it
		// spent a century raising, because the fit reads the CURRENT tier. The stored layout is the
		// only thing that remembers, which is one more reason the store is not a cache.
		TownView layout = compute(hs, colony, provinceId)
				.keepingWallOf(stored == null ? null : stored.layout());
		String founded = stored == null ? today : stored.founded();
		store.write(sid, new TownRecord(TownStore.TOWN_VERSION, provinceId, colony.getName(),
				signature, founded, today, null, layout));
		return fresh(layout);
	}

	/** Run the whole generator over a colony — T2 through T6, in the order each depends on. */
	private static TownView compute(HostedSession hs, Settlement colony, int provinceId) {
		Footprint footprint = ColonyFootprint.of(colony,
				hs.session().plotPoolIfPresent(provinceId), hs.colonies());
		if (footprint.isEmpty())
			return TownView.empty(provinceId);
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
		return TownView.of(provinceId, colony.getName(), footprint, mesh, wall, streets, wards, lots);
	}

	// a town changes as its colony builds, so it is served fresh like the route layer rather than
	// immutably cached like the static plot grid — the snapshot's townRev is what tells a client to
	// ask again, and asking is cheap because the store answers most of the time
	private static ResponseEntity<TownView> fresh(TownView view) {
		return ResponseEntity.ok().cacheControl(CacheControl.noCache()).body(view);
	}
}
