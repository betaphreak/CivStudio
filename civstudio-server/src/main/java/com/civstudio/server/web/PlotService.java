package com.civstudio.server.web;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import com.civstudio.geo.Province;
import com.civstudio.geo.ProvinceRaster;
import com.civstudio.geo.TerrainRegistry;
import com.civstudio.geo.WorldMap;
import com.civstudio.server.CivStudioProperties;
import com.civstudio.server.SimPauseGate;
import com.civstudio.settlement.ProvincePlotPool;
import com.civstudio.settlement.ProvincePlotStore;
import com.civstudio.util.RngSeed;

/**
 * Serves a province's per-plot terrain grid, generated <b>on demand</b> and cached. A request for a
 * province not yet cached triggers {@link ProvincePlotPool#generate generation} of its canonical
 * (seed-independent) plot field — the expensive step, paid <b>once per province, ever</b> — under a
 * {@link SimPauseGate sim pause} so it never contends with the tick loops. The gzipped result is
 * cached to a persistent volume ({@code civstudio.plots.cache-dir}) and an in-memory LRU; later
 * requests (and restarts, via the volume) serve it straight back. See {@code docs/plot-serving.md}.
 * <p>
 * The bytes are the same gzip-JSON blob the old static {@code plots.pack} packed per province, so
 * the web viewer gunzips them exactly as before ({@code web/js/plots.mjs}).
 */
@Component
public final class PlotService {

	private final SimPauseGate pauseGate;
	private final Path cacheDir;

	// Generation context — session-independent, since a province's plot field is a property of the
	// map, not of a run (canonical, seed-independent terrain stream). Heavy loads stay lazy.
	private final TerrainRegistry registry = TerrainRegistry.load();
	private final RngSeed rngSeed = new RngSeed(0); // forProvinceCanonical ignores the seed
	private volatile WorldMap worldMap;
	private volatile ProvinceRaster raster;

	// one lock per province so concurrent requests for the same id coalesce onto one generation
	private final ConcurrentHashMap<Integer, Object> locks = new ConcurrentHashMap<>();
	// bounded LRU of hot gz blobs over the disk cache
	private final Map<Integer, byte[]> lru;

	// generation status, for the lobby warm-up readout (docs/plot-serving.md §Lobby progress)
	private volatile Integer generatingId;   // province currently generating, or null
	private volatile int cachedCount = -1;    // disk-cache file count, memoised for ~2s
	private volatile long cachedAt;

	public PlotService(SimPauseGate pauseGate, CivStudioProperties props) {
		this.pauseGate = pauseGate;
		// version the cache dir by the plot generation version — a bump points here at a fresh,
		// empty dir so every province regenerates lazily (the old version's dir is orphaned, not
		// served), matching the ?v= the client sends. See ProvincePlotStore.MAP_VERSION.
		this.cacheDir = Path.of(props.getPlots().getCacheDir()).resolve("v" + ProvincePlotStore.MAP_VERSION);
		int lruSize = Math.max(1, props.getPlots().getLruSize());
		this.lru = Collections.synchronizedMap(new LinkedHashMap<>(16, 0.75f, true) {
			@Override
			protected boolean removeEldestEntry(Map.Entry<Integer, byte[]> eldest) {
				return size() > lruSize;
			}
		});
	}

	/**
	 * The province's plot grid as its gzip-JSON blob (the bytes the web viewer gunzips), or
	 * {@code null} if there is no such province. Served from the LRU, then the disk cache, else
	 * generated on demand (under a sim pause) and cached. A province with no plottable land yields a
	 * (small) empty-grid blob, not null.
	 */
	public byte[] gz(int provinceId) {
		byte[] hot = lru.get(provinceId);
		if (hot != null)
			return hot;
		Object lock = locks.computeIfAbsent(provinceId, k -> new Object());
		synchronized (lock) {
			hot = lru.get(provinceId);
			if (hot != null)
				return hot;
			byte[] bytes = readDisk(provinceId);
			if (bytes == null) {
				bytes = generate(provinceId); // null → no such province
				if (bytes != null)
					writeDisk(provinceId, bytes);
			}
			if (bytes != null)
				lru.put(provinceId, bytes);
			return bytes;
		}
	}

