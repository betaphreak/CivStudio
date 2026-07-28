package com.civstudio.server.render;

/**
 * A town layout <b>as it is stored</b> — {@code docs/towngen-port.md} §3a, T7.
 * <p>
 * <b>Not a render cache.</b> The plan is explicit that a layout is a first-class world artifact
 * rather than something the renderer keeps warm, and three things follow from that, all of them
 * cheap now and expensive later:
 * <ul>
 * <li><b>Ruins need durability.</b> A dead colony's footprint is gone from the {@code Settlement},
 *     so a layout that lived only in a JVM cache could not be recomputed after a container roll —
 *     the ruin would silently vanish on the next deploy, and §2a's promise with it. The record
 *     outlives the colony because it is on disk, keyed by <b>site</b>.</li>
 * <li><b>History wants a time.</b> A directory of shapes is not a history; a directory of shapes
 *     that know when they were founded, when they last grew and when they fell is. The long game is
 *     a worldgen pass that ages a world for centuries before play, and a layout is then part of the
 *     generated history rather than a picture of the present.</li>
 * <li><b>Identity has to survive a regeneration.</b> Everything here is keyed by plot coordinates
 *     (§3a.1's whole trick) — a patch by {@code (x, y)}, a wall piece by {@code (x, y, side)}, a lot
 *     by {@code (x, y, index)} — because a cell's coordinates are stable forever and an index into a
 *     list of patches is not. That is what lets authored name overrides outlive a generator change.
 * </li>
 * </ul>
 * The {@code signature} is what makes serving cheap: it hashes the colony state the layout is
 * derived from, so a request can tell in one comparison whether the stored shape is still the
 * town's shape (see {@code town.TownSignature}).
 *
 * @param version   the generator version that wrote it — a bump invalidates every file, the way
 *                  {@code MAP_VERSION} does for the plot cache
 * @param province  the site
 * @param colony    the settlement standing there when it was last computed, or {@code null}
 * @param signature the hash of the colony state this layout was derived from; {@code 0} for a ruin
 * @param founded   the in-game date this site's layout was first written
 * @param grown     the in-game date it last changed shape
 * @param ruined    the in-game date its colony was found gone, or {@code null} while it lives
 * @param layout    the layout itself
 */
public record TownRecord(int version, int province, String colony, int signature, String founded,
		String grown, String ruined, TownView layout) {

	/** Whether the colony that raised this town is gone — the layout is a ruin now (§2a). */
	public boolean isRuin() {
		return ruined != null;
	}

	/**
	 * Whether this record still describes the town.
	 *
	 * @param version   the current generator version
	 * @param signature the colony's current signature
	 * @return {@code true} when it can be served without recomputing
	 */
	public boolean matches(int version, int signature) {
		return this.version == version && this.signature == signature;
	}

	/** The same record, marked as a ruin from {@code date} — idempotent once it already is one. */
	public TownRecord ruinedOn(String date) {
		return isRuin() ? this
				: new TownRecord(version, province, colony, com.civstudio.server.town.TownSignature.RUIN,
						founded, grown, date, layout);
	}
}
