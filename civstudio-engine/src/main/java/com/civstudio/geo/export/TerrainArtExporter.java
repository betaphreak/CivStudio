package com.civstudio.geo.export;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.w3c.dom.Document;
import org.w3c.dom.Element;

import com.civstudio.geo.TerrainArtInfo;
import tools.jackson.databind.ObjectMapper;

/**
 * Dev tool: parses {@code data/civ4/CIV4ArtDefines_Terrain.xml} (the
 * {@code TerrainArtInfo} art bindings) and emits the curated land subset to the
 * committed {@code /map/terrain-art.json} resource, keyed by the <b>gameplay</b>
 * {@code TERRAIN_*} type. The art defines key on {@code ART_DEF_TERRAIN_*}; this
 * exporter joins them to gameplay terrain via {@code TerrainInfo.ArtDefineTag}
 * (read from {@code data/civ4/CIV4TerrainInfos.xml}) at export time, so the output
 * aligns 1:1 with {@code TerrainExporter}'s {@code /terrains.json} and the runtime
 * needs no join. The running simulation never touches the XML. Run manually, like
 * the other geo exporters:
 *
 * <pre>
 * mvn compile exec:exec -Dsim.main=com.civstudio.geo.export.TerrainArtExporter
 * </pre>
 *
 * The curated set mirrors {@link TerrainExporter#KEEP the gameplay curation}
 * (settleable land, plus the eight WATER terrains a shelf plot can carry; hills/peaks
 * are a {@code PlotType} axis, space is skipped). The {@code .dds} paths it records
 * point into the {@code UnpackedArt/art} source tree; the web build (see {@code
 * docs/ported-terrain-art-system.md} §10) decodes and bakes them — the raw {@code
 * .dds} never ships. See also §4.1.
 */
public final class TerrainArtExporter {

	private static final String ART = "CIV4ArtDefines_Terrain.xml";
	private static final String INFOS = "CIV4TerrainInfos.xml";
	private static final String OUTPUT = "civstudio-engine/target/generated/map/terrain-art.json";

	/**
	 * The curated subset — the same terrains {@link TerrainExporter} keeps: 16 land, then
	 * the 8 water ones.
	 *
	 * <p>The water half was skipped for years on the reasoning that a 2D client has no
	 * seabed to draw. That was wrong once the shelf became real plots: {@link
	 * com.civstudio.geo.MapTerrainCodec} stamps every water plot with {@code
	 * TERRAIN_COAST}/{@code TERRAIN_SEA} (plus a climate suffix) or the {@code
	 * TERRAIN_LAKE} pair, and with no art entry the web bake had nothing to key on, so the
	 * whole shelf fell back to a flat interpolated colour. These eight bind the same way
	 * land does — Civ4's own {@code CoastDetail}/{@code SeaDetail}/{@code ShoreDetail}
	 * ground textures — and the bake recolours each to its water display colour.
	 */
	private static final Set<String> KEEP = new LinkedHashSet<>(List.of(
			"TERRAIN_GRASSLAND", "TERRAIN_LUSH", "TERRAIN_PLAINS", "TERRAIN_SCRUB",
			"TERRAIN_MARSH", "TERRAIN_MUDDY", "TERRAIN_ROCKY", "TERRAIN_BADLAND",
			"TERRAIN_JAGGED", "TERRAIN_BARREN", "TERRAIN_DESERT", "TERRAIN_DUNES",
			"TERRAIN_SALT_FLATS", "TERRAIN_TAIGA", "TERRAIN_TUNDRA",
			"TERRAIN_PERMAFROST",
			"TERRAIN_COAST", "TERRAIN_COAST_POLAR", "TERRAIN_COAST_TROPICAL",
			"TERRAIN_SEA", "TERRAIN_SEA_POLAR", "TERRAIN_SEA_TROPICAL",
			"TERRAIN_LAKE_SHORE", "TERRAIN_LAKE"));

	/**
	 * Detail textures overridden away from what the art define names, and the only place
	 * this exporter departs from the XML.
	 *
	 * <p>{@code ART_DEF_TERRAIN_LAKE} binds {@code Art/Shared/GreyDetail.dds} — a flat
	 * neutral grey. That is not laziness in Civ4: a lake's look there comes from {@code
	 * LakeBlend.dds} modulating the grey, and we do not read the blend textures at all
	 * (the web bake reads {@code detail} and recolours it). Taking Civ4 literally would
	 * bake a featureless tile and give a lake less grain than the ocean beside it, so the
	 * lake takes the deep-water grain its own shore already uses.
	 */
	private static final Map<String, String> DETAIL_OVERRIDE = Map.of(
			"TERRAIN_LAKE", "Art/Terrain/Textures/Water/SeaDetail.dds");