	// generate the province's field (pausing the sim), or null if the id is not on the map
	private byte[] generate(int provinceId) {
		WorldMap wm = worldMap();
		if (!wm.hasProvince(provinceId))
			return null;
		Province p = wm.province(provinceId);
		generatingId = provinceId; // for the lobby readout
		try {
			return pauseGate.underPause(() -> {
				try {
					ProvincePlotPool pool = ProvincePlotPool.generate(p, registry, raster(),
							rngSeed.forProvinceCanonical(RngSeed.Stream.TERRAIN, provinceId));
					return ProvincePlotStore.toGzBytes(pool.plots(), pool.edge());
				} catch (IOException e) {
					throw new UncheckedIOException("failed to generate plots for province " + provinceId, e);
				}
			});
		} finally {
			generatingId = null;
		}
	}

	/**
	 * A snapshot of world-warm-up progress for the lobby readout ({@code docs/plot-serving.md}
	 * §Lobby progress): how many provinces' grids are cached, the total, and the province currently
	 * generating (or {@code null}).
	 */
	public PlotStatus status() {
		return new PlotStatus(countCached(), worldMap().provinces().size(), generatingId);
	}

	/** {@code cached} of {@code total} provinces' grids are on disk; {@code generating} or null. */
	public record PlotStatus(int cached, int total, Integer generating) {
	}

	/**
	 * Drop the whole plot cache — the in-memory LRU and every {@code <id>.json.gz} on the volume —
	 * so each province regenerates fresh on its next request (an admin op, e.g. after a change to
	 * plot generation; see {@code docs/urban-plots.md} / {@code docs/admin-console.md}). Returns the
	 * number of on-disk grids deleted.
	 */
	public int clear() {
		synchronized (lru) {
			lru.clear();
		}
		int deleted = 0;
		try (var s = Files.list(cacheDir)) {
			for (Path f : (Iterable<Path>) s.filter(f -> f.getFileName().toString().endsWith(".json.gz"))::iterator) {
				try {
					if (Files.deleteIfExists(f))
						deleted++;
				} catch (IOException ignored) {
					// best-effort; a locked/racing file is regenerated on next request anyway
				}
			}
		} catch (IOException e) {
			// cache dir not created yet — nothing to drop
		}
		cachedCount = -1; // force the next status() to re-scan
		return deleted;
	}

	/**
	 * Generate every plottable province's grid into the cache (a one-time world warm — see {@code
	 * docs/plot-serving.md}), so later visitors never trigger a cold, sim-pausing generation. Each
	 * miss generates under the sim pause; a province already cached is a cheap LRU/disk hit. Runs on
	 * the calling thread — the admin console runs it on a background virtual thread.
	 */
	public void warmAll() {
		for (Province p : worldMap().provinces())
			if (p.plots() > 0)
				gz(p.id());
	}

	// disk-cache file count, memoised for ~2s so a burst of lobby polls doesn't re-scan the dir
	private int countCached() {
		long now = System.currentTimeMillis();
		if (cachedCount >= 0 && now - cachedAt < 2000)
			return cachedCount;
		int n = 0;
		try (var s = Files.list(cacheDir)) {
			n = (int) s.filter(f -> f.getFileName().toString().endsWith(".json.gz")).count();
		} catch (IOException e) {
			n = 0; // cache dir not created yet
		}
		cachedCount = n;
		cachedAt = now;
		return n;
	}

	private byte[] readDisk(int provinceId) {
		Path f = cacheDir.resolve(provinceId + ".json.gz");
		try {
			return Files.isRegularFile(f) ? Files.readAllBytes(f) : null;
		} catch (IOException e) {
			return null; // a corrupt cache file reads as a miss → regenerate
		}
	}

	private void writeDisk(int provinceId, byte[] bytes) {
		try {
			Files.createDirectories(cacheDir);
			Path tmp = Files.createTempFile(cacheDir, provinceId + "-", ".part");
			Files.write(tmp, bytes);
			Path dest = cacheDir.resolve(provinceId + ".json.gz");
			try {
				Files.move(tmp, dest, StandardCopyOption.ATOMIC_MOVE);
			} catch (IOException atomicUnsupported) {
				Files.move(tmp, dest, StandardCopyOption.REPLACE_EXISTING);
			}
		} catch (IOException e) {
			// caching is best-effort; serving still works, we just regenerate next time
		}
	}

	private WorldMap worldMap() {
		WorldMap wm = worldMap;
		if (wm == null)
			synchronized (this) {
				wm = worldMap;
				if (wm == null)
					worldMap = wm = WorldMap.load();
			}
		return wm;
	}

	private ProvinceRaster raster() throws IOException {
		ProvinceRaster r = raster;
		if (r == null)
			synchronized (this) {
				r = raster;
				if (r == null)
					raster = r = ProvinceRaster.load();
			}
		return r;
	}
}
