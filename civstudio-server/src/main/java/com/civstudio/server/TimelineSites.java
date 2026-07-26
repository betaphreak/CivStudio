package com.civstudio.server;

import java.util.Collection;
import java.util.List;

import com.civstudio.geo.Province;
import com.civstudio.geo.Realm;
import com.civstudio.settlement.Settlement;

/**
 * Where a player joining a ranked {@linkplain SessionSpec#TIMELINE Timeline} founds — the site
 * picker (see {@code docs/spectator-lobby.md} Phase 3).
 * <p>
 * <b>One province each, spread across the map.</b> The first joiner takes the Timeline's
 * {@linkplain SessionSpec#provinceId anchor}; every later joiner takes the viable province
 * <em>furthest from everyone already seated</em> — max-min distance, the same idea
 * {@code ProvincePlotPool.foundingCenter} uses to space colonies within a province, lifted to the
 * world. Rivals therefore start far apart and expansion means something.
 * <p>
 * <b>Deterministic.</b> No randomness: the picks are a pure function of the map, the anchor and the
 * join order, and ties break on province id. So a Timeline's roster replays exactly — which is what
 * lets a run be rebuilt from its spec + roster rather than a snapshot.
 * <p>
 * <b>Scoped to one {@link Realm}.</b> A Timeline is a single realm's ranked ladder (docs/realms.md
 * §Ranked is per realm): the realm is the anchor's, and every joiner founds within it — so the
 * royale never spans a boundary the UI cannot see across, and neither {@link Realm#NONE realm-less}
 * land nor a {@linkplain Realm#isPlayable() view-only} realm is ever a site.
 * <p>
 * <b>The scope is the founding, not the road.</b> Under three realms the other half of this was a
 * closed edge: the only way out of a realm was a fey portal, gated shut, so no colony could walk into
 * another ladder. The six-realm split ends that — the Serpentspine's 49 cave mouths are ordinary
 * walkable ground (docs/realms.md §Crossing a realm on foot) — so the invariant moved here, to where
 * a colony comes into being. Travel between realms is free; <em>founding</em> outside the Timeline's
 * realm is refused, which no future road, portal or boat can leak.
 */
public final class TimelineSites {

	private TimelineSites() {
	}

	/**
	 * The province the next joiner should found into.
	 *
	 * @param world  every province on the map
	 * @param taken  the colonies already seated in this Timeline (their provinces are excluded, and
	 *               the pick is pushed as far from them as the map allows)
	 * @param anchor the Timeline's anchor province — the first joiner's site
	 * @return the chosen province
	 * @throws IllegalStateException if the map has no viable province left
	 */
	public static Province pick(Collection<Province> world, List<Settlement> taken, Province anchor) {
		// the Timeline's realm is the anchor's; every site must sit in it (and never in Realm.NONE)
		Realm realm = anchor == null ? Realm.NONE : anchor.realm();
		if (taken.isEmpty() && viable(anchor, realm))
			return anchor;

		Province best = null;
		double bestDistance = -1;
		for (Province p : world) {
			if (!viable(p, realm) || isTaken(p, taken))
				continue;
			double d = nearestTakenDistance(p, taken);
			// strictly-greater keeps the FIRST of equally-distant candidates, and `world` iterates
			// in province-id order — so ties break on id rather than on map iteration luck
			if (d > bestDistance) {
				bestDistance = d;
				best = p;
			}
		}
		if (best == null)
			throw new IllegalStateException("no settleable province left to found into");
		return best;
	}

	/**
	 * Whether {@code p} may be founded into for a Timeline scoped to {@code realm} — the check the
	 * picker filters on, exposed so the founding seam can assert the same thing about a site it did
	 * not pick (docs/realms.md §Ranked is per realm).
	 *
	 * @param p     the candidate province, or {@code null}
	 * @param realm the Timeline's realm
	 * @return whether a colony may be founded there
	 */
	public static boolean canFound(Province p, Realm realm) {
		return viable(p, realm);
	}

	/**
	 * A province worth founding into: settleable land in this Timeline's realm — which must be a real,
	 * {@linkplain Realm#isPlayable() playable} map, so never {@link Realm#NONE} and never the
	 * view-only Hinuilands — with room for a colony to grow.
	 */
	private static boolean viable(Province p, Realm realm) {
		return p != null && p.realm() == realm && realm.isPlayable()
				&& p.isSettleable() && p.plots() >= Settlement.MIN_FOUNDING_PLOTS;
	}

	private static boolean isTaken(Province p, List<Settlement> taken) {
		for (Settlement c : taken)
			if (c.getProvince() != null && c.getProvince().id() == p.id())
				return true;
		return false;
	}

	// distance to the NEAREST seated colony — the score we maximize, so the pick is the site
	// furthest from its closest rival rather than furthest from their average
	private static double nearestTakenDistance(Province p, List<Settlement> taken) {
		double nearest = Double.MAX_VALUE;
		for (Settlement c : taken) {
			Province q = c.getProvince();
			if (q == null)
				continue;
			double dx = p.longitude() - q.longitude();
			double dy = p.latitude() - q.latitude();
			nearest = Math.min(nearest, dx * dx + dy * dy); // squared: ordering is all we need
		}
		return nearest == Double.MAX_VALUE ? 0 : nearest;
	}
}
