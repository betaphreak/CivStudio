package com.civstudio.server.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.civstudio.server.CivStudioProperties;
import com.civstudio.server.render.TownRecord;
import com.civstudio.server.render.TownView;

/**
 * The layout store ({@code docs/towngen-port.md} §3a, T7): a town is a world artifact on the
 * {@code .map} volume, not a cache in a JVM that a container roll takes with it.
 */
class TownStoreTest {

	private static TownStore store(Path dir) {
		CivStudioProperties props = new CivStudioProperties();
		props.getPlots().setCacheDir(dir.toString());
		return new TownStore(props);
	}

	private static TownRecord record(int province, int signature, String founded, String grown) {
		return new TownRecord(TownStore.TOWN_VERSION, province, "Nathalaire", signature, founded,
				grown, null, TownView.empty(province));
	}

	@Test
	void aLayoutSurvivesTheProcessThatWroteIt(@TempDir Path dir) {
		// the whole reason this is a file: a JVM cache cannot answer after a container roll, and the
		// ruin §2a promises would vanish on the next deploy
		store(dir).write("s1", record(451, 1234, "1444-12-11", "1445-03-02"));
		TownRecord back = store(dir).read("s1", 451);       // a DIFFERENT store instance
		assertNotNull(back);
		assertEquals(451, back.province());
		assertEquals(1234, back.signature());
		assertEquals("1444-12-11", back.founded());
		assertEquals("1445-03-02", back.grown());
		assertFalse(back.isRuin());
	}

	@Test
	void itIsGzippedJsonLikeTheProvinceData(@TempDir Path dir) throws Exception {
		store(dir).write("s1", record(451, 1, "1444-12-11", "1444-12-11"));
		Path f = dir.resolve("towns").resolve("v" + TownStore.TOWN_VERSION).resolve("s1")
				.resolve("451.json.gz");
		assertTrue(Files.isRegularFile(f), "one json.gz per site: " + f);
		byte[] head = Files.readAllBytes(f);
		assertEquals((byte) 0x1f, head[0], "gzip magic");
		assertEquals((byte) 0x8b, head[1]);
	}

	@Test
	void twoSessionsOnTheSameSeedDoNotOverwriteEachOther(@TempDir Path dir) {
		// the key collision §3a's per-session directory exists to settle: same seed, same site, two
		// runs — and two towns that have nothing to do with one another
		TownStore s = store(dir);
		s.write("run-a", record(451, 11, "1444-12-11", "1444-12-11"));
		s.write("run-b", record(451, 22, "1500-01-01", "1500-01-01"));
		assertEquals(11, s.read("run-a", 451).signature());
		assertEquals(22, s.read("run-b", 451).signature());
		assertEquals(1, s.count("run-a"));
	}

	@Test
	void aVersionBumpInvalidatesEveryFile(@TempDir Path dir) {
		// the plot cache's own discipline: a generator change must not serve yesterday's shapes
		TownStore s = store(dir);
		s.write("s1", new TownRecord(TownStore.TOWN_VERSION + 1, 451, "Nathalaire", 1, "1444-12-11",
				"1444-12-11", null, TownView.empty(451)));
		assertNull(s.read("s1", 451), "a record from another generator version is not readable");
	}

	@Test
	void aRuinKeepsItsShapeAndLearnsWhenItFell(@TempDir Path dir) {
		TownRecord live = record(451, 99, "1444-12-11", "1460-06-01");
		TownRecord ruin = live.ruinedOn("1487-09-14");
		assertTrue(ruin.isRuin());
		assertEquals("1487-09-14", ruin.ruined());
		assertEquals("1444-12-11", ruin.founded(), "it remembers when it was founded");
		assertEquals("1460-06-01", ruin.grown(), "and when it last grew");
		assertEquals(0, ruin.signature(), "a ruin has no live state to match against");
		assertSameRuin(ruin, ruin.ruinedOn("1500-01-01"));
	}

	@Test
	void aMissingOrCorruptFileIsAMissAndNotAFailure(@TempDir Path dir) throws Exception {
		TownStore s = store(dir);
		assertNull(s.read("s1", 451), "nothing stored");
		s.write("s1", record(451, 1, "1444-12-11", "1444-12-11"));
		Path f = dir.resolve("towns").resolve("v" + TownStore.TOWN_VERSION).resolve("s1")
				.resolve("451.json.gz");
		Files.write(f, "not gzip at all".getBytes());
		assertNull(s.read("s1", 451), "a corrupt layout regenerates rather than throwing");
	}

	@Test
	void aSessionIdThatIsNotPlainlyANameIsRefused(@TempDir Path dir) {
		// it arrives from a path variable; refusing beats sanitizing, because a store that quietly
		// rewrites a traversal into something harmless is a store nobody audits again
		TownStore s = store(dir);
		for (String bad : new String[] {"../etc", "a/b", "", null, "x:y"}) {
			s.write(bad, record(451, 1, "1444-12-11", "1444-12-11"));
			assertNull(s.read(bad, 451), "refused: " + bad);
			assertEquals(0, s.count(bad));
		}
	}

	@Test
	void aSessionsLayoutsCanBeDropped(@TempDir Path dir) {
		TownStore s = store(dir);
		s.write("s1", record(451, 1, "1444-12-11", "1444-12-11"));
		s.write("s1", record(4411, 2, "1444-12-11", "1444-12-11"));
		assertEquals(2, s.count("s1"));
		s.drop("s1");
		assertEquals(0, s.count("s1"));
		assertNull(s.read("s1", 451));
	}

	@Test
	void matchingIsBothVersionAndSignature(@TempDir Path dir) {
		TownRecord r = record(451, 77, "1444-12-11", "1444-12-11");
		assertTrue(r.matches(TownStore.TOWN_VERSION, 77));
		assertFalse(r.matches(TownStore.TOWN_VERSION, 78), "the town changed");
		assertFalse(r.matches(TownStore.TOWN_VERSION + 1, 77), "the generator changed");
		assertNotEquals(r.signature(), 78);
	}

	private static void assertSameRuin(TownRecord a, TownRecord b) {
		assertEquals(a.ruined(), b.ruined(), "the date it fell is stamped once and never again");
	}
}
