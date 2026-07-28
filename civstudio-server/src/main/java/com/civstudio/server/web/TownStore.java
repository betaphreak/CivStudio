package com.civstudio.server.web;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

import org.springframework.stereotype.Component;

import com.civstudio.server.CivStudioProperties;
import com.civstudio.server.render.TownRecord;

/**
 * The <b>town layout store</b> — {@code docs/towngen-port.md} §3a, T7. One {@code json.gz} per site
 * per session, on the same persistent volume the plot cache uses.
 * <p>
 * <b>A layout is a world artifact, not a render cache</b> (the plan's decision, and the reason this
 * class exists rather than a {@code Map} in the controller). A dead colony's footprint is gone from
 * its {@code Settlement}, so a layout held only in memory could not be recomputed after a container
 * roll: the ruin §2a promises would silently vanish on the next deploy. On disk it outlives both the
 * colony and the JVM.
 * <p>
 * <b>Per session, and that settles the key collision.</b> Two sessions on the same seed found the
 * same site and must not overwrite each other's town. It also inherits the plot cache's discipline:
 * a {@link #TOWN_VERSION} bump invalidates every file the way {@code MAP_VERSION} does, so a
 * generator change cannot serve yesterday's shapes.
 * <p>
 * <b>Best-effort, like the plot cache.</b> A store that cannot write still serves — it just
 * recomputes next time. The one thing it must never do is fail a request over a file: a town is a
 * render feature, and §5.1's rule is that one may never take a session with it.
 */
@Component
public final class TownStore {

	/**
	 * The generator version. <b>Bump this whenever the layout's shape changes</b> — a new ward
	 * score, a different cutter, a moved constant — or a browser will be served a town the current
	 * code would not produce.
	 */
	public static final int TOWN_VERSION = 1;

	private static final tools.jackson.databind.ObjectMapper MAPPER =
			tools.jackson.databind.json.JsonMapper.builder().build();

	private final Path root;

	public TownStore(CivStudioProperties props) {
		this.root = Path.of(props.getPlots().getCacheDir()).resolve("towns").resolve("v" + TOWN_VERSION);
	}

	/**
	 * Read a site's stored layout.
	 *
	 * @param sessionId  the session
	 * @param provinceId the site
	 * @return the record, or {@code null} when nothing is stored (or what is stored is unreadable —
	 *         a corrupt file is a miss, not an error)
	 */
	public TownRecord read(String sessionId, int provinceId) {
		Path f = file(sessionId, provinceId);
		if (f == null || !Files.isRegularFile(f)) {
			return null;
		}
		try (GZIPInputStream in = new GZIPInputStream(Files.newInputStream(f))) {
			TownRecord rec = MAPPER.readValue(in.readAllBytes(), TownRecord.class);
			return rec != null && rec.version() == TOWN_VERSION ? rec : null;
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	/**
	 * Write a site's layout, replacing whatever was there.
	 *
	 * @param sessionId the session
	 * @param record    the layout to store
	 */
	public void write(String sessionId, TownRecord record) {
		Path f = file(sessionId, record.province());
		if (f == null) {
			return;
		}
		try {
			Files.createDirectories(f.getParent());
			ByteArrayOutputStream buf = new ByteArrayOutputStream();
			try (GZIPOutputStream gz = new GZIPOutputStream(buf)) {
				gz.write(MAPPER.writeValueAsBytes(record));
			}
			// written aside and moved into place, so a reader never sees half a layout
			Path tmp = Files.createTempFile(f.getParent(), record.province() + "-", ".part");
			Files.write(tmp, buf.toByteArray());
			try {
				Files.move(tmp, f, StandardCopyOption.ATOMIC_MOVE);
			} catch (IOException atomicUnsupported) {
				Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING);
			}
		} catch (IOException | RuntimeException e) {
			// best-effort: serving works either way, we just recompute next time
		}
	}

	/** How many layouts this session has on the volume — for the admin readout and the tests. */
	public int count(String sessionId) {
		Path dir = dir(sessionId);
		if (dir == null || !Files.isDirectory(dir)) {
			return 0;
		}
		try (var s = Files.list(dir)) {
			return (int) s.filter(p -> p.getFileName().toString().endsWith(".json.gz")).count();
		} catch (IOException e) {
			return 0;
		}
	}

	/** Drop every layout of one session — what a session's deletion should take with it. */
	public void drop(String sessionId) {
		Path dir = dir(sessionId);
		if (dir == null || !Files.isDirectory(dir)) {
			return;
		}
		try (var s = Files.list(dir)) {
			for (Path f : (Iterable<Path>) s::iterator) {
				Files.deleteIfExists(f);
			}
			Files.deleteIfExists(dir);
		} catch (IOException e) {
			// best-effort
		}
	}

	private Path dir(String sessionId) {
		String safe = safe(sessionId);
		return safe == null ? null : root.resolve(safe);
	}

	private Path file(String sessionId, int provinceId) {
		Path dir = dir(sessionId);
		return dir == null ? null : dir.resolve(provinceId + ".json.gz");
	}

	/**
	 * A session id as a directory name. Session ids are server-minted, but they reach here from a
	 * path variable, so anything that is not plainly a name is refused rather than sanitized — a
	 * store that quietly rewrites a traversal into something harmless is a store nobody audits
	 * again.
	 */
	private static String safe(String sessionId) {
		if (sessionId == null || sessionId.isBlank() || sessionId.length() > 128) {
			return null;
		}
		for (int i = 0; i < sessionId.length(); i++) {
			char c = sessionId.charAt(i);
			if (!Character.isLetterOrDigit(c) && c != '-' && c != '_') {
				return null;
			}
		}
		return sessionId;
	}
}
