package com.civstudio.scenario;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import org.junit.jupiter.api.Test;

import com.civstudio.data.WorldSource;

/**
 * {@link ScenarioRegistry} — foundable scenarios as data ({@code docs/studio-control-plane-plan.md}
 * workstream B): the compiled built-ins round-trip, content adds and overrides by key, an absent
 * resource is behaviour-neutral, and a malformed one is refused. Mirrors {@code BalanceProfilesTest}.
 */
class ScenarioRegistryTest {

	private static WorldSource sourceServing(String json) {
		return new WorldSource() {
			@Override
			public InputStream open(String path) {
				return ScenarioRegistry.RESOURCE.equals(path)
						? new ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8))
						: null;
			}

			@Override
			public boolean exists(String path) {
				return ScenarioRegistry.RESOURCE.equals(path);
			}
		};
	}

	private static final WorldSource EMPTY_SOURCE = new WorldSource() {
		@Override
		public InputStream open(String path) {
			return null;
		}

		@Override
		public boolean exists(String path) {
			return false;
		}
	};

	@Test
	void theBuiltInsRoundTripThroughJackson() {
		ScenarioRegistry reg = ScenarioRegistry.load(sourceServing(ScenarioRegistry.canonicalJson()));
		// the five the code founds today
		assertNotNull(reg.resolve("standard"));
		assertEquals(FoundingShape.STANDARD_COLONY, reg.resolve("caravan-demo").shape());
		assertEquals(FoundingShape.CAMP, reg.resolve("camp").shape());
		assertEquals(FoundingShape.TIMELINE, reg.resolve("timeline").shape());
		assertTrue(reg.resolve("camp").flag("homePlots", false), "camp founds on home plots");
		assertTrue(reg.resolve("hammers").flag("buildEconomy", false),
				"the hammers scenario founds with the build economy on");
	}

	@Test
	void contentAddsAndOverridesByKey() {
		// author a new scenario and re-point the demo at a different profile
		String json = "[";
		json += "{\"key\":\"aggressive\",\"label\":\"Aggressive\",\"blurb\":\"x\","
				+ "\"balanceProfile\":\"tuned\",\"shape\":\"STANDARD_COLONY\",\"flags\":{}},";
		json += "{\"key\":\"caravan-demo\",\"label\":\"Caravan Demo\",\"blurb\":\"y\","
				+ "\"balanceProfile\":\"tuned\",\"shape\":\"STANDARD_COLONY\",\"flags\":{}}";
		json += "]";

		ScenarioRegistry reg = ScenarioRegistry.load(sourceServing(json));
		assertNotNull(reg.resolve("aggressive"), "content adds a new scenario");
		assertEquals("tuned", reg.resolve("aggressive").balanceProfile());
		assertEquals("tuned", reg.resolve("caravan-demo").balanceProfile(),
				"content overrides a built-in by key");
		// the built-ins not named by content still stand
		assertNotNull(reg.resolve("timeline"));
	}

	@Test
	void anUnknownKeyResolvesToNullForTheHostToFallBack() {
		assertNull(ScenarioRegistry.load(EMPTY_SOURCE).resolve("no-such-scenario"),
				"resolve returns null on an unknown key — the host warns and founds standard");
	}

	@Test
	void anAbsentResourceLeavesTheBuiltInsAlone() {
		ScenarioRegistry reg = ScenarioRegistry.load(EMPTY_SOURCE);
		assertEquals(7, reg.all().size());
		assertNotNull(reg.resolve("timeline"));
		assertNotNull(reg.resolve("league-demo"), "the league the live demo founds");
	}

	@Test
	void aMalformedResourceIsRefusedRatherThanSilentlyIgnored() {
		IllegalStateException e = assertThrows(IllegalStateException.class,
				() -> ScenarioRegistry.load(sourceServing("{ not a list")));
		assertTrue(e.getMessage().contains(ScenarioRegistry.RESOURCE));
	}

	@Test
	void onlyTheStandardShapeIsHeadlessRunnable() {
		ScenarioRegistry reg = ScenarioRegistry.load(EMPTY_SOURCE);
		assertTrue(reg.resolve("standard").shape().headlessRunnable());
		assertTrue(!reg.resolve("camp").shape().headlessRunnable());
		assertTrue(!reg.resolve("timeline").shape().headlessRunnable());
	}
}
