package com.civstudio.server;

import java.util.ArrayList;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Externalized server configuration (bound from {@code application.yml} / environment under the
 * {@code civstudio.*} prefix). Replaces the ad-hoc {@code $PORT} / {@code EOS_CORS_ORIGINS} env
 * parsing the old {@code ServerMain}/{@code FeedServer} did by hand.
 */
@ConfigurationProperties("civstudio")
public class CivStudioProperties {

	private final Demo demo = new Demo();
	private final Cors cors = new Cors();
	private final Auth auth = new Auth();
	private final Anbennar anbennar = new Anbennar();
	private final Plots plots = new Plots();
	private final Dev dev = new Dev();
	private final Admin admin = new Admin();
	private final WorldSource worldSource = new WorldSource();

	public WorldSource getWorldSource() {
		return worldSource;
	}

	public Demo getDemo() {
		return demo;
	}

	public Dev getDev() {
		return dev;
	}

	public Plots getPlots() {
		return plots;
	}

	public Admin getAdmin() {
		return admin;
	}

	public Cors getCors() {
		return cors;
	}

	public Auth getAuth() {
		return auth;
	}

	public Anbennar getAnbennar() {
		return anbennar;
	}

	private final Lore lore = new Lore();

	public Lore getLore() {
		return lore;
	}

	/**
	 * The lore chatbot (P5, {@code docs/lore-chatbot-plan.md}). Opt-in: {@code LoreConfig} wires the
	 * {@code /api/lore/**} endpoints only when {@code datasource-url} is set — the pgvector DB holding
	 * {@code wiki_chunk} ({@code civstudio-postgres} on prod, the {@code civ-pgv} Docker container
	 * locally). Question embeddings come from a self-hosted TEI at {@code tei-url}; the grounded answer
	 * from Claude via {@code anthropic-key} (bind to the {@code ANTHROPIC_API_KEY} env). With no
	 * datasource the endpoints are absent and the server is unaffected.
	 */
	public static class Lore {
		private String datasourceUrl = "";
		private String datasourceUsername = "";
		private String datasourcePassword = "";
		private String teiUrl = "http://localhost:8085/embed";
		private String anthropicKey = "";
		private String model = "claude-haiku-4-5";
		private int searchK = 8;

		public String getDatasourceUrl() { return datasourceUrl; }
		public void setDatasourceUrl(String v) { this.datasourceUrl = v; }
		public String getDatasourceUsername() { return datasourceUsername; }
		public void setDatasourceUsername(String v) { this.datasourceUsername = v; }
		public String getDatasourcePassword() { return datasourcePassword; }
		public void setDatasourcePassword(String v) { this.datasourcePassword = v; }
		public String getTeiUrl() { return teiUrl; }
		public void setTeiUrl(String v) { this.teiUrl = v; }
		public String getAnthropicKey() { return anthropicKey; }
		public void setAnthropicKey(String v) { this.anthropicKey = v; }
		public String getModel() { return model; }
		public void setModel(String v) { this.model = v; }
		public int getSearchK() { return searchK; }
		public void setSearchK(int v) { this.searchK = v; }
	}

	/**
	 * The canonical upstream source of the Anbennar EU4 mod files (map rasters + Clausewitz
	 * metadata) that the engine reads on demand — the sim's runtime plot generation
	 * ({@code ProvinceRaster}) and the dev-time exporters. These files are <b>not</b> vendored in
	 * the repo: they are downloaded individually, when needed, from this source (pinned to
	 * {@link #ref}) and cached under {@link #cacheDir}. The engine owns the fetch/cache
	 * ({@code com.civstudio.data.AnbennarFiles}); this Spring config is pushed into it at server
	 * startup so a deployment can override the source. See {@code docs/anbennar-files.md} and the
	 * {@code anbennar-canonical-source} note.
	 */
	public static class Anbennar {
		/** The mod's canonical git host (GitLab, not GitHub). Raw files are fetched from here. */
		private String baseUrl = "https://gitlab.com/anbennar/anbennar-eu4-dev";
		/**
		 * Overrides the committed source lock (the SHA the derived {@code map/*.json} resources were
		 * built from) for ad-hoc/testing fetches. Normally left at this default and bumped via the
		 * refresh workflow, not per-deployment — runtime fetch must match the committed resources, so
		 * changing only this without regenerating them yields an inconsistent world. The mod tracks
		 * {@code new-master}; this is a specific locked tip. See {@code docs/anbennar-files.md}
		 * §Staying current with upstream.
		 */
		private String ref = "";
		/**
		 * Local on-disk cache root for downloaded files. Files are stored under
		 * {@code <cacheDir>/<ref>/<mod-relative-path>} so bumping {@link #ref} naturally invalidates
		 * the cache. Defaults to a gitignored working-dir folder for local dev; the deployment points
		 * it at a <b>mounted volume</b> (env {@code ANBENNAR_CACHE_DIR}) so downloads persist across
		 * container restarts/replicas. See {@code docs/anbennar-files.md} §Runtime.
		 */
		private String cacheDir = ".anbennar-cache";

