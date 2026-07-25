package com.civstudio.geo;

/**
 * The pixel silhouette of one province, read from {@code data/anbennar/provinces.bmp}: a
 * rectangular grid over the province's bounding box in which each cell is either
 * <b>land</b> (a pixel of this province's colour) or not, with a parallel
 * <b>river</b> flag (from {@code data/anbennar/rivers.bmp}). It is the substrate the
 * per-province plot generation paints onto — one land cell becomes one plot, at 1
 * raster pixel = 1 plot. See {@code docs/province-plots.md}.
 * <p>
 * Coordinates are local to the bounding box ({@code 0..width-1}, {@code
 * 0..height-1}); add {@link #originX()}/{@link #originY()} to recover the absolute
 * raster pixel. Out-of-bounds queries return {@code false} (treated as ocean), so
 * the spatial generators can probe neighbours freely at the edges.
 * <p>
 * <b>Two land senses.</b> The frame is grown by {@link ProvinceRaster#HALO} pixels beyond the
 * province's own bounding box, and carries the neighbouring provinces' land as well:
 * {@link #isLand} is the province's <b>own</b> pixels (one plot each — the emission set), while
 * {@link #isGround} is <b>any</b> dry-land pixel in the frame (the generation set). Spatial
 * generators must probe {@code isGround}, or a province border reads as ocean and every stage
 * breaks at the seam. See {@code docs/plot-generator.md} §Seamless generation.
 */
public final class ProvinceMask {

	private final int originX;
	private final int originY;
	private final int width;
	private final int height;
	private final boolean[] land;   // row-major, width*height — THIS province's pixels
	private final boolean[] ground; // row-major — any dry-land pixel (own or a neighbour's)
	// the raster this mask was framed from, for the global (halo-independent) lookups —
	// null for a hand-built test mask, which then reports no tree density
	private final ProvinceRaster raster;
	// the river classification code per cell (0 = none; low digit = width 1..4, tens digit =
	// downstream flow direction 1..8, hundreds digit = node marker), from rivers.bmp via
	// ProvinceRaster.classifyRiver + RiverFlow — see docs/river-rendering.md §1/§3. Preserves
	// the authored width/nodes and the derived flow rather than a bare flag.
	private final int[] river;
	// the 8-bit sea mask per cell — which of the 8 neighbours are water: low nibble = edges
	// (1=E,2=W,4=S,8=N), high nibble = corners (16=NW,32=NE,64=SE,128=SW); 0 = inland. From
	// ProvinceRaster over the global land/sea raster — see docs/coastlines.md.
	private final int[] coast;
	// the real EU4 terrain.bmp / trees.bmp palette index per cell, or -1 where the
	// overlay is absent (see ProvinceRaster); the plot field reads these to ground a
	// plot on the real map and falls back to climate generation where they are -1
	private final int[] terrainIndex;
	private final int[] treeIndex;
	// the real heightmap.bmp elevation per cell (0..255, the 8-bit grayscale height), or
	// 0 where the overlay is absent; a raster lookup (no generation), read by the plot
	// field so each plot carries its elevation
	private final int[] elevation;
	// the Chebyshev distance (pixels) from each cell to the nearest dry land: 0 on a land
	// province's own cells, 1..N out into the sea for a water province's cells. Global (see
	// ProvinceRaster#computeLandDistance); the coastal-shelf water plots read it to keep only
	// the near-shore ring and to grade COAST (1) vs SEA (2..N). See docs/coastlines.md.
	private final int[] landDist;

	ProvinceMask(int originX, int originY, int width, int height, boolean[] land, boolean[] ground,
			int[] river, int[] coast, int[] terrainIndex, int[] treeIndex, int[] elevation,
			int[] landDist, ProvinceRaster raster) {
		this.originX = originX;
		this.originY = originY;
		this.width = width;
		this.height = height;
		this.land = land;
		this.ground = ground != null ? ground : land; // a hand-built mask has no neighbours
		this.river = river;
		this.coast = coast;
		this.terrainIndex = terrainIndex;
		this.treeIndex = treeIndex;
		this.elevation = elevation;
		this.landDist = landDist;
		this.raster = raster;
	}

	/** A hand-built mask with no halo (tests): own land is all the land there is. */
	ProvinceMask(int originX, int originY, int width, int height, boolean[] land, int[] river,
			int[] coast, int[] terrainIndex, int[] treeIndex, int[] elevation, int[] landDist) {
		this(originX, originY, width, height, land, null, river, coast, terrainIndex, treeIndex,
				elevation, landDist, null);
	}

	/** Absolute raster x of local column 0 (the bounding-box left edge). */
	public int originX() {
		return originX;
	}

	/** Absolute raster y of local row 0 (the bounding-box top edge). */
	public int originY() {
		return originY;
	}

	/** Bounding-box width in cells. */
	public int width() {
		return width;
	}

	/** Bounding-box height in cells. */
	public int height() {
		return height;
	}

	/**
	 * Whether the local cell is <b>this province's own</b> land (false outside the bbox) — the
	 * emission set: exactly these cells become plots. Use {@link #isGround} for neighbour probes
	 * during generation, or the province border reads as ocean.
	 */
	public boolean isLand(int lx, int ly) {
		if (lx < 0 || lx >= width || ly < 0 || ly >= height)
			return false;
		return land[ly * width + lx];
	}

