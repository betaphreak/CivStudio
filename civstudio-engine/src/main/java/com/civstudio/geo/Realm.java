package com.civstudio.geo;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * A <b>realm</b> of the planet Halann: a partition of the imported world map into the separate
 * <em>maps</em> Anbennar's modders faked onto one EU4 cylinder. There are six real realms plus
 * {@link #NONE} (a province that belongs to no realm and renders nowhere). See {@code docs/realms.md}.
 *
 * <ul>
 * <li>{@link #CANNOR} — the Old World's west, {@code europe}. Playable.</li>
 * <li>{@link #SERPENTSPINE} — the mountain range and the Dwarovar beneath it: <b>every</b> underground
 *     province ({@link ProvinceType#isUnderground()}) plus the {@code serpentspine} continent's surface
 *     walls and passes. Playable. Membership is a <em>type</em> predicate, not a continent lookup — 19
 *     holds sit under other continents, and 57 spine-continent provinces are surface.</li>
 * <li>{@link #HALESS} — the far east, {@code asia}. Playable.</li>
 * <li>{@link #SARHAL} — the southern continent, {@code africa}. Playable.</li>
 * <li>{@link #AELANTIR} — the New World: both Americas ({@code north_america}/{@code south_america},
 *     one landmass across a real ocean). Playable.</li>
 * <li>{@link #HINUILANDS} — {@code oceania}: two provinces Anbennar painted of a realm it reserved
 *     245 for. Viewable only, not playable — no route reaches it.</li>
 * <li>{@link #NONE} — no realm: the three projection/ice quirks and the deep-ocean provinces that
 *     touch no land. They keep their id, neighbours, plots and (for land) settleability, but belong
 *     to no map and are fogged everywhere. This is a real member — the thing the settleable filter
 *     tests — not an oversight.</li>
 * </ul>
 *
 * <p><b>{@code halcann} is a retired realm key, kept as a read-only alias for {@link #CANNOR}.</b> The
 * Old World was one realm until the six-realm split; {@code halcann} is still persisted in old
 * {@code SessionSpec}s, in shared {@code ?realm=} links and in the studio enumeration, so {@link
 * #fromKey(String)} resolves it — but it is deliberately <em>not</em> an enum member, so nothing can
 * hold a Halcann realm and no code path can grow that assumes one. See {@code docs/realms.md}
 * §Halcann must be migrated, not just renamed.
 *
 * <p>Realm is <em>resolved at export</em> ({@link com.civstudio.geo.export.RealmExporter}) as a pure
 * function of the map — province type for the Serpentspine, {@link Continent} for the rest of the land,
 * adjacent land for water — and stamped onto {@code provinces.json} as {@link Province#realm()},
 * mirrored into the web bundle. It is <b>not</b> re-derived on the client: the exporter is the single
 * source of truth (two of its rules are graph walks, not table lookups). Like {@link Continent} it is a
 * small fixed taxonomy, so an {@code enum}.
 *
 * <p>Realm is the <em>only</em> map axis. The z/plane axis the Serpentspine used to live on is gone —
 * the Dwarovar provinces have their own pixels, so they were never "a plane at the same coordinates".
 * See {@code docs/realms.md} §The Serpentspine was never a plane.
 */
public enum Realm {

	CANNOR("cannor", "Cannor", true),
	SERPENTSPINE("serpentspine", "Serpentspine", true),
	HALESS("haless", "Haless", true),
	SARHAL("sarhal", "Sarhal", true),
	AELANTIR("aelantir", "Aelantir", true),
	HINUILANDS("hinuilands", "Hinuilands", false),
	/** No realm — fogged everywhere. Its {@code raw_key} is {@code null}: an absent realm key. */
	NONE(null, "None", false);

	/**
	 * The retired {@code halcann} key, resolved to {@link #CANNOR} by {@link #fromKey(String)} so old
	 * session specs and shared links keep working. Never written.
	 */
	public static final String LEGACY_HALCANN_KEY = "halcann";

	private final String rawKey;
	private final String displayName;
	private final boolean playable;

	Realm(String rawKey, String displayName, boolean playable) {
		this.rawKey = rawKey;
		this.displayName = displayName;
		this.playable = playable;
	}

	/** The stable {@code raw_key} (e.g. {@code "cannor"}); {@code null} for {@link #NONE}. */
	@JsonValue
	public String rawKey() {
		return rawKey;
	}

	/** The display name (e.g. {@code "Halcann"}). */
	public String displayName() {
		return displayName;
	}

	/**
	 * Whether a colony may be founded into this realm — {@code true} for the five real maps,
	 * {@code false} for {@link #HINUILANDS} (view-only) and {@link #NONE}. A realm's playability
	 * gates the settleable/site set (see {@code TimelineSites}).
	 */
	public boolean isPlayable() {
		return playable;
	}

	/**
	 * The realm for a {@code raw_key}, for Jackson and consumers. A {@code null} key is {@link #NONE}
	 * (an absent realm), matching the {@code null} {@link #rawKey()} the exporter stamps for a
	 * realm-less province. The retired {@link #LEGACY_HALCANN_KEY halcann} key resolves to {@link
	 * #CANNOR}.
	 *
	 * @param key a realm {@code raw_key} (e.g. {@code "cannor"}), or {@code null}
	 * @return the matching realm; {@link #NONE} if {@code key} is {@code null}
	 * @throws IllegalArgumentException if {@code key} is non-null but unknown
	 */
	@JsonCreator
	public static Realm fromKey(String key) {
		if (key == null)
			return NONE;
		if (LEGACY_HALCANN_KEY.equals(key))
			return CANNOR; // retired realm — the Old World's colonies are all in Cannor
		for (Realm r : values())
			if (key.equals(r.rawKey))
				return r;
		throw new IllegalArgumentException("unknown realm key: " + key);
	}

	/**
	 * The realm a <em>surface</em> land province with this {@link Continent} belongs to (rule 3 of
	 * {@code docs/realms.md} §The model): {@code europe} → {@link #CANNOR}, {@code asia} → {@link
	 * #HALESS}, {@code africa} → {@link #SARHAL}, both Americas → {@link #AELANTIR}, {@code oceania} →
	 * {@link #HINUILANDS}, {@code serpentspine} → {@link #SERPENTSPINE}. A {@code null} continent is
	 * {@link #NONE}.
	 *
	 * <p><b>This is not the whole rule for the Serpentspine.</b> Rule 2 runs first and claims every
	 * {@link ProvinceType#isUnderground() underground} province regardless of continent — 19 of them
	 * carry {@code europe}/{@code asia}/{@code africa} and would land in the wrong realm here. The
	 * {@code SERPENTSPINE} case below only covers the range's <em>surface</em> walls and passes.
	 *
	 * @param c the land province's continent, or {@code null}
	 * @return the resolved realm
	 */
	public static Realm fromContinent(Continent c) {
		if (c == null)
			return NONE;
		return switch (c) {
			case NORTH_AMERICA, SOUTH_AMERICA -> AELANTIR;
			case OCEANIA -> HINUILANDS;
			case EUROPE -> CANNOR;
			case ASIA -> HALESS;
			case AFRICA -> SARHAL;
			case SERPENTSPINE -> SERPENTSPINE;
		};
	}

	/**
	 * The realm a land province belongs to, applying rules 2 and 3 of {@code docs/realms.md} §The
	 * model in order: an {@link ProvinceType#isUnderground() underground} province is always {@link
	 * #SERPENTSPINE}, whatever continent it carries; everything else follows {@link
	 * #fromContinent(Continent)}.
	 *
	 * <p>This is the single place the two land rules compose, so the exporter, the tests and any
	 * future consumer cannot disagree about their order.
	 *
	 * @param type the province's type (never {@code null})
	 * @param c the province's continent, or {@code null}
	 * @return the resolved realm
	 */
	public static Realm forLand(ProvinceType type, Continent c) {
		return type.isUnderground() ? SERPENTSPINE : fromContinent(c);
	}
}