		/**
		 * Optional GitLab access token (env {@code ANBENNAR_TOKEN}, a deployment secret — never
		 * committed). Sent as the {@code PRIVATE-TOKEN} header on fetches + tree listings to use the
		 * authenticated rate limit instead of the anonymous one. Blank by default: the mod repo is
		 * public, so anonymous fetch works but is rate-limited (matters for the directory-walking
		 * exporters). A read-only scope ({@code read_api} / {@code read_repository}) is enough.
		 */
		private String token = "";

		public String getBaseUrl() {
			return baseUrl;
		}

		public void setBaseUrl(String baseUrl) {
			this.baseUrl = baseUrl;
		}

		public String getRef() {
			return ref;
		}

		public void setRef(String ref) {
			this.ref = ref;
		}

		public String getCacheDir() {
			return cacheDir;
		}

		public void setCacheDir(String cacheDir) {
			this.cacheDir = cacheDir;
		}

		public String getToken() {
			return token;
		}

		public void setToken(String token) {
			this.token = token;
		}
	}

	/**
	 * Per-province plot serving (see {@code docs/plot-serving.md}). The server generates a
	 * province's plot grid on demand ({@code GET /api/plots/{id}}), pausing the sim while it does
	 * so, and caches the gzipped result under {@link #cacheDir} (+ an in-memory LRU of
	 * {@link #lruSize} provinces). Generation is the (once-per-province) expensive step; serving
	 * from the cache is trivial.
	 */
	public static class Plots {
		/**
		 * Local on-disk cache root for generated plot grids ({@code <cacheDir>/<id>.json.gz}).
		 * Defaults to a gitignored working-dir folder for local dev; the deployment points it at a
		 * <b>persistent mounted volume</b> (env {@code PLOT_CACHE_DIR}) so a province is generated
		 * once ever, not once per container restart.
		 */
		private String cacheDir = ".map";
		/** How many provinces' gz blobs to keep hot in memory (an LRU over the disk cache). */
		private int lruSize = 512;

		public String getCacheDir() {
			return cacheDir;
		}

		public void setCacheDir(String cacheDir) {
			this.cacheDir = cacheDir;
		}

		public int getLruSize() {
			return lruSize;
		}

		public void setLruSize(int lruSize) {
			this.lruSize = lruSize;
		}
	}

	/**
	 * Admin-console config (the {@code /api/admin/**} backend). The console UI itself now lives as
	 * homepage widgets in the Strapi admin (see {@link #consoleUrl}); the retired {@code
	 * web/admin.html} page has been replaced by a redirect from {@code /}.
	 */
	public static class Admin {
		/**
		 * An optional deep link to the map cache location, surfaced (only) in the gated
		 * {@code /api/admin/status} for an "Open in Storage Explorer" button. An Azure Storage
		 * Explorer {@code storageexplorer://…} URI (or a portal storage-browser URL). Carries the
		 * subscription / resource ids, so it is served from config (env
		 * {@code CIVSTUDIO_ADMIN_PLOTCACHESTORAGEURL}) rather than hard-coded in the public HTML.
		 * Blank (the default) hides the button.
		 */
		private String plotCacheStorageUrl = "";

		/**
		 * Where {@code GET /} redirects now that the admin console lives in the Strapi admin — the
		 * Strapi Homepage that hosts the CivStudio ops widgets (env {@code CIVSTUDIO_ADMIN_CONSOLEURL}).
		 * Those widgets call this server's {@code /api/admin/**} + {@code /api/sessions/**} cross-origin
		 * (CORS already allows the {@code civstudio.com} sites with credentials).
		 */
		private String consoleUrl = "https://civstudio.com/admin";

