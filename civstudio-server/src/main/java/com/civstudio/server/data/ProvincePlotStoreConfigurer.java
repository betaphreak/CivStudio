package com.civstudio.server.data;

import java.io.File;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import com.civstudio.server.CivStudioProperties;
import com.civstudio.settlement.ProvincePlotStore;

/**
 * Points the engine's {@link ProvincePlotStore} (the sim's per-province plot-field cache used by
 * colony founding and caravan crossings) at the same {@code civstudio.plots.cache-dir} the server's
 * on-demand {@link com.civstudio.server.web.PlotService} uses — so the sim and the web plot feed
 * share <b>one</b> cache ({@code <cache-dir>/v<MAP_VERSION>}) instead of the sim writing a second
 * copy into the source tree. Mirrors {@link AnbennarSourceConfigurer}: configured in the
 * constructor, which runs during context refresh, before {@code DemoSessionSeeder} founds a session
 * and triggers plot generation. In prod this is the persistent volume, so a province is generated
 * once ever and reused by both. See {@code docs/plot-serving.md}.
 * <p>
 * It also <b>reports whether the cache for this build's {@code MAP_VERSION} is actually there</b>.
 * A missing version dir is not a crash — the store regenerates each province on demand and writes it
 * back, so the server still works — which is exactly why it needs saying out loud: the symptom is
 * "the map is slow", minutes after a deploy, with nothing in the log tying it to a rebake that never
 * ran. The matching pre-roll guard is {@code Assert-PlotCacheBaked} in {@code tools/deploy-server.ps1}.
 */
@Component
public class ProvincePlotStoreConfigurer {

	private static final Logger log = LoggerFactory.getLogger(ProvincePlotStoreConfigurer.class);

	/** Below this many province files the cache is a partial upload rather than a baked world. */
	private static final int EXPECTED_PROVINCE_FILES = 4000;

	public ProvincePlotStoreConfigurer(CivStudioProperties props) {
		ProvincePlotStore.configure(props.getPlots().getCacheDir());
		reportCacheState();
	}

	private void reportCacheState() {
		File dir = ProvincePlotStore.writeDir();
		int version = ProvincePlotStore.MAP_VERSION;
		if (!dir.isDirectory()) {
			log.error("PLOT CACHE MISSING: no baked cache at {} for MAP_VERSION {}. Every province will be"
					+ " generated on demand and written back — the map will be slow and the volume will fill"
					+ " with plots this build generated itself. Run the 'Regenerate map' workflow, then roll"
					+ " the server again.", dir.getAbsolutePath(), version);
			return;
		}
		String[] files = dir.list((d, name) -> name.endsWith(".json.gz"));
		int count = files == null ? 0 : files.length;
		if (count < EXPECTED_PROVINCE_FILES)
			log.warn("PLOT CACHE INCOMPLETE: {} holds {} province files for MAP_VERSION {} (a full world is"
					+ " ~5000). Likely an interrupted upload; the missing provinces will be generated on"
					+ " demand.", dir.getAbsolutePath(), count, version);
		else
			log.info("plot cache ready: {} province files at {} (MAP_VERSION {})",
					count, dir.getAbsolutePath(), version);
	}
}
