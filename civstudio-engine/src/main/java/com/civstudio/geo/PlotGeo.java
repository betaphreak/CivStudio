package com.civstudio.geo;

/**
 * The raster-derived scalars of one plot: its {@code (x, y)} position in the province
 * silhouette and the fields read straight off the Anbennar rasters — the packed river code,
 * the heightmap elevation, and the 8-bit sea mask. Grouping them into one immutable value is
 * a deliberate refactor: a new per-plot raster attribute is now a one-line change <b>here</b>,
 * instead of shotgun surgery across {@link ProvincePlotField.ProvincePlot}, {@link
 * com.civstudio.settlement.Plot} and the persistence DTO (each of which used to grow another
 * constructor parameter). {@code ProvincePlot} and {@code Plot} both carry a {@code PlotGeo}
 * and delegate their positional/raster accessors to it. See {@code docs/plots.md}.
 *
 * @param x         raster x in the province silhouette ({@code -1} for a province-less plot)
 * @param y         raster y ({@code -1} for a province-less plot)
 * @param river     packed river code (width / flow / node — see {@link ProvinceRaster#classifyRiver})
 * @param elevation heightmap elevation, {@code 0..255} ({@code 0} where absent)
 * @param coast     8-bit sea mask (edge + corner water — see {@code docs/coastlines.md})
 * @param landDist  Chebyshev pixels to the nearest dry land: {@code 0} on land, {@code 1} for water
 *                  touching a coast, rising outward to {@code ProvincePlotField.SHELF_MAX} at the
 *                  outer edge of the coastal shelf. Computed over the WHOLE world raster
 *                  ({@link ProvinceRaster#computeLandDistance}), so it is identical either side of a
 *                  province boundary — which is the point of shipping it. The shelf ends at a hard
 *                  integer cutoff, so without this the web client has no way to fade its outer ring
 *                  and every coastline ends in a staircase of squares; anything it could derive
 *                  instead sees only one province's plots and would print a seam at every boundary.
 *                  See {@code docs/civ4-texture-inventory.md} §4 P3.
 */
public record PlotGeo(int x, int y, int river, int elevation, int coast, int landDist) {

	/** The geography of a province-less plot (a legacy/test plot): no position, water or elevation. */
	public static final PlotGeo NONE = new PlotGeo(-1, -1, 0, 0, 0, 0);
}