		public String getPlotCacheStorageUrl() {
			return plotCacheStorageUrl;
		}

		public void setPlotCacheStorageUrl(String plotCacheStorageUrl) {
			this.plotCacheStorageUrl = plotCacheStorageUrl;
		}

		public String getConsoleUrl() {
			return consoleUrl;
		}

		public void setConsoleUrl(String consoleUrl) {
			this.consoleUrl = consoleUrl;
		}
	}

	/**
	 * Local-development conveniences, active only under the {@code dev} Spring profile (which
	 * {@code mvn spring-boot:run} activates via the {@code spring-boot-maven-plugin} config). Off in
	 * the packaged production jar. Drives {@link com.civstudio.server.dev.DevFrontendLauncher}, which
	 * — once the server is fully started — serves the {@code web/} site with a small zero-dependency
	 * node server ({@code web/dev-server.mjs}) and opens it in the default browser, pointed at this
	 * server for {@code window.BUNDLE} (?live=…). Everything here works with no internet connection
	 * (the mod sources resolve from the local caches).
	 */
	public static class Dev {
		private final Frontend frontend = new Frontend();

		public Frontend getFrontend() {
			return frontend;
		}

		/** The auto-launched node frontend server (see {@link Dev}). */
		public static class Frontend {
			/** Master switch — launch the node frontend alongside the server. */
			private boolean enabled = true;
			/** Port the node static server listens on (the page origin). */
			private int webPort = 3000;
			/** The node executable (on PATH, or an absolute path). */
			private String node = "node";
			/**
			 * The path + query the frontend URL is logged with, appended to the frontend origin
			 * ({@code http://localhost:<webPort>}). Placeholders are substituted: {@code {live}} →
			 * {@code http://localhost:<serverPort>} (this server, for {@code ?live=}), {@code {server}}
			 * → the server port, {@code {webPort}} → the frontend port. Defaults to the plain live
			 * view. For test use, set a webverify-style deep link to land on a province/zoom/overlay,
			 * e.g. {@code --civstudio.dev.frontend.open-path=/?p=4411&z=150&live={live}#none} (the same
			 * URL shape {@code tools/webverify/*.mjs} build). Nothing opens it for you — it is printed.
			 */
			private String openPath = "/?live={live}";

			public boolean isEnabled() {
				return enabled;
			}

			public void setEnabled(boolean enabled) {
				this.enabled = enabled;
			}

			public int getWebPort() {
				return webPort;
			}

			public void setWebPort(int webPort) {
				this.webPort = webPort;
			}

			public String getNode() {
				return node;
			}

			public void setNode(String node) {
				this.node = node;
			}

			public String getOpenPath() {
				return openPath;
			}

			public void setOpenPath(String openPath) {
				this.openPath = openPath;
			}
		}
	}

	/** The caravan-demo session founded on startup (see {@link DemoSessionSeeder}). */
	public static class Demo {
		/** Whether to found the demo session at boot (the live deployment relies on it). */
		private boolean enabled = true;
		/** The session seed (reproducibility root). */
		private long seed = 7654321L;
		/**
		 * The world-map province the demo colony founds into — <b>Nathalaire</b> (451), the pirate
		 * city on the Sea of Follies. Chosen because we have a hand-drawn reference for it
		 * ({@code tools/samples/nathalaire.png}, {@code docs/towngen-port.md} §2c), so what the
		 * generator produces can be held against what the place is supposed to look like.
		 */
		private int provinceId = 451;
		/** Wall-clock milliseconds per tick — ~one in-game day per second. */
		private long tickRateMillis = 1000L;

		public boolean isEnabled() {
			return enabled;
		}

		public void setEnabled(boolean enabled) {
			this.enabled = enabled;
		}

		public long getSeed() {
			return seed;
		}

		public void setSeed(long seed) {
			this.seed = seed;
		}

		public int getProvinceId() {
			return provinceId;
		}

		public void setProvinceId(int provinceId) {
			this.provinceId = provinceId;
		}

		public long getTickRateMillis() {
			return tickRateMillis;
		}

