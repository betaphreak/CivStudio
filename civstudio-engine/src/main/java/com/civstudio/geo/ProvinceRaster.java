package com.civstudio.geo;

import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import javax.imageio.ImageIO;

import com.civstudio.data.AnbennarFiles;

/**
 * Reads a single province's pixel {@link ProvinceMask silhouette} from the
 * committed Anbennar rasters under {@code data/} ({@code definition.csv} for the
 * colour↔id map, {@code provinces.bmp} for the shapes, {@code rivers.bmp} for
 * water), on demand. This is the runtime counterpart to the build-time {@link
 * com.civstudio.geo.export.ProvinceExporter} — where the exporter scans the whole
 * map to summarise every province, this loads <em>one</em> province's mask so its
 * plot field can be generated when a settlement first needs it (see {@code
 * docs/province-plots.md}).
 * <p>
 * The {@code definition.csv} id→colour map is parsed up front (cheap); the two
 * BMP pixel arrays are loaded lazily on the first {@link #mask(int)} call and
 * cached, so repeated province lookups in one session pay the ~46&nbsp;MB read
 * once. The raster files are not vendored — they are fetched on demand through
 * {@link AnbennarFiles} (pinned + cached; see {@code docs/anbennar-files.md}).
 */
public final class ProvinceRaster {

	private static final String DEFINITIONS = "map/definition.csv";
	private static final String PROVINCES_BMP = "map/provinces.bmp";
	private static final String RIVERS_BMP = "map/rivers.bmp";
	private static final String TERRAIN_BMP = "map/terrain.bmp";
	private static final String TREES_BMP = "map/trees.bmp";
	private static final String HEIGHTMAP_BMP = "map/heightmap.bmp";
	private static final String DEFAULT_MAP = "map/default.map";

	private final Map<Integer, Integer> idToColor;
	// the pixel colours of water (SEA/LAKE) provinces, from default.map's sea_starts + lakes
	// blocks — for coastline detection (docs/coastlines.md §A). Built once in ensureRaster.
	private Set<Integer> waterColors;

	// lazily loaded raster (cached after the first mask() call)
	private int[] pixels;
	private int[] river;
	private int width;
	private int height;

	// the real EU4 terrain/tree overlays (8-bit indexed): terrainIdx is full
	// resolution (1:1 with the province raster); treeIdx is the smaller trees.bmp,
	// sampled by scaling province coordinates into it (see treeIndexAt). Both are
	// optional — a missing file leaves the array null and the mask falls back.
	private int[] terrainIdx;
	private int[] treeIdx;
	private int treeWidth;
	private int treeHeight;
	// the real heightmap.bmp elevation (8-bit grayscale, full resolution 1:1 with the
	// province raster; the palette index equals the height). Optional — null if absent.
	private int[] heightIdx;
	// the downstream flow direction of every river pixel (1..8, 0 = none/mouth), computed
	// once over the whole river raster by RiverFlow (docs/river-rendering.md §3). Global on
	// purpose: a cell's true downstream neighbour may lie in an adjacent province.
	private byte[] riverFlow;
	// the drainage accumulation of every river pixel — how many cells drain through it, 1 at a
	// headwater and growing seaward. The render width signal (docs/river-rendering.md §4);
	// global for the same reason as riverFlow (a tributary may join from the next province).
	private int[] riverAcc;
	// the Chebyshev distance (in pixels) from every cell to the nearest dry-land pixel: 0 on
	// land, 1 for a water pixel touching land, growing out to sea. Computed once over the whole
	// raster (two chamfer passes). Global on purpose: a coastal shelf cell of a sea province is
	// classified COAST/SEA by how far it sits from land in ANY adjacent province — see the
	// coastal-shelf water plots in ProvincePlotField (docs/coastlines.md).
	private int[] landDistance;

	/** Whether {@link #ensureRaster()} ran to completion — the ONLY safe "already loaded" signal. */
	private volatile boolean rasterLoaded;

	private ProvinceRaster(Map<Integer, Integer> idToColor) {
		this.idToColor = idToColor;
	}

