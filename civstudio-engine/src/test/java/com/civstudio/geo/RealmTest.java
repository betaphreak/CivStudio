package com.civstudio.geo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

import com.civstudio.settlement.GameSession;

/**
 * The {@link Realm} taxonomy and the realm stamped onto the committed {@code provinces.json} —
 * loaded end-to-end through the {@link WorldMap} (so this also exercises Jackson's {@code null →
 * Realm.NONE} default). See {@code docs/realms.md}.
 */
class RealmTest {

	private final WorldMap world = new GameSession(1).getWorldMap();

	@Test
	void continentMapsToRealm() {
		assertSame(Realm.AELANTIR, Realm.fromContinent(Continent.NORTH_AMERICA));
		assertSame(Realm.AELANTIR, Realm.fromContinent(Continent.SOUTH_AMERICA));
		assertSame(Realm.HINUILANDS, Realm.fromContinent(Continent.OCEANIA));
		assertSame(Realm.CANNOR, Realm.fromContinent(Continent.EUROPE));
		assertSame(Realm.HALESS, Realm.fromContinent(Continent.ASIA));
		assertSame(Realm.SARHAL, Realm.fromContinent(Continent.AFRICA));
		assertSame(Realm.SERPENTSPINE, Realm.fromContinent(Continent.SERPENTSPINE));
		assertSame(Realm.NONE, Realm.fromContinent(null));
	}

	@Test
	void undergroundBeatsContinent() {
		// rule 2 before rule 3 (docs/realms.md §Serpentspine membership is by type, not continent):
		// 19 underground provinces carry a surface continent and must still be Serpentspine
		assertSame(Realm.SERPENTSPINE, Realm.forLand(ProvinceType.DWARVEN_HOLD_SURFACE, Continent.EUROPE));
		assertSame(Realm.SERPENTSPINE, Realm.forLand(ProvinceType.CAVERN, Continent.ASIA));
		assertSame(Realm.SERPENTSPINE, Realm.forLand(ProvinceType.DWARVEN_ROAD, Continent.AFRICA));
		// the range's surface walls stay Serpentspine too, by continent
		assertSame(Realm.SERPENTSPINE, Realm.forLand(ProvinceType.IMPASSABLE, Continent.SERPENTSPINE));
		// and an ordinary surface province is untouched by rule 2
		assertSame(Realm.CANNOR, Realm.forLand(ProvinceType.LAND, Continent.EUROPE));
		assertSame(Realm.CANNOR, Realm.forLand(ProvinceType.ANCIENT_FOREST, Continent.EUROPE));
	}

	@Test
	void rawKeyRoundTrips() {
		assertSame(Realm.NONE, Realm.fromKey(null)); // an absent realm key
		assertSame(Realm.CANNOR, Realm.fromKey("cannor"));
		assertSame(Realm.SERPENTSPINE, Realm.fromKey("serpentspine"));
		assertSame(Realm.HINUILANDS, Realm.fromKey("hinuilands"));
		assertThrows(IllegalArgumentException.class, () -> Realm.fromKey("atlantis"));
		assertEquals(null, Realm.NONE.rawKey());
		assertTrue(Realm.CANNOR.isPlayable() && Realm.AELANTIR.isPlayable()
				&& Realm.SERPENTSPINE.isPlayable() && Realm.HALESS.isPlayable()
				&& Realm.SARHAL.isPlayable());
		assertFalse(Realm.HINUILANDS.isPlayable() || Realm.NONE.isPlayable());
	}

	@Test
	void halcannIsAReadOnlyAliasForCannor() {
		// the retired realm key, still in old SessionSpecs and shared ?realm= links
		// (docs/realms.md §Halcann must be migrated, not just renamed)
		assertSame(Realm.CANNOR, Realm.fromKey(Realm.LEGACY_HALCANN_KEY));
		// ...and never written back: no member carries it
		for (Realm r : Realm.values())
			assertNotEquals(Realm.LEGACY_HALCANN_KEY, r.rawKey(), r + " must not persist as halcann");
	}