		public void setTickRateMillis(long tickRateMillis) {
			this.tickRateMillis = tickRateMillis;
		}
	}

	/**
	 * Authentication / ownership config (see {@code docs/authentication.md}). Phase 1 ships the
	 * ownership plumbing without a login provider yet; {@link #trustDevUserHeader} is the only
	 * knob — a development/test seam for supplying the caller's identity before real login lands.
	 */
	public static class Auth {
		/**
		 * When {@code true}, {@link com.civstudio.server.web.CurrentUserResolver} trusts the
		 * {@code X-CivStudio-User} request header as the caller's user id. This is a
		 * <b>development/test-only</b> fallback used only when there is no logged-in
		 * {@code SecurityContext} (a spoofable header must never be trusted in production) and stays
		 * {@code false} by default.
		 */
		private boolean trustDevUserHeader = false;

		/**
		 * Operator allow-list (env {@code CIVSTUDIO_AUTH_ADMINS}, comma-separated). An entry may be
		 * a user's provider subject (a SteamID64, a Google {@code sub}), a {@code provider:subject}
		 * pair, an OIDC email, or an {@code app_user} id — a signed-in user matching any form is
		 * granted {@code ROLE_ADMIN} and may control/command <em>any</em> session (bypassing
		 * ownership). Matched case-insensitively. See {@code docs/authentication.md}.
		 */
		private List<String> admins = new ArrayList<>();

		private final Steam steam = new Steam();
		private final Google google = new Google();
		private final RememberMe rememberMe = new RememberMe();

		public boolean isTrustDevUserHeader() {
			return trustDevUserHeader;
		}

		public void setTrustDevUserHeader(boolean trustDevUserHeader) {
			this.trustDevUserHeader = trustDevUserHeader;
		}

		public List<String> getAdmins() {
			return admins;
		}

		public void setAdmins(List<String> admins) {
			this.admins = admins;
		}

		public Steam getSteam() {
			return steam;
		}

		public Google getGoogle() {
			return google;
		}

		public RememberMe getRememberMe() {
			return rememberMe;
		}

		/**
		 * "Remember me" persistent login (env {@code CIVSTUDIO_AUTH_REMEMBER_ME_KEY}). With {@link #key}
		 * set to a stable secret, a signed remember-me cookie keeps a user logged in across server
		 * restarts/redeploys — the in-memory HTTP session is lost on a redeploy, but the cookie
		 * re-authenticates the user from the durable {@link UserStore}. Blank (the default) disables it
		 * entirely, so local dev and tests are unaffected. The key MUST stay constant across deploys —
		 * rotating it invalidates every outstanding cookie (everyone is logged out once).
		 */
		public static class RememberMe {
			/** The HMAC signing key; blank disables remember-me. Keep secret and stable across deploys. */
			private String key = "";
			/** Cookie lifetime, in days. */
			private int validityDays = 30;

			public String getKey() {
				return key;
			}

			public void setKey(String key) {
				this.key = key;
			}

			public int getValidityDays() {
				return validityDays;
			}

			public void setValidityDays(int validityDays) {
				this.validityDays = validityDays;
			}
		}

		/**
		 * Google OIDC (a secondary sign-in provider — see {@code docs/authentication.md} phase 3).
		 * Entirely opt-in: the OAuth2 login flow is wired only when {@link #clientId} is set (see
		 * {@code GoogleOAuthConfig}), so the server runs Steam-only by default.
		 */
		public static class Google {
			/**
			 * Master switch for Google sign-in (env {@code CIVSTUDIO_AUTH_GOOGLE_ENABLED=true}). A
			 * dedicated dash-free flag rather than gating on {@code client-id} directly, because
			 * {@code @ConditionalOnProperty} does not reliably match a kebab-case property against the
			 * underscore env-var form ({@code CIVSTUDIO_AUTH_GOOGLE_CLIENT_ID}). Set this plus the
			 * client id/secret to turn Google on.
			 */
			private boolean enabled = false;
			/** The Google OAuth2 client id (env {@code CIVSTUDIO_AUTH_GOOGLE_CLIENT_ID}). */
			private String clientId = "";
			/** The Google OAuth2 client secret (env {@code CIVSTUDIO_AUTH_GOOGLE_CLIENT_SECRET}). */
			private String clientSecret = "";
			/**
			 * The redirect URI registered in the Google console. Defaults to the Spring template
			 * {@code {baseUrl}/login/oauth2/code/google} (correct once forwarded headers are honored —
			 * see {@code application.yml}); override to an absolute URL if needed.
			 */
			private String redirectUri = "{baseUrl}/login/oauth2/code/google";