	/**
	 * Whether the local cell is dry land at all — this province's or a <b>neighbouring</b>
	 * province's, out to the {@link ProvinceRaster#HALO} the frame carries (false outside the
	 * bbox). This is the set the spatial generators run over: terrain patches, relief ranges,
	 * de-speckling and vegetation spread all read it so they carry across a province seam instead
	 * of stopping at it. Only {@link #isLand} cells are emitted as plots.
	 */
	public boolean isGround(int lx, int ly) {
		if (lx < 0 || lx >= width || ly < 0 || ly >= height)
			return false;
		return ground[ly * width + lx];
	}

	/**
	 * Whether the local cell is <b>coastal</b> — a real sea/lake pixel touches it, per the global
	 * {@link #coast} mask. This is the C2C {@code isCoastal} the vegetation stage seeds from; it
	 * must never be approximated as "a neighbour outside this province", which would seed a
	 * vegetation ring along every province outline.
	 */
	public boolean isCoastal(int lx, int ly) {
		return coast(lx, ly) != 0;
	}

	/**
	 * The wooded fraction in {@code [0, 1]} at the local cell — the continuous {@code trees.bmp}
	 * density signal the vegetation stage spreads from (see {@link ProvinceRaster#treeDensity}).
	 * {@code -1} when the overlay is absent or the mask was hand-built.
	 */
	public double treeDensity(int lx, int ly) {
		if (raster == null)
			return -1;
		return raster.treeDensity(originX + lx, originY + ly);
	}

	/** Whether the local cell carried a river pixel (false outside the bbox). */
	public boolean isRiver(int lx, int ly) {
		return riverCode(lx, ly) != 0;
	}

	/**
	 * The river classification code at the local cell (0 outside the bbox / no river). It
	 * packs four fields as decimal digits: the <b>low</b> digit is the width level 1..4, the
	 * <b>tens</b> digit is the downstream flow direction 1..8 (0 = a sink/mouth; see {@link
	 * RiverFlow}), the <b>hundreds</b> digit is the node marker (0 plain, 1 source, 2 confluence,
	 * 3 split), and the <b>thousands</b> digit is a 4-bit river-adjacency mask (1=E, 2=W, 4=S,
	 * 8=N) naming which orthogonal neighbours are also river cells — computed globally so the web
	 * ribbon links across province seams. e.g. {@code 53} = a width-3 river flowing direction 5
	 * (W); {@code 5141} = a source (width 1) flowing direction 4 with river neighbours E+S. See
	 * {@link ProvinceRaster#classifyRiver} and {@code docs/river-rendering.md} §1/§3.
	 */
	public int riverCode(int lx, int ly) {
		if (lx < 0 || lx >= width || ly < 0 || ly >= height)
			return 0;
		return river[ly * width + lx];
	}

	/**
	 * The 8-bit sea mask at the local cell (0 outside the bbox / inland): which of the 8
	 * neighbours border water. Low nibble = orthogonal edges ({@code 1}=E, {@code 2}=W,
	 * {@code 4}=S, {@code 8}=N); high nibble = diagonal corners ({@code 16}=NW, {@code 32}=NE,
	 * {@code 64}=SE, {@code 128}=SW). The corners drive the Civ4 coastscalemask blend (tile
	 * index = {@code mask >> 4}). Non-zero means coastal. See {@code docs/coastlines.md}.
	 */
	public int coast(int lx, int ly) {
		if (lx < 0 || lx >= width || ly < 0 || ly >= height)
			return 0;
		return coast[ly * width + lx];
	}

	/**
	 * The real {@code terrain.bmp} palette index at the local cell, or {@code -1} if
	 * the cell is outside the bbox or the terrain overlay was not loaded. Decode it
	 * with {@link MapTerrainCodec#ground}/{@link MapTerrainCodec#relief}.
	 */
	public int terrainIndex(int lx, int ly) {
		if (lx < 0 || lx >= width || ly < 0 || ly >= height)
			return -1;
		return terrainIndex[ly * width + lx];
	}

	/**
	 * The real {@code trees.bmp} palette index covering the local cell, or {@code -1}
	 * if outside the bbox or the tree overlay was not loaded. Decode it with {@link
	 * MapTerrainCodec#isWoody} (the overlay is coarse — used as a density signal).
	 */
	public int treeIndex(int lx, int ly) {
		if (lx < 0 || lx >= width || ly < 0 || ly >= height)
			return -1;
		return treeIndex[ly * width + lx];
	}

	/**
	 * The real {@code heightmap.bmp} elevation at the local cell (0..255), or {@code 0}
	 * (sea level) outside the bbox or if the heightmap was not loaded. A raster lookup
	 * — higher is higher ground; used for hillshading and, later, gameplay elevation.
	 */
	public int elevation(int lx, int ly) {
		if (lx < 0 || lx >= width || ly < 0 || ly >= height)
			return 0;
		return elevation[ly * width + lx];
	}

	/**
	 * The Chebyshev distance in pixels from the local cell to the nearest dry land (0 on a
	 * land province's own cells; 1 for a water cell touching land, growing seaward), or {@code
	 * 0} outside the bbox. For a sea/lake province this grades its cells into the coastal shelf
	 * — {@code 1} = COAST, {@code 2..N} = SEA — that the water plot generation keeps. See
	 * {@link ProvinceRaster} and {@code docs/coastlines.md}.
	 */
	public int landDist(int lx, int ly) {
		if (lx < 0 || lx >= width || ly < 0 || ly >= height)
			return 0;
		return landDist[ly * width + lx];
	}

	/** The number of land cells (== the province's plot count). */
	public int landCount() {
		int n = 0;
		for (boolean b : land)
			if (b)
				n++;
		return n;
	}
}
