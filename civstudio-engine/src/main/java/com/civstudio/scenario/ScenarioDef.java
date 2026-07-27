package com.civstudio.scenario;

import java.util.Map;

/**
 * A foundable scenario as <b>data</b> — its founding shape, the balance profile it tunes agents with,
 * and free-form flags, so a host founds it without a hardcoded branch and new scenarios can be
 * authored as content ({@code docs/studio-control-plane-plan.md} workstream B).
 *
 * <p><b>Seed and province are deliberately not here.</b> The plan sketched them onto the def, but for
 * a hosted session they are per-<em>instance</em> — a player picks a seed and a site at create time,
 * and they live on the {@code SessionSpec}. Baking them into the def would fix every session founded
 * from a scenario to one seed. A def is the <em>shape</em>; the spec supplies the <em>instance</em>.
 *
 * @param key            the scenario id — the string a {@code SessionSpec}/calibration call names
 * @param label          a player-facing name (localizable content downstream)
 * @param blurb          a one-line description (player-facing)
 * @param balanceProfile the {@code BalanceProfiles} key to found on ({@code "default"} = compiled)
 * @param shape          how it founds — the host's branch
 * @param flags          founding-shape extras read defensively by the host (e.g. {@code homePlots}
 *                       for a {@link FoundingShape#CAMP}); never {@code null}
 */
public record ScenarioDef(String key, String label, String blurb, String balanceProfile,
		FoundingShape shape, Map<String, Object> flags) {

	public ScenarioDef {
		flags = flags == null ? Map.of() : Map.copyOf(flags);
	}

	/** A flag read as an int, defaulting when absent or non-numeric — the same forgiving read. */
	public int flag(String name, int fallback) {
		return flags.get(name) instanceof Number n ? n.intValue() : fallback;
	}

	/** A flag read as a boolean, defaulting when absent or non-boolean — the forgiving read a host wants. */
	public boolean flag(String name, boolean fallback) {
		return flags.get(name) instanceof Boolean b ? b : fallback;
	}
}