			public boolean isEnabled() {
				return enabled;
			}

			public void setEnabled(boolean enabled) {
				this.enabled = enabled;
			}

			public String getClientId() {
				return clientId;
			}

			public void setClientId(String clientId) {
				this.clientId = clientId;
			}

			public String getClientSecret() {
				return clientSecret;
			}

			public void setClientSecret(String clientSecret) {
				this.clientSecret = clientSecret;
			}

			public String getRedirectUri() {
				return redirectUri;
			}

			public void setRedirectUri(String redirectUri) {
				this.redirectUri = redirectUri;
			}
		}

		/** Steam "Sign in through Steam" (OpenID 2.0) config — the default sign-in provider. */
		public static class Steam {
			/**
			 * The OpenID realm = this server's public origin (e.g. {@code
			 * https://dev.civstudio.com}). Optional: when blank the realm is derived from the
			 * request, which is correct for local runs but may be wrong behind a proxy — set it in
			 * production (env {@code CIVSTUDIO_AUTH_STEAM_REALM}).
			 */
			private String realm = "";

			/**
			 * The Steam Web API key used to enrich the persona name / avatar after sign-in
			 * (optional; sign-in works without it — the SteamID is used as the display name).
			 */
			private String apiKey = "";

			public String getRealm() {
				return realm;
			}

			public void setRealm(String realm) {
				this.realm = realm;
			}

			public String getApiKey() {
				return apiKey;
			}

			public void setApiKey(String apiKey) {
				this.apiKey = apiKey;
			}
		}
	}

	/**
	 * Cross-origin config: the static map site (Static Web Apps) calls this server (a Container
	 * App) from a different origin. Any {@code localhost} port is additionally allowed for local
	 * development (see {@link WebConfig}). Override via {@code EOS_CORS_ORIGINS} (comma-separated).
	 */
	public static class Cors {
		private List<String> origins = new ArrayList<>(List.of(
				"https://anbennar.civstudio.com", "https://civstudio.com",
				"https://www.civstudio.com"));

		public List<String> getOrigins() {
			return origins;
		}

		public void setOrigins(List<String> origins) {
			this.origins = origins;
		}
	}

	/**
	 * Which {@link com.civstudio.data.WorldSource} the engine boots its invariant world data from
	 * (studio-datamodel-rebuild Phase 4). Bound under {@code civstudio.world-source.*}, but the source
	 * is actually INSTALLED very early by {@code WorldSourceInitializer} (an
	 * {@code ApplicationEnvironmentPreparedEvent} listener reading the same keys off the Environment),
	 * because it must run before any engine world-data class loads — {@code UnitCatalog} is an eager
	 * static singleton that captures the source at class-load. This bound copy exists for documentation
	 * and for beans that want to read the choice.
	 */
	public static class WorldSource {
		/** {@code classpath} (default — committed {@code generated/*.json}) | {@code strapi} (GET the
		 *  world bundle) | {@code fixture} (a saved snapshot). */
		private String mode = "classpath";
		/** {@code strapi} mode: the studio world-bundle URL. */
		private String url = "http://localhost:1337/api/world-bundle";
		/** {@code strapi} mode: bearer token for the world bundle ({@code WORLD_BUNDLE_TOKEN}); blank = none. */
		private String token = "";
		/** {@code fixture} mode: path to a saved bundle snapshot ({@code .json} / {@code .json.gz}). */
		private String fixture = "";

		public String getMode() {
			return mode;
		}

		public void setMode(String mode) {
			this.mode = mode;
		}

		public String getUrl() {
			return url;
		}

		public void setUrl(String url) {
			this.url = url;
		}

		public String getToken() {
			return token;
		}

		public void setToken(String token) {
			this.token = token;
		}

		public String getFixture() {
			return fixture;
		}

		public void setFixture(String fixture) {
			this.fixture = fixture;
		}
	}
}
