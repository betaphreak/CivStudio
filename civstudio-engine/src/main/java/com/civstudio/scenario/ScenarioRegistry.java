package com.civstudio.scenario;

import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.civstudio.data.WorldSource;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * The foundable scenarios, as a registry of {@link ScenarioDef}s — the single home a host resolves
 * {@code spec.scenario()} against, replacing the hardcoded {@code isTimeline()} branch ({@code
 * docs/studio-control-plane-plan.md} workstream B).
 *
 * <p><b>Compiled built-ins are the floor; content is the override.</b> The four scenarios the code
 * knows today ({@code standard}, {@code caravan-demo}, {@code camp}, {@code timeline}) are compiled
 * in, and an authored {@code /scenarios.json} adds to or overrides them by key — so a new scenario is
 * a content edit, but a stripped-down/offline build still founds the demo and the timeline. Same
 * shape as {@link com.civstudio.balance.BalanceProfiles} and {@link com.civstudio.era.EconomyCatalog}.
 *
 * <h2>Failure contract</h2>
 * Absent resource → the built-ins alone (behaviour-neutral, the offline path). Present but
 * malformed → {@link IllegalStateException} at load, never a silent fallback that would drop authored
 * scenarios.
 */
public final class ScenarioRegistry {

	/** The content path; served by whichever {@link WorldSource} is installed. */
	public static final String RESOURCE = "/scenarios.json";

	static final ObjectMapper MAPPER = JsonMapper.builder()
			.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true)
			.build();

	// the scenarios the code founds today, in a stable order. caravan-demo and timeline are what the
	// server actually creates (SessionSpec.CARAVAN_DEMO/TIMELINE); standard is the plain calibration
	// base; camp demonstrates the CAMP shape as data rather than a scenario class.
	private static final List<ScenarioDef> BUILT_INS = List.of(
			new ScenarioDef("standard", "Standard Colony",
					"A standard ruler-bearing colony — the plain founding, and the headless"
							+ " calibration base.",
					"default", FoundingShape.STANDARD_COLONY, Map.of()),
			new ScenarioDef("caravan-demo", "Caravan Demo",
					"The spectator demo: a standard colony that musters its own winter foraging"
							+ " expeditions, drawn live on the map.",
					"default", FoundingShape.STANDARD_COLONY, Map.of()),
			new ScenarioDef("camp", "Frontier Camp",
					"Founds low as a foraging camp and climbs the tier ladder, booting its ruler"
							+ " economy at Smallholding; each household works a home plot.",
					"default", FoundingShape.CAMP, Map.of("homePlots", true)),
			new ScenarioDef("legacy-market", "Legacy Market",
					"The pure-market collapse-era economy (no home plots, no build economy) —"
							+ " kept for game-over mechanics and contrast runs.",
					"default", FoundingShape.STANDARD_COLONY,
					Map.of("homePlots", false, "buildEconomy", false)),
			new ScenarioDef("hammers", "Hammer Economy",
					"The frontier camp with the build economy on: settled households choose daily"
							+ " between wage labor and working their plot for hammers + commerce.",
					"default", FoundingShape.CAMP,
					Map.of("homePlots", true, "buildEconomy", true)),
			new ScenarioDef("league-demo", "City League",
					"A league of cities founded together into one province: the lead city and nine"
							+ " vassal mayors around a shared site, which is what a large historical"
							+ " city actually is (docs/city-and-league.md, towngen-port.md §2c).",
					"default", FoundingShape.LEAGUE, Map.of("leagueSize", 10)),
			new ScenarioDef("timeline", "Ranked Timeline",
					"One shared world many players found into, run in lockstep until one colony"
							+ " stands.",
					"default", FoundingShape.TIMELINE, Map.of()));

	// built on first use and rebuilt if the active WorldSource changes — never captured at class-load
	// (see WorldSourceCache for the ordering hazard this avoids)
	private static final com.civstudio.data.WorldSourceCache<ScenarioRegistry> CACHE =
			new com.civstudio.data.WorldSourceCache<>(ScenarioRegistry::load);

	private final Map<String, ScenarioDef> byKey;

	private ScenarioRegistry(Map<String, ScenarioDef> byKey) {
		this.byKey = byKey;
	}

	/** The shared registry. */
	public static ScenarioRegistry get() {
		return CACHE.get();
	}

	/**
	 * The scenario for a key, or {@code null} when unknown — the host logs and falls back to a
	 * standard founding rather than 404-ing a restore of a session whose scenario string predates
	 * the registry.
	 *
	 * @param key the scenario id
	 * @return the def, or {@code null} if unregistered
	 */
	public ScenarioDef resolve(String key) {
		return byKey.get(key);
	}

	/** Every registered scenario, in load order (built-ins first). */
	public List<ScenarioDef> all() {
		return List.copyOf(byKey.values());
	}

	/** Read the registry from a source. Package-private and parameterised so a test can drive it. */
	static ScenarioRegistry load(WorldSource source) {
		Map<String, ScenarioDef> byKey = new LinkedHashMap<>();
		for (ScenarioDef def : BUILT_INS)
			byKey.put(def.key(), def);
		try (InputStream in = source.open(RESOURCE)) {
			if (in == null)
				return new ScenarioRegistry(byKey); // unauthored: built-ins only
			List<ScenarioDef> authored = MAPPER.readValue(in, new TypeReference<List<ScenarioDef>>() {
			});
			for (ScenarioDef def : authored)
				byKey.put(def.key(), def); // content adds or overrides by key
		} catch (IOException | RuntimeException e) {
			throw new IllegalStateException(
					"ScenarioRegistry: " + RESOURCE + " is present but unreadable — refusing to drop"
							+ " authored scenarios silently: " + e.getMessage(), e);
		}
		return new ScenarioRegistry(byKey);
	}

	/**
	 * The canonical JSON for the compiled built-ins — a list, how the seed content is produced and
	 * what the round-trip test checks.
	 *
	 * @return the built-ins as pretty-printed JSON
	 */
	public static String canonicalJson() {
		return MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(BUILT_INS);
	}
}