	@Test
	void everyProvinceHasARealmAndTheyPartitionTheMap() {
		int total = world.provinces().size();
		int summed = 0;
		for (Realm r : Realm.values())
			summed += world.provincesOfRealm(r).size();
		assertEquals(total, summed, "realm buckets must partition every province exactly once");
		for (Province p : world.provinces())
			assertNotNull(p.realm(), "realm is never null (defaults to NONE)");
	}

	@Test
	void knownProvincesResolveAsDesigned() {
		// Hinuilands is painted for exactly two provinces (docs/realms.md §Hinuilands is not painted)
		assertSame(Realm.HINUILANDS, world.province(3060).realm()); // Vyr Pas
		assertSame(Realm.HINUILANDS, world.province(3061).realm()); // Vyr Cirentyn
		assertEquals(2, world.provincesOfRealm(Realm.HINUILANDS).size());
		// the three quirks are dropped from their realm (§Three quirk provinces)
		assertSame(Realm.NONE, world.province(6237).realm()); // South Toreiel (LAND, but realm-less)
		assertSame(Realm.NONE, world.province(6238).realm()); // North Toreiel
		assertSame(Realm.NONE, world.province(1808).realm()); // Ekyunimoy (Antarctic ice)
		// the Phase 0 portal waypoints land in Cannor via their europe continent (§The model)
		for (int id : new int[] { 7025, 7027, 7030, 7033 })
			assertSame(Realm.CANNOR, world.province(id).realm(), "portal waypoint " + id);
	}

	@Test
	void theSerpentspineIsEveryUndergroundProvincePlusTheRangesSurface() {
		for (Province p : world.provinces())
			if (p.type().isUnderground())
				assertSame(Realm.SERPENTSPINE, p.realm(), p.name() + " is underground");
		// 385 underground + 57 surface walls/passes (§Serpentspine membership is by type)
		assertEquals(442, world.provincesOfRealm(Realm.SERPENTSPINE).stream()
				.filter(p -> p.type() != ProvinceType.SEA && p.type() != ProvinceType.LAKE).count());
		// the four off-continent holds this rule exists for
		assertSame(Realm.SERPENTSPINE, world.province(4097).realm()); // Marrhold, continent europe
		assertSame(Realm.SERPENTSPINE, world.province(526).realm());  // Ovdal Tungr, continent africa
		assertSame(Realm.SERPENTSPINE, world.province(4073).realm()); // Eastern Reach, continent asia
		// ...and the surface provinces they open onto stay in their surface realm
		assertSame(Realm.CANNOR, world.province(896).realm());        // Marrvale
		assertSame(Realm.SARHAL, world.province(525).realm());        // Gordihr
	}

	@Test
	void realmCountsMatchTheDesign() {
		// docs/realms.md §The six realms — the table at the top of the doc, asserted
		assertEquals(1557, world.provincesOfRealm(Realm.AELANTIR).size());
		assertEquals(1172, world.provincesOfRealm(Realm.SARHAL).size());
		assertEquals(1102, world.provincesOfRealm(Realm.HALESS).size());
		assertEquals(898, world.provincesOfRealm(Realm.CANNOR).size());
		assertEquals(444, world.provincesOfRealm(Realm.SERPENTSPINE).size());
		assertEquals(2, world.provincesOfRealm(Realm.HINUILANDS).size());
		assertEquals(93, world.provincesOfRealm(Realm.NONE).size());
	}

	@Test
	void everyLakeBelongsSomewhere() {
		// a realm-less lake is an invisible hole in every realm view (§Realm-less provinces are
		// invisible); rule 5's nearest-land fallback exists to make this hold
		for (Province p : world.provinces())
			if (p.type() == ProvinceType.LAKE)
				assertNotSame(Realm.NONE, p.realm(), p.name() + " (LAKE) is realm-less");
	}

	@Test
	void settleableSetExcludesRealmlessLand() {
		List<Province> settleable = world.settleableProvinces();
		for (Province p : settleable)
			assertNotSame(Realm.NONE, p.realm(), p.name() + " is realm-less but settleable");
		// the Toreiels are settleable-typed LAND yet realm-less, so they must be excluded
		assertTrue(world.province(6237).isSettleable(), "precondition: South Toreiel is LAND");
		assertFalse(settleable.contains(world.province(6237)), "realm-less Toreiel must not be a site");
	}
}