	/** Load the {@code definition.csv} id→colour map (the BMPs load on first use). */
	public static ProvinceRaster load() throws IOException {
		Map<Integer, Integer> idToColor = new HashMap<>();
		try (BufferedReader br = new BufferedReader(new InputStreamReader(
				Files.newInputStream(AnbennarFiles.get(DEFINITIONS)), StandardCharsets.UTF_8))) {
			br.readLine(); // header
			String line;
			while ((line = br.readLine()) != null) {
				line = line.trim();
				if (line.isEmpty() || line.startsWith("#"))
					continue;
				String[] parts = line.split(";", -1);
				if (parts.length < 5)
					continue;
				try {
					int id = Integer.parseInt(parts[0].trim());
					int r = Integer.parseInt(parts[1].trim());
					int g = Integer.parseInt(parts[2].trim());
					int b = Integer.parseInt(parts[3].trim());
					idToColor.put(id, (r << 16) | (g << 8) | b);
				} catch (NumberFormatException ignored) {
					// malformed row — skip
				}
			}
		}
		return new ProvinceRaster(idToColor);
	}

	/**
	 * How many pixels of <b>neighbouring</b> land the mask carries around the province's own
	 * bounding box — its {@linkplain ProvinceMask#isGround halo}. Every spatial generator probes
	 * neighbours through the mask, so without a halo a province border reads as ocean and each
	 * stage breaks at the seam (vegetation seeds along the outline, peaks never grow within a
	 * pixel of it, de-speckling has nothing to smooth against). 8 covers the widest neighbourhood
	 * any stage reads (the C2C peak scoring's 5×5 plus its spread) with room to spare. See
	 * {@code docs/plot-generator.md} §Seamless generation.
	 */
	public static final int HALO = 8;