	/**
	 * Art bindings for the authored, source-less terrains (see {@link
	 * TerrainExporter#SYNTHETIC}) — they have no {@code CIV4ArtDefines_Terrain.xml} entry,
	 * so their art is <b>repurposed</b> from an existing Civ4 ground texture and recoloured
	 * in the web bake to the terrain's authored display colour (a dark, warm cavern floor;
	 * a fungal-violet mushroom ground). {@code TERRAIN_CAVERN} reuses the rocky ground
	 * textures; {@code TERRAIN_MUSHROOM_FOREST} the lush ones. The blend table is empty:
	 * both terrains fill homogeneous provinces, so no cross-terrain auto-tiling is needed.
	 * See {@code docs/underworld.md}.
	 */
	private static final List<TerrainArtInfo> SYNTHETIC = List.of(
			new TerrainArtInfo("TERRAIN_CAVERN", "ART_DEF_TERRAIN_CAVERN",
					"Art/Terrain/Textures/Land/RockyBlend.dds",
					"Art/Terrain/Textures/Land/RockyGrid.dds",
					"Art/Terrain/Textures/Land/RockyDetail.dds",
					13, false, Map.of()),
			// the forest-family Anbennar terrains reuse the lush ground (green forest floor),
			// recoloured per terrain in the web bake; their trees come from the tree overlay
			lushArt("TERRAIN_MUSHROOM_FOREST", "ART_DEF_TERRAIN_MUSHROOM_FOREST"),
			lushArt("TERRAIN_ANCIENT_FOREST", "ART_DEF_TERRAIN_ANCIENT_FOREST"),
			lushArt("TERRAIN_GLADEWAY", "ART_DEF_TERRAIN_GLADEWAY"),
			lushArt("TERRAIN_FEY_GLADEWAY", "ART_DEF_TERRAIN_FEY_GLADEWAY"),
			lushArt("TERRAIN_BLOODGROVES", "ART_DEF_TERRAIN_BLOODGROVES"),
			// shadow swamp reuses the marsh ground; glacier the ice/permafrost ground
			new TerrainArtInfo("TERRAIN_SHADOW_SWAMP", "ART_DEF_TERRAIN_SHADOW_SWAMP",
					"Art/Terrain/Textures/Land/TundraBlend.dds",
					"Art/Terrain/Textures/Land/TundraGrids.dds",
					"Art/Terrain/Textures/Land/MarshDetail.dds",
					5, false, Map.of()),
			new TerrainArtInfo("TERRAIN_GLACIER", "ART_DEF_TERRAIN_GLACIER",
					"Art/Terrain/Textures/Land/IceBlend.dds",
					"Art/Terrain/Textures/Land/IceGrid.dds",
					"Art/Terrain/Textures/Land/PermafrostDetail.dds",
					2, false, Map.of()),
			// urban reuses the rocky ground (grey stone reads as pavement), recoloured to a
			// concrete grey in the web bake — only the base the city sprite stands on; C2C has
			// no city/pavement texture. See docs/urban-plots.md.
			new TerrainArtInfo("TERRAIN_URBAN", "ART_DEF_TERRAIN_URBAN",
					"Art/Terrain/Textures/Land/RockyBlend.dds",
					"Art/Terrain/Textures/Land/RockyGrid.dds",
					"Art/Terrain/Textures/Land/RockyDetail.dds",
					13, false, Map.of()));

	/** A {@link TerrainArtInfo} reusing the lush (green forest) ground textures. */
	private static TerrainArtInfo lushArt(String terrain, String tag) {
		return new TerrainArtInfo(terrain, tag,
				"Art/Terrain/Textures/Land/LushBlend.dds",
				"Art/Terrain/Textures/Land/LushGrid.dds",
				"Art/Terrain/Textures/Land/LushDetail.dds",
				9, false, Map.of());
	}

	private TerrainArtExporter() {
	}

	public static void main(String[] args) throws Exception {
		// 1. gameplay terrain -> its art define tag (TerrainInfo.ArtDefineTag)
		Document infos = Civ4Xml.fetch(INFOS);
		Map<String, String> artTag = new LinkedHashMap<>();
		for (Element info : Civ4Xml.infos(infos, "TerrainInfo")) {
			String type = Civ4Xml.text(info, "Type");
			if (type != null && KEEP.contains(type))
				artTag.put(type, Civ4Xml.text(info, "ArtDefineTag"));
		}

		// 2. art tag -> its TerrainArtInfo element
		Document art = Civ4Xml.fetch(ART);
		Map<String, Element> byTag = new HashMap<>();
		for (Element ai : Civ4Xml.infos(art, "TerrainArtInfo"))
			byTag.put(Civ4Xml.text(ai, "Type"), ai);

		// 3. emit one record per curated terrain, in the curated order
		List<TerrainArtInfo> out = new ArrayList<>();
		for (String terrain : KEEP) {
			String tag = artTag.get(terrain);
			if (tag == null)
				throw new IllegalStateException("no ArtDefineTag for curated terrain " + terrain
						+ " in " + INFOS);
			Element ai = byTag.get(tag);
			if (ai == null)
				throw new IllegalStateException("no TerrainArtInfo for " + tag
						+ " (terrain " + terrain + ") in " + ART);
			out.add(new TerrainArtInfo(
					terrain, tag,
					Civ4Xml.text(ai, "Path"),
					Civ4Xml.text(ai, "Grid"),
					DETAIL_OVERRIDE.getOrDefault(terrain, Civ4Xml.text(ai, "Detail")),
					Civ4Xml.intVal(ai, "LayerOrder", 0),
					Civ4Xml.boolVal(ai, "AlphaShader"),
					blendTable(ai)));
		}

		// the authored, source-less terrains (cavern floor, surface mushroom forest) reuse
		// an existing ground texture, recoloured in the web bake — see SYNTHETIC
		out.addAll(SYNTHETIC);

		File f = new File(OUTPUT);
		f.getParentFile().mkdirs();
		new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(f, out);
		System.out.println("wrote " + out.size() + " terrain-art entries to " + f.getAbsolutePath());
	}

	// the 16-way blend table: neighbour bitmask "01".."15" -> "index,rotation ..." entries
	private static Map<String, String> blendTable(Element ai) {
		Map<String, String> m = new LinkedHashMap<>();
		for (int mask = 1; mask <= 15; mask++) {
			String v = Civ4Xml.text(ai, String.format("TextureBlend%02d", mask));
			if (v != null && !v.isEmpty())
				m.put(String.format("%02d", mask), v);
		}
		return m;
	}
}
