package com.civstudio.server.web;

import java.lang.management.ManagementFactory;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import com.civstudio.geo.RegionEarthMap;
import com.civstudio.server.CivStudioProperties;
import com.civstudio.server.DemoSessionSeeder;
import com.civstudio.server.HostedSession;
import com.civstudio.server.SessionHost;
import com.civstudio.server.chat.ChatStore;
import com.civstudio.settlement.ProvincePlotStore;

import jakarta.servlet.http.HttpServletRequest;

/**
 * Admin-only server operations behind {@code /api/admin/**} — the backend for the admin console,
 * which now lives as homepage widgets in the Strapi admin (the {@code web/admin.html} page was
 * retired; {@code /} redirects there). Every endpoint is gated by {@link
 * CurrentUserResolver#isAdmin} (the existing {@code ROLE_ADMIN} / {@code civstudio.auth.admins}
 * allow-list); a non-admin gets {@code 403}. The widgets call these endpoints cross-origin (CORS
 * allows the {@code civstudio.com} sites with credentials) and read session state from the ordinary
 * {@code /api/sessions} endpoints (admins bypass the ownership check there). See {@code
 * docs/admin-console.md}.
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

	private final PlotService plots;
	private final CurrentUserResolver currentUser;
	private final CivStudioProperties props;
	private final SessionHost host;
	private final ChatStore chat;
	private final DemoSessionSeeder demo;

	public AdminController(PlotService plots, CurrentUserResolver currentUser,
			CivStudioProperties props, SessionHost host, ChatStore chat,
			DemoSessionSeeder demo) {
		this.plots = plots;
		this.currentUser = currentUser;
		this.props = props;
		this.host = host;
		this.chat = chat;
		this.demo = demo;
	}

	/** A consolidated admin readout: map cache status (+ generation version), server + identity. */
	@GetMapping("/status")
	public Map<String, Object> status(HttpServletRequest http) {
		requireAdmin(http);
		PlotService.PlotStatus ps = plots.status();
		Map<String, Object> plot = new LinkedHashMap<>();
		plot.put("cached", ps.cached());
		plot.put("total", ps.total());
		plot.put("mapVersion", ProvincePlotStore.MAP_VERSION);
		plot.put("generating", ps.generating());
		plot.put("storageUrl", props.getAdmin().getPlotCacheStorageUrl());

		Runtime rt = Runtime.getRuntime();
		Map<String, Object> server = new LinkedHashMap<>();
		server.put("uptimeMs", ManagementFactory.getRuntimeMXBean().getUptime());
		server.put("heapUsedMb", (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024));
		server.put("heapMaxMb", rt.maxMemory() / (1024 * 1024));
		server.put("sessions", host.list().size());
		server.put("admins", props.getAuth().getAdmins().size());
		server.put("you", currentUser.userId(http));

		Map<String, Object> out = new LinkedHashMap<>();
		out.put("plots", plot);
		out.put("server", server);
		return out;
	}

	/** Drop the whole plot cache (LRU + volume); provinces regenerate fresh on next request. */
	@PostMapping("/plots/clear")
	public Map<String, Object> clearPlots(HttpServletRequest http) {
		requireAdmin(http);
		return Map.of("cleared", plots.clear());
	}

	/**
	 * The bake-time region→Earth-country mapping — read-only reference data that drives plot
	 * place-naming ({@code PlaceNamingPass}). Editing it would require a full map re-bake (the
	 * regenerate-map pipeline) + server roll to take effect, so this only surfaces the current map.
	 */
	@GetMapping("/region-map")
	public Map<String, Object> regionMap(HttpServletRequest http) {
		requireAdmin(http);
		RegionEarthMap map = RegionEarthMap.load();
		List<Map<String, String>> entries = new ArrayList<>();
		for (String region : map.mappedRegions())
			entries.add(Map.of("region", region, "country", map.countryOf(region).orElse("")));
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("count", map.size());
		out.put("mapVersion", ProvincePlotStore.MAP_VERSION);
		out.put("entries", entries);
		return out;
	}

	/**
	 * Throw the running caravan demo away and deal a fresh one — same seed and province, day zero.
	 *
	 * <p>The shop window is the one run this is allowed for: it is a fixture, not anyone's record
	 * (see {@link DemoSessionSeeder#reseed()}). Spectators watching the old id will not find it in
	 * the list any more, so their client re-resolves to the new run on its next reconnect.
	 *
	 * @return the new session's id and clock state
	 */
	@PostMapping("/demo/restart")
	public Map<String, Object> restartDemo(HttpServletRequest http) {
		requireAdmin(http);
		HostedSession hs;
		try {
			hs = demo.reseed();
		} catch (IllegalStateException disabled) {
			throw new ResponseStatusException(HttpStatus.CONFLICT, disabled.getMessage());
		}
		return Map.of("id", hs.id(), "clockState", hs.clock().name());
	}

	/** Drop all lobby chat history (new/reloading spectators replay nothing). */
	@PostMapping("/chat/clear")
	public Map<String, Object> clearChat(HttpServletRequest http) {
		requireAdmin(http);
		chat.clearAll();
		return Map.of("cleared", true);
	}

	private void requireAdmin(HttpServletRequest http) {
		if (!currentUser.isAdmin(http))
			throw new ResponseStatusException(HttpStatus.FORBIDDEN, "admin only");
	}
}