	/**
	 * The pixel mask of the province with this {@code province_id}: its own land cells
	 * (pixels of its colour) and their river flags, framed to its bounding box grown by
	 * {@link #HALO} pixels of context. Cells of <em>other</em> land provinces inside that
	 * frame are marked {@linkplain ProvinceMask#isGround ground} (but not
	 * {@linkplain ProvinceMask#isLand own}), so the generators see real neighbouring land
	 * instead of ocean; every raster overlay (terrain / trees / elevation / river / coast /
	 * land distance) is filled across the whole frame for the same reason.
	 *
	 * @param provinceId the game province id
	 * @return the province's mask
	 * @throws IllegalArgumentException if the id has no colour in {@code definition.csv}
	 * @throws IllegalStateException    if the province has no pixels on the map
	 */
	public ProvinceMask mask(int provinceId) throws IOException {
		Integer color = idToColor.get(provinceId);
		if (color == null)
			throw new IllegalArgumentException("no colour for province " + provinceId);
		ensureRaster();

		int target = color;
		int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE;
		int maxX = Integer.MIN_VALUE, maxY = Integer.MIN_VALUE;
		boolean any = false;
		for (int y = 0; y < height; y++) {
			for (int x = 0; x < width; x++) {
				if ((pixels[y * width + x] & 0xFFFFFF) != target)
					continue;
				any = true;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
		if (!any)
			throw new IllegalStateException("province " + provinceId + " has no pixels");

		// grow the frame by the halo, clamped to the raster (no E-W wrap — the map is a finite
		// sheet since the realm split, see docs/realms.md)
		minX = Math.max(0, minX - HALO);
		minY = Math.max(0, minY - HALO);
		maxX = Math.min(width - 1, maxX + HALO);
		maxY = Math.min(height - 1, maxY + HALO);

		int w = maxX - minX + 1;
		int h = maxY - minY + 1;
		boolean[] landGrid = new boolean[w * h];   // this province's own pixels — one plot each
		boolean[] groundGrid = new boolean[w * h]; // any land pixel (own or a neighbour's) — context
		int[] riverGrid = new int[w * h];
		int[] coastGrid = new int[w * h]; // 8-bit water-neighbour mask (edges + corners) per land cell
		// per-cell EU4 terrain/tree palette indices, framed to the same bounding box
		// (-1 where the overlay is absent or out of bounds — the mask treats it as
		// "unmapped" and the plot field falls back to climate generation)
		int[] terrainGrid = new int[w * h];
		int[] treeGrid = new int[w * h];
		int[] elevationGrid = new int[w * h]; // 0 (sea level) where the heightmap is absent
		int[] landDistGrid = new int[w * h];  // Chebyshev pixels to dry land (0 on land) — shelf classifier
		java.util.Arrays.fill(terrainGrid, -1);
		java.util.Arrays.fill(treeGrid, -1);
		for (int ay = minY; ay <= maxY; ay++) {
			for (int ax = minX; ax <= maxX; ax++) {
				int i = ay * width + ax;
				int idx = (ay - minY) * w + (ax - minX);
				int rgb = pixels[i] & 0xFFFFFF;
				boolean own = rgb == target;
				landGrid[idx] = own;
				// halo context: any dry-land pixel, whichever province owns it. Water provinces'
				// own cells still get their overlays filled (the coastal-shelf path reads them).
				groundGrid[idx] = !waterColors.contains(rgb);
				landDistGrid[idx] = landDistance[i];
				int riverCode = classifyRiver(river[i] & 0xFFFFFF);
				if (riverCode != 0)
					// fold in the tens (flow-direction) digit and the 100000s (render width class);
					// the authored width in the low digit is left as classifyRiver found it
					riverCode += riverFlow[i] * 10 + widthClass(riverAcc[i], riverCode % 10) * 100000;
				// fold the river-adjacency mask into the code's THOUSANDS digit, but only on an
				// actual river cell — so a non-river plot stays 0 (river() boolean is preserved) and
				// the web ribbon can link across province seams (a neighbour may sit in another mask).
				riverGrid[idx] = riverCode != 0 ? riverCode + riverAdjMask(ax, ay) * 1000 : 0;
				coastGrid[idx] = seaMask(ax, ay);
				if (terrainIdx != null)
					terrainGrid[idx] = terrainIdx[i];
				if (treeIdx != null)
					treeGrid[idx] = treeIndexAt(ax, ay);
				if (heightIdx != null)
					elevationGrid[idx] = heightIdx[i];
			}
		}
		return new ProvinceMask(minX, minY, w, h, landGrid, groundGrid, riverGrid, coastGrid,
				terrainGrid, treeGrid, elevationGrid, landDistGrid, this);
	}

	/** Receives every raster pixel with the id of the province that owns it ({@code -1} if unknown). */
	@FunctionalInterface
	public interface PixelVisitor {
		void accept(int x, int y, int provinceId);
	}

	/**
	 * Visit every pixel of the province raster with its owning province id — the one pass
	 * {@link WorldClimate} paints its field from. Loads the rasters if they are not loaded yet.
	 */
	public void forEachPixel(PixelVisitor visitor) throws IOException {
		ensureRaster();
		Map<Integer, Integer> colorToId = new HashMap<>(idToColor.size() * 2);
		for (Map.Entry<Integer, Integer> e : idToColor.entrySet())
			colorToId.put(e.getValue(), e.getKey());
		for (int y = 0; y < height; y++)
			for (int x = 0; x < width; x++) {
				Integer id = colorToId.get(pixels[y * width + x] & 0xFFFFFF);
				visitor.accept(x, y, id == null ? -1 : id);
			}
	}

	/** The province raster's pixel width. Loads the rasters if they are not loaded yet. */
	public int rasterWidth() throws IOException {
		ensureRaster();
		return width;
	}

	/** The province raster's pixel height. Loads the rasters if they are not loaded yet. */
	public int rasterHeight() throws IOException {
		ensureRaster();
		return height;
	}

	/**
	 * The <b>wooded fraction</b> in {@code [0, 1]} covering an absolute raster pixel — the
	 * vegetation density signal the feature stage spreads from, bilinearly interpolated over
	 * {@code trees.bmp}. The overlay is ~1/7.7 resolution (one tree pixel covers ~59 province
	 * pixels), so sampling it as a per-province average made density jump at every border;
	 * interpolating the woody flags of the four surrounding tree cells makes it a <b>continuous
	 * function of world position</b> instead. Returns {@code -1} when the overlay is absent.
	 */
	public double treeDensity(int ax, int ay) {
		if (treeIdx == null)
			return -1;
		double tx = (ax + 0.5) * treeWidth / (double) width - 0.5;
		double ty = (ay + 0.5) * treeHeight / (double) height - 0.5;
		int x0 = (int) Math.floor(tx), y0 = (int) Math.floor(ty);
		double fx = tx - x0, fy = ty - y0;
		double a = woody(x0, y0), b = woody(x0 + 1, y0);
		double c = woody(x0, y0 + 1), d = woody(x0 + 1, y0 + 1);
		return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
	}

	// 1 if the trees.bmp cell is wooded, 0 otherwise; clamped to the overlay's bounds
	private double woody(int tx, int ty) {
		int cx = Math.max(0, Math.min(treeWidth - 1, tx));
		int cy = Math.max(0, Math.min(treeHeight - 1, ty));
		return MapTerrainCodec.isWoody(treeIdx[cy * treeWidth + cx]) ? 1 : 0;
	}

	// the 8-bit sea mask of a land pixel: which of its 8 neighbours are water. The low nibble
	// is the orthogonal EDGES (1=E, 2=W, 4=S, 8=N; matching NB4 — used for the shoreline foam
	// and coastal gameplay); the high nibble is the diagonal CORNERS (16=NW, 32=NE, 64=SE,
	// 128=SW), which drive the Civ4 coastscalemask 16-way blend — its tile index is
	// (mask >> 4), with corner bit order NW/NE/SE/SW = the mask's TL/TR/BR/BL (docs/
	// coastlines.md §B). 0 = inland. Global, so coastlines are seamless across provinces.
	private int seaMask(int ax, int ay) {
		int m = 0;
		if (isWater(ax + 1, ay)) m |= 1;         // E
		if (isWater(ax - 1, ay)) m |= 2;         // W
		if (isWater(ax, ay + 1)) m |= 4;         // S
		if (isWater(ax, ay - 1)) m |= 8;         // N
		if (isWater(ax - 1, ay - 1)) m |= 16;    // NW (mask TL)
		if (isWater(ax + 1, ay - 1)) m |= 32;    // NE (mask TR)
		if (isWater(ax + 1, ay + 1)) m |= 64;    // SE (mask BR)
		if (isWater(ax - 1, ay + 1)) m |= 128;   // SW (mask BL)
		return m;
	}

	// the 4-bit river-adjacency mask of a river pixel: which of its orthogonal neighbours are
	// ALSO river cells (1=E, 2=W, 4=S, 8=N — matching NB4 and the sea mask's low nibble).
	// Global (checks the whole river raster), so the web ribbon links across province seams
	// instead of stopping at the bbox edge; folded into the code's THOUSANDS digit (see
	// riverCode / docs/river-rendering.md §1). 0 = no river neighbour → an isolated source blob.
	private int riverAdjMask(int ax, int ay) {
		int m = 0;
		if (isRiver(ax + 1, ay)) m |= 1;   // E
		if (isRiver(ax - 1, ay)) m |= 2;   // W
		if (isRiver(ax, ay + 1)) m |= 4;   // S
		if (isRiver(ax, ay - 1)) m |= 8;   // N
		return m;
	}

	// whether the rivers.bmp pixel is a river cell (any non-white/grey classification); x wraps
	// E-W like isWater, y beyond the poles → false. Same source as classifyRiver, so it agrees
	// with the in-province grid for interior neighbours and extends it across the seam.
	private boolean isRiver(int x, int y) {
		if (y < 0 || y >= height)
			return false;
		int wx = ((x % width) + width) % width;
		return classifyRiver(river[y * width + wx] & 0xFFFFFF) != 0;
	}

	// whether the pixel is a water (SEA/LAKE) province; x wraps E-W (the map is a cylinder),
	// y beyond the poles is treated as not-coast. Empty water set (default.map absent) → false.
	private boolean isWater(int x, int y) {
		if (y < 0 || y >= height)
			return false;
		int wx = ((x % width) + width) % width;
		return waterColors.contains(pixels[y * width + wx] & 0xFFFFFF);
	}

	// the trees.bmp palette index covering an absolute province pixel: trees.bmp is
	// a coarser raster (732x266 vs 5632x2048, ~1/7.7 each axis), so the province
	// coordinate is scaled into its grid. Clamped to the trees raster bounds.
	private int treeIndexAt(int ax, int ay) {
		int tx = Math.min(treeWidth - 1, ax * treeWidth / width);
		int ty = Math.min(treeHeight - 1, ay * treeHeight / height);
		return treeIdx[ty * treeWidth + tx];
	}

	// Classify a rivers.bmp pixel (RGB) into a compact river code, preserving what the
	// authored EU4 river map encodes instead of collapsing it to a boolean. The palette
	// was pinned by histogramming data/anbennar/rivers.bmp (see docs/river-rendering.md §1):
	// a blue ramp encodes width (cyan → deep blue = narrow → wide) and three marker colours
	// encode network nodes (green source, red confluence/flow-in, yellow split). White (land)
	// and grey (sea) are "no river". Since it is an indexed BMP the palette entries are exact
	// (no anti-aliasing), so the dominant channel classifies unambiguously.
	//
	// This returns the pixel's static classification only — the low digit is the width level
	// 1..4 and the hundreds digit is the node marker (0 plain, 1 source, 2 confluence, 3
	// split); the tens (flow-direction) digit is 0 here and filled in later from RiverFlow (a
	// property of the whole network, not one pixel). See the full encoding on ProvinceMask
	// #riverCode. e.g. 3 = a plain width-3 river, 101 = a river source, 201 = a confluence.
	// Nodes carry nominal width 1.
	static int classifyRiver(int rgb) {
		int r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
		int max = Math.max(r, Math.max(g, b)), min = Math.min(r, Math.min(g, b));
		if (max - min < 40)
			return 0; // white (land) or grey (sea) — greyscale, no river
		if (b == max)
			return widthLevel(g); // blue ramp — a plain river of that width
		if (r > 150 && g > 150)
			return 301; // yellow — river split node
		if (g == max)
			return 101; // green — river source node
		if (r == max)
			return 201; // red — tributary flow-in / confluence node
		return 0;
	}

	// the river width level (1 narrow .. 4 wide) for a blue-ramp pixel, keyed on its green
	// channel (the cyan headwater has the most green; the deep-blue mouth the least).
	private static int widthLevel(int green) {
		if (green >= 210)
			return 1;
		if (green >= 160)
			return 2;
		if (green >= 110)
			return 3;
		return 4;
	}

	/**
	 * A river cell's <b>render width class</b>, {@code 1..9} narrow→wide: one class per octave of
	 * drainage accumulation, so a river must double its catchment to widen a step — which is what
	 * turns the raw 1..5012 accumulation range into a taper the eye reads as a river growing.
	 * <p>
	 * Floored by the authored width, so a channel the mod drew wide never renders as a trickle on
	 * the rare stretch where our derived catchment disagrees with the authors. Measured over the
	 * whole map this spreads all nine classes (≈19% class 1, ≈13% class 9).
	 */
	static int widthClass(int acc, int authoredWidth) {
		if (acc <= 0)
			return 0;
		int octave = 1 + (31 - Integer.numberOfLeadingZeros(acc)); // 1 + floor(log2 acc)
		return Math.max(1, Math.min(9, Math.max(octave, authoredWidth)));
	}

	// Guarded by `rasterLoaded`, set at the very END, and NOT by `pixels` as it used to be. `pixels` is
	// assigned five statements before `waterColors`, so any failure in between — a missing terrain or
	// heightmap raster, most likely — left the object half-built, and the next call took the early
	// return and sailed on with `waterColors` still null. That surfaced as
	// "Cannot invoke Set.contains because this.waterColors is null" out of isWater(), from a servlet
	// thread, which points nowhere near the real cause. `synchronized` for the same reason: the server
	// runs on virtual threads and two concurrent plot requests could both enter this.
	private synchronized void ensureRaster() throws IOException {
		if (rasterLoaded)
			return;
		BufferedImage img = ImageIO.read(AnbennarFiles.get(PROVINCES_BMP).toFile());
		BufferedImage rImg = ImageIO.read(AnbennarFiles.get(RIVERS_BMP).toFile());
		this.width = img.getWidth();
		this.height = img.getHeight();
		if (width != rImg.getWidth() || height != rImg.getHeight())
			throw new IllegalStateException("province/river raster dimensions differ");
		this.pixels = img.getRGB(0, 0, width, height, null, 0, width);
		this.river = rImg.getRGB(0, 0, width, height, null, 0, width);
		this.terrainIdx = loadIndexed(TERRAIN_BMP, width, height);
		this.treeIdx = loadTreeOverlay();
		this.heightIdx = loadIndexed(HEIGHTMAP_BMP, width, height);
		this.waterColors = loadWaterColors();
		// derive the whole river network's drainage once — flow direction AND accumulation, rooted
		// at the sea (see RiverFlow); mask() folds both into each plot's code. waterColors must be
		// loaded first: the derivation needs to know which cells are open water, since that is what
		// it roots the rivers at.
		byte[] widthGrid = new byte[width * height];
		boolean[] isSea = new boolean[width * height];
		for (int i = 0; i < widthGrid.length; i++) {
			widthGrid[i] = (byte) (classifyRiver(river[i] & 0xFFFFFF) % 10); // 0, or width 1..4
			isSea[i] = waterColors.contains(pixels[i] & 0xFFFFFF);
		}
		RiverFlow.Network net = RiverFlow.derive(width, height, widthGrid, heightIdx, isSea);
		this.riverFlow = net.dir();
		this.riverAcc = net.acc();
		this.landDistance = computeLandDistance();
		this.rasterLoaded = true;   // LAST — see the guard above; a partial load must not look complete
	}

	// the Chebyshev distance from every pixel to the nearest dry-land (non-water) pixel: 0 on
	// land, 1..N out into the sea. Two chamfer passes (forward TL→BR, backward BR→TL) with an
	// 8-connected step of 1, which yields the exact Chebyshev distance. Dry land = any pixel
	// whose colour is not a water (SEA/LAKE) province colour, so a shelf cell is measured to the
	// real coast regardless of which land province it belongs to. No E-W wrap (a seam-only
	// effect out in open ocean, which is deep anyway). Empty water set → all-land → all 0.
	private int[] computeLandDistance() {
		final int INF = width + height; // larger than any real distance; the cap SHELF work needs
		int[] d = new int[width * height];
		for (int i = 0; i < d.length; i++)
			d[i] = waterColors.contains(pixels[i] & 0xFFFFFF) ? INF : 0;
		for (int y = 0; y < height; y++)
			for (int x = 0; x < width; x++) {
				int i = y * width + x;
				if (d[i] == 0)
					continue;
				int best = d[i];
				if (x > 0) best = Math.min(best, d[i - 1] + 1);
				if (y > 0) best = Math.min(best, d[i - width] + 1);
				if (y > 0 && x > 0) best = Math.min(best, d[i - width - 1] + 1);
				if (y > 0 && x < width - 1) best = Math.min(best, d[i - width + 1] + 1);
				d[i] = best;
			}
		for (int y = height - 1; y >= 0; y--)
			for (int x = width - 1; x >= 0; x--) {
				int i = y * width + x;
				if (d[i] == 0)
					continue;
				int best = d[i];
				if (x < width - 1) best = Math.min(best, d[i + 1] + 1);
				if (y < height - 1) best = Math.min(best, d[i + width] + 1);
				if (y < height - 1 && x < width - 1) best = Math.min(best, d[i + width + 1] + 1);
				if (y < height - 1 && x > 0) best = Math.min(best, d[i + width - 1] + 1);
				d[i] = best;
			}
		return d;
	}

	// the pixel colours of water provinces, from default.map's sea_starts + lakes id blocks
	// (the raw source ProvinceExporter reads), mapped through idToColor. Self-contained so
	// every generation path classifies coast identically. Empty if default.map is absent.
	private Set<Integer> loadWaterColors() throws IOException {
		Set<Integer> colors = new HashSet<>();
		Optional<Path> f = AnbennarFiles.getOptional(DEFAULT_MAP);
		if (f.isEmpty())
			return colors;
		String text = Files.readString(f.get(), StandardCharsets.UTF_8);
		for (String key : new String[] { "sea_starts", "lakes" }) {
			int k = text.indexOf(key);
			if (k < 0)
				continue;
			int open = text.indexOf('{', k), close = text.indexOf('}', open);
			if (open < 0 || close < 0)
				continue;
			String body = text.substring(open + 1, close).replaceAll("#[^\n]*", " "); // drop comments
			for (String tok : body.trim().split("\\s+")) {
				if (tok.isEmpty())
					continue;
				try {
					Integer c = idToColor.get(Integer.parseInt(tok));
					if (c != null)
						colors.add(c);
				} catch (NumberFormatException ignore) {
					// stray token (e.g. a comment word) — skip
				}
			}
		}
		return colors;
	}

	// read an 8-bit indexed BMP's raw palette indices (not RGB) into a row-major
	// int[]. Returns null if the file is missing or its dimensions do not match the
	// expected (w, h) — the overlay is optional, so a mismatch degrades gracefully
	// to climate generation rather than failing the run.
	private static int[] loadIndexed(String modPath, int expectW, int expectH) throws IOException {
		Optional<Path> f = AnbennarFiles.getOptional(modPath);
		if (f.isEmpty())
			return null;
		BufferedImage img = ImageIO.read(f.get().toFile());
		if (img.getWidth() != expectW || img.getHeight() != expectH)
			return null;
		return img.getRaster().getSamples(0, 0, expectW, expectH, 0, (int[]) null);
	}

	// load trees.bmp at its own (smaller) resolution; it is sampled by scaling, so
	// it need not match the province raster. Records its dimensions for treeIndexAt.
	private int[] loadTreeOverlay() throws IOException {
		Optional<Path> f = AnbennarFiles.getOptional(TREES_BMP);
		if (f.isEmpty())
			return null;
		BufferedImage img = ImageIO.read(f.get().toFile());
		this.treeWidth = img.getWidth();
		this.treeHeight = img.getHeight();
		return img.getRaster().getSamples(0, 0, treeWidth, treeHeight, 0, (int[]) null);
	}
}
