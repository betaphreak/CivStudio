// seed.js — Phase 3 seeder for the "Studio as the engine's authoritative content store" rebuild
// (docs/studio-datamodel-rebuild-plan.md). Reads the committed world-bundle snapshot by default (the
// gitignored generated/ tree is only ephemeral exporter build-scratch now; pass --from-generated to seed
// from it during a local content regen) and upserts into Strapi via the Document Service (in-process —
// boots Strapi programmatically, no HTTP). Only the GEN/MAP datasets come from the bundle; the committed
// RES-root loose files (feasts / human-names / geo/region-earth-map) are read as files either way.
//
// CommonJS on purpose: booting Strapi through ESM (`node seed.mjs`) trips ERR_UNSUPPORTED_DIR_IMPORT
// on @strapi/core's lodash/fp import; require() resolves Strapi's CJS build, which is fine.
//
// Two-phase, idempotent: PHASE A upserts every collection's scalar/enum fields keyed on its natural
// key (tag/key/id/…), building a key→documentId map per type; PHASE B relinks all relations by
// resolving foreign natural keys through those maps (so self-relations like tech prereqs and province
// neighbors, and the province hub, all resolve). Re-running converges — no duplicates. tech↔building
// and tech↔unit unlocks are NOT seeded from the overlay files: they are the inverse of
// building/unit.prereqTech, so setting prereqTech populates them for free.
//
// Scope (locked decisions): core model. DEFERRED — place-name (GeoNames) and the full all-race
// name-pool (needs the Java RaceNameGenerator); era-modifiers/rank-ladder single types (no JSON
// source). name-pool seeds HUMAN only (non-human names are runtime-generated, not bundle data); tech-effect is an empty stub today (0 rows).
//
// Run from studio/:  node scripts/seed.js

const { createStrapi, compileStrapi } = require('@strapi/strapi');
const { readFileSync, existsSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const { randomBytes } = require('node:crypto');
const { join, relative, sep } = require('node:path');
// contentVersion is DERIVED from the content it stamps — see tools/content-hash.cjs for why a
// hand-written string could not do the job (it is Strapi's world-bundle cache key).
const { contentHash } = require(join(__dirname, '..', '..', 'tools', 'content-hash.cjs'));

const RES = join(__dirname, '..', '..', 'civstudio-engine', 'src', 'main', 'resources');
// the exporter build-scratch tree — the --from-generated source (gitignored, under Maven target/).
// In the default bundle mode nothing is read from here; GEN only anchors bundleKey()'s path mapping.
const GEN = join(RES, '..', '..', '..', 'target', 'generated');
const MAP = join(GEN, 'map');
// The committed world-bundle snapshot — the DEFAULT content source (see loadBundle / bundle mode below).
const FIXTURE = join(RES, '..', '..', 'test', 'resources', 'world-bundle.json.gz');

// ── bundle source ────────────────────────────────────────────────────────────
// generated/ is only ephemeral exporter build-scratch now; the SEED reads its datasets from the
// committed world-bundle instead (so a fresh checkout / CI reseed needs no exporter output). BUNDLE is
// set in main() unless --from-generated is passed (the local regen path that seeds from fresh scratch).
// Only the gitignored GEN/MAP datasets are sourced from the bundle; the committed RES-root loose files
// (feasts / human-names / geo/region-earth-map) are always present and read as files either way.
let BUNDLE = null; // { meta, resources } when in bundle mode

function loadBundle(p) {
  const raw = readFileSync(p);
  const json = p.endsWith('.gz') ? gunzipSync(raw) : raw;
  return JSON.parse(json.toString('utf8'));
}
// A GEN-rooted file path -> its world-bundle resource key ('/techs.json', '/map/countries.json', …);
// null for a path outside generated/ (a committed RES-root file, read from disk in either mode).
function bundleKey(p) {
  const rel = relative(GEN, p);
  if (rel.startsWith('..')) return null;
  return '/' + rel.split(sep).join('/');
}
// Whether a (GEN-rooted) source exists — from the bundle in bundle mode, else on disk. Replaces the
// bare existsSync guards on the optional balance/scenario sources so they resolve from the bundle too.
const hasSource = (p) => {
  if (BUNDLE) { const k = bundleKey(p); return !!(k && Object.prototype.hasOwnProperty.call(BUNDLE.resources, k)); }
  return existsSync(p);
};

// ── helpers ──────────────────────────────────────────────────────────────────
// In bundle mode a GEN-rooted read resolves from the committed world-bundle (a dataset per resource
// key); anything else (the committed RES-root loose files) falls through to disk. Treated read-only.
const readJson = (p) => {
  if (BUNDLE) {
    const k = bundleKey(p);
    if (k && Object.prototype.hasOwnProperty.call(BUNDLE.resources, k)) return BUNDLE.resources[k];
  }
  return JSON.parse(readFileSync(p, 'utf8'));
};
const int = (v) => (v === null || v === undefined || v === '' ? undefined : parseInt(v, 10));
const bool = (v) => (v === undefined ? undefined : v === true || v === '1' || v === 1);
const stripEra = (v) => (v ? v.replace(/^C2C_ERA_/, '') : undefined);
const enumOrNull = (v) => (v ? v : undefined); // "" / null enum → omit
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
/** Extract an And/Or prereq node's tech list ({PrereqTech: s|[s]}) into an array. */
const prereqs = (node) => {
  const p = node && node.PrereqTech;
  return p ? (Array.isArray(p) ? p : [p]) : [];
};

/** Run async fn over items with bounded concurrency. */
async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }),
  );
}

// An opaque 24-char Strapi documentId (the value is arbitrary — only uniqueness matters for bulk rows).
const genDocId = () => randomBytes(12).toString('hex');

/**
 * BULK seed path (--bulk): the per-row Document Service does ~65k round-trips (crippling over a remote
 * DB's latency). Instead, wipe then raw-INSERT via knex — PHASE A batch-inserts each collection's rows
 * in a few statements (building natural-key → int-id maps by re-selecting), PHASE B batch-inserts the
 * relation `_lnk` rows resolved through those maps (with order columns). ~65k round-trips → a few
 * hundred. Assumes a clean slate, so it always wipes first. The small loose bits (feast/name-pool/single
 * types) stay on the Document Service path (main()) — they're trivial.
 */
async function bulkSeed(app, specs) {
  await wipe(app);
  const db = app.db.connection;
  const now = new Date();
  const idMaps = {}; // name → Map(naturalKey → int id)

  // PHASE A — scalars
  for (const spec of specs) {
    const meta = app.db.metadata.get(uid(spec.name));
    const keyOf = spec.keyOf || ((r) => r[spec.key]);
    spec.rows = spec.load();
    const rows = spec.rows.map((r) => {
      const dbRow = {};
      const set = (attrName, val) => { const a = meta.attributes[attrName]; if (a) dbRow[a.columnName] = val; };
      set('documentId', genDocId()); set('createdAt', now); set('updatedAt', now); set('publishedAt', now); set('locale', 'en');
      const scalars = clean({ [spec.key]: keyOf(r), ...spec.scalars(r) });
      for (const [attr, val] of Object.entries(scalars)) {
        const a = meta.attributes[attr];
        if (a && a.columnName) dbRow[a.columnName] = a.type === 'json' ? JSON.stringify(val) : val;
      }
      return dbRow;
    });
    if (rows.length) await db.batchInsert(meta.tableName, rows, 1000);
    const keyCol = meta.attributes[spec.key].columnName;
    const m = new Map();
    for (const row of await db(meta.tableName).select('id', keyCol)) m.set(row[keyCol], row.id);
    idMaps[spec.name] = m;
    console.log(`[bulkA] ${spec.name.padEnd(16)} ${String(rows.length).padStart(5)}`);
  }

  // PHASE B — relation link tables
  const R = {
    one: (name, key) => (key === null || key === undefined ? undefined : idMaps[name] && idMaps[name].get(key)),
    many: (name, keys) => (keys || []).map((k) => idMaps[name] && idMaps[name].get(k)).filter((x) => x != null),
  };
  for (const spec of specs) {
    if (!spec.rel) continue;
    const meta = app.db.metadata.get(uid(spec.name));
    const keyOf = spec.keyOf || ((r) => r[spec.key]);
    const buckets = {}; // linkTable → { rows, inv: Map(targetId → count) }
    for (const r of spec.rows) {
      const sourceId = idMaps[spec.name].get(keyOf(r));
      if (sourceId == null) continue;
      const rel = spec.rel(r, R);
      for (const [field, target] of Object.entries(rel)) {
        const a = meta.attributes[field];
        const jt = a && a.joinTable;
        if (!jt) continue;
        const bucket = buckets[jt.name] || (buckets[jt.name] = { rows: [], inv: new Map(), jt });
        const targets = Array.isArray(target) ? target : target != null ? [target] : [];
        targets.forEach((tid, i) => {
          const row = { [jt.joinColumn.name]: sourceId, [jt.inverseJoinColumn.name]: tid };
          if (jt.orderColumnName) row[jt.orderColumnName] = i + 1;
          if (jt.inverseOrderColumnName) { const c = (bucket.inv.get(tid) || 0) + 1; bucket.inv.set(tid, c); row[jt.inverseOrderColumnName] = c; }
          bucket.rows.push(row);
        });
      }
    }
    for (const [linkTable, bucket] of Object.entries(buckets)) {
      if (bucket.rows.length) await db.batchInsert(linkTable, bucket.rows, 2000);
      console.log(`[bulkB] ${spec.name.padEnd(16)} ${linkTable.padEnd(30)} ${bucket.rows.length}`);
    }
  }
}

/** TRUNCATE every api::* content table (CASCADE truncates their relation link tables too). */
async function wipe(app) {
  const tables = [];
  for (const u of Object.keys(app.contentTypes)) {
    if (!u.startsWith('api::')) continue;
    const meta = app.db.metadata.get(u);
    if (meta && meta.tableName) tables.push(meta.tableName);
  }
  if (!tables.length) {
    console.log('[wipe] no api:: content tables found — nothing to truncate');
    return;
  }
  const list = tables.map((t) => `"${t}"`).join(', ');
  await app.db.connection.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  console.log(`[wipe] truncated ${tables.length} content tables (CASCADE → link tables)`);
}

const uid = (n) => `api::${n}.${n}`;
// Bounded write concurrency. Default 24 is fine for a local DB; lower it (SEED_CONCURRENCY=4) for a
// remote/managed Postgres (e.g. Azure) whose connection limit + latency the higher fan-out overruns.
const CONC = parseInt(process.env.SEED_CONCURRENCY || '24', 10);

// ── content specs ────────────────────────────────────────────────────────────
// Each: { name, key, load, keyOf?, scalars, rel? }.  scalars(r) → non-relation fields; rel(r, R) →
// relation fields resolved via R.one(name,key)/R.many(name,keys). Omit `key` (added from keyOf).
function buildSpecs() {
  const load = (p) => () => readJson(p);
  return [
    // ── geography leaves ──
    { name: 'country', key: 'tag', keyOf: (r) => r.tag, load: load(join(MAP, 'countries.json')),
      scalars: (r) => ({ name: r.name, color: r.color }) },
    { name: 'culture', key: 'key', load: load(join(MAP, 'cultures.json')),
      scalars: (r) => ({ name: r.name, group: r.group, color: r.color }) },
    { name: 'religion', key: 'key', load: load(join(MAP, 'religions.json')),
      scalars: (r) => ({ name: r.name, group: r.group, color: r.color }) },
    { name: 'trade-good', key: 'key', load: load(join(MAP, 'tradegoods.json')),
      scalars: (r) => ({ name: r.name, color: r.color, category: r.category }) },

    // ── terrain / plot reference ──
    { name: 'terrain', key: 'key', keyOf: (r) => r.type, load: load(join(GEN, 'terrains.json')),
      scalars: (r) => ({ yields: r.yields, found: r.bFound, buildModifier: r.buildModifier,
        healthPercent: r.healthPercent, movement: r.movement }) },
    { name: 'feature', key: 'key', keyOf: (r) => r.type, load: load(join(GEN, 'features.json')),
      scalars: (r) => ({ yieldChanges: r.yieldChanges, clearCost: r.clearCost,
        requiresFlatlands: r.requiresFlatlands, requiresRiver: r.requiresRiver,
        healthPercent: r.healthPercent, growth: r.growth, movement: r.movement, appearance: r.appearance }),
      rel: (r, R) => ({ validTerrains: R.many('terrain', r.validTerrains) }) },
    { name: 'bonus', key: 'key', keyOf: (r) => r.type,
      load: () => [...readJson(join(GEN, 'bonuses.json')), ...readJson(join(GEN, 'manufactured-bonuses.json'))],
      scalars: (r) => ({ bonusClass: enumOrNull(r.bonusClass), yieldChanges: r.yieldChanges,
        health: r.health, happiness: r.happiness, minLatitude: r.minLatitude, maxLatitude: r.maxLatitude,
        hills: r.hills, flatlands: r.flatlands, peaks: r.peaks, placementOrder: r.placementOrder,
        constAppearance: r.constAppearance, randApps: r.randApps, tilesPer: r.tilesPer,
        minAreaSize: r.minAreaSize, groupRange: r.groupRange, groupRand: r.groupRand, techEra: r.techEra }),
      rel: (r, R) => ({ techReveal: R.one('tech', r.techReveal), techCityTrade: R.one('tech', r.techCityTrade),
        validTerrains: R.many('terrain', r.validTerrains), validFeatures: R.many('feature', r.validFeatures),
        validFeatureTerrains: R.many('terrain', r.validFeatureTerrains) }) },
    { name: 'improvement', key: 'key', keyOf: (r) => r.type, load: load(join(GEN, 'improvements.json')),
      scalars: (r) => ({ yieldChanges: r.yieldChanges, hillsMakesValid: r.hillsMakesValid,
        freshWaterMakesValid: r.freshWaterMakesValid, buildCost: r.buildCost, healthPercent: r.healthPercent,
        upgradeTime: r.upgradeTime, culture: r.culture, actsAsCity: r.actsAsCity, techYieldChanges: r.techYieldChanges }),
      rel: (r, R) => ({ prereqTech: R.one('tech', r.prereqTech), validTerrains: R.many('terrain', r.validTerrains),
        validFeatures: R.many('feature', r.validFeatures), upgradeType: R.one('improvement', r.upgradeType) }) },
    { name: 'route', key: 'key', keyOf: (r) => r.type, load: load(join(GEN, 'routes.json')),
      scalars: (r) => ({ value: r.value, movement: r.movement, flatMovement: r.flatMovement,
        advancedStartCost: r.advancedStartCost, seaTunnel: r.seaTunnel, yields: r.yields, trail: r.trail }),
      rel: (r, R) => ({ bonusType: R.one('bonus', r.bonusType) }) },
    { name: 'terrain-art', key: 'artTag', keyOf: (r) => r.artTag, load: load(join(MAP, 'terrain-art.json')),
      scalars: (r) => ({ path: r.path, grid: r.grid, detail: r.detail, layerOrder: r.layerOrder,
        alphaShader: r.alphaShader, blend: r.blend }),
      rel: (r, R) => ({ terrain: R.one('terrain', r.terrain) }) },
    { name: 'route-model', key: 'key',
      keyOf: (r) => `${r.routeType}_${r.modelFileKey}_${r.connections}_${r.modelConnections}`,
      load: load(join(MAP, 'route-models.json')),
      scalars: (r) => ({ modelFileKey: r.modelFileKey, modelFile: r.modelFile, lateModelFile: r.lateModelFile,
        animated: r.animated, connections: r.connections, modelConnections: r.modelConnections, rotations: r.rotations }),
      rel: (r, R) => ({ routeType: R.one('route', r.routeType) }) },

    // ── tech tree (self-graph) + game definitions ──
    { name: 'tech', key: 'key', keyOf: (r) => r.Type, load: load(join(GEN, 'techs.json')),
      scalars: (r) => ({ name: r.name, help: r.help, quote: r.quote, description: r.Description,
        civilopedia: r.Civilopedia, advisor: enumOrNull(r.Advisor), era: stripEra(r.Era), cost: int(r.iCost),
        gridX: int(r.iGridX), gridY: int(r.iGridY), trade: bool(r.bTrade), goodyTech: bool(r.bGoodyTech),
        sound: r.Sound, button: r.Button, flavors: r.Flavors }),
      rel: (r, R) => ({ andPreReqs: R.many('tech', prereqs(r.AndPreReqs)), orPreReqs: R.many('tech', prereqs(r.OrPreReqs)) }) },
    { name: 'combat-class', key: 'key', keyOf: (r) => r.id, load: load(join(GEN, 'unit-combats.json')),
      scalars: (r) => ({ name: r.name, signatureSkill: enumOrNull(r.signatureSkill), categoryButton: r.categoryButton,
        earlyWithdrawChange: r.iEarlyWithdrawChange, tauntChange: r.iTauntChange,
        dodgeModifierChange: r.iDodgeModifierChange, damageModifierChange: r.iDamageModifierChange,
        precisionModifierChange: r.iPrecisionModifierChange,
        captureResistanceModifierChange: r.iCaptureResistanceModifierChange, forMilitary: r.bForMilitary }) },
    { name: 'building', key: 'key', keyOf: (r) => r.id, load: load(join(GEN, 'buildings.json')),
      scalars: (r) => ({ name: r.name, pedia: r.pedia, category: enumOrNull(r.category),
        artDefineTag: r.artDefineTag, button: r.button, cost: int(r.cost),
        autoBuild: r.autoBuild, kind: enumOrNull(r.kind), flavors: r.flavors, replacedBy: r.replacedBy }),
      rel: (r, R) => ({ prereqTech: R.one('tech', r.prereqTech), obsoleteTech: R.one('tech', r.obsoleteTech),
        andTechs: R.many('tech', r.andTechs) }) },
    { name: 'unit', key: 'key', keyOf: (r) => r.id, load: load(join(GEN, 'units.json')),
      scalars: (r) => ({ name: r.name || r.id, pedia: r.pedia, defaultUnitAI: enumOrNull(r.defaultUnitAI),
        caravanRole: enumOrNull(r.caravanRole), domain: enumOrNull(r.domain), quality: enumOrNull(r.quality),
        bandSizeClass: enumOrNull(r.bandSizeClass), moves: r.iMoves, combat: r.iCombat, builds: r.builds,
        artDefineTag: r.artDefineTag, button: r.button, special: r.special, species: r.species }),
      rel: (r, R) => ({ prereqTech: R.one('tech', r.prereqTech), obsoleteTech: R.one('tech', r.obsoleteTech),
        combatClass: R.one('combat-class', r.combatClass), andTechs: R.many('tech', r.andTechs) }) },
    // NOTE: authoredCost is deliberately NOT in the housing scalars — it is studio-authored
    // content the seeder must never overwrite (docs/build-queue-plan.md B2).
    { name: 'housing', key: 'key', keyOf: (r) => r.type, load: load(join(GEN, 'housing.json')),
      scalars: (r) => ({ name: r.name, cost: int(r.cost),
        prereqPopulation: r.prereqPopulation, freshWater: r.freshWater, autoBuild: r.autoBuild,
        health: r.health, happiness: r.happiness, yieldChanges: r.yieldChanges, commerceChanges: r.commerceChanges }),
      rel: (r, R) => ({ prereqTech: R.one('tech', r.prereqTech), obsoleteTech: R.one('tech', r.obsoleteTech),
        obsoletesToBuilding: R.one('building', r.obsoletesToBuilding), bonus: R.one('bonus', r.bonus),
        prereqBonuses: R.many('bonus', r.prereqBonuses), prereqBuildings: R.many('building', r.prereqBuildings),
        prereqOrBuildings: R.many('building', r.prereqOrBuildings), replacements: R.many('building', r.replacements),
        prereqOrFeatures: R.many('feature', r.prereqOrFeatures), prereqOrTerrains: R.many('terrain', r.prereqOrTerrains) }) },
    { name: 'recipe', key: 'key', keyOf: (r) => r.type, load: load(join(GEN, 'recipes.json')),
      scalars: (r) => ({ river: r.river, freshWater: r.freshWater }),
      rel: (r, R) => ({ building: R.one('building', r.type), bonus: R.one('bonus', r.bonus),
        outputs: R.many('bonus', r.outputs), prereqBonuses: R.many('bonus', r.prereqBonuses),
        vicinityBonuses: R.many('bonus', r.vicinityBonuses), rawVicinityBonuses: R.many('bonus', r.rawVicinityBonuses),
        prereqTech: R.one('tech', r.prereqTech), obsoleteTech: R.one('tech', r.obsoleteTech),
        prereqBuildings: R.many('building', r.prereqBuildings), prereqOrBuildings: R.many('building', r.prereqOrBuildings),
        prereqOrTerrains: R.many('terrain', r.prereqOrTerrains), prereqOrFeatures: R.many('feature', r.prereqOrFeatures) }) },
    { name: 'resource-source', key: 'key', keyOf: (r) => r.type, load: load(join(GEN, 'tier1-providers.json')),
      scalars: (r) => ({ gatherers: r.gatherers }),
      rel: (r, R) => ({ output: R.one('bonus', r.output) }) },

    // ── geography hierarchy + hub ──
    { name: 'area', key: 'key', load: load(join(MAP, 'areas.json')),
      scalars: (r) => ({ name: r.name }),
      rel: (r, R) => ({ provinces: R.many('province', r.provinces) }) },
    { name: 'region', key: 'key', load: load(join(MAP, 'regions.json')),
      scalars: (r) => ({ name: r.name }),
      rel: (r, R) => ({ areas: R.many('area', r.areas) }) },
    { name: 'super-region', key: 'key', load: load(join(MAP, 'superregions.json')),
      scalars: (r) => ({ name: r.name }),
      rel: (r, R) => ({ regions: R.many('region', r.regions) }) },
    { name: 'province', key: 'provinceId', keyOf: (r) => r.id, load: load(join(MAP, 'provinces.json')),
      scalars: (r) => ({ name: r.name, latitude: r.lat, longitude: r.lon, plots: r.plots, waterPlots: r.waterPlots,
        type: enumOrNull(r.type), continent: enumOrNull(r.continent), realm: enumOrNull(r.realm),
        winter: enumOrNull(r.winter), monsoon: enumOrNull(r.monsoon), climate: enumOrNull(r.climate),
        baseTax: r.base_tax, baseProduction: r.base_production, baseManpower: r.base_manpower, city: r.city }),
      rel: (r, R) => ({ owner: R.one('country', r.owner), controller: R.one('country', r.controller),
        culture: R.one('culture', r.culture), religion: R.one('religion', r.religion),
        tradeGood: R.one('trade-good', r.trade_goods), area: R.one('area', r.area), region: R.one('region', r.region),
        neighbors: R.many('province', r.neighbors) }) },

    // ── geometry sidecars ──
    { name: 'adjacency', key: 'key', keyOf: (r) => `${r.from}_${r.to}`, load: load(join(MAP, 'adjacencies.json')),
      scalars: (r) => ({ type: enumOrNull(r.type), comment: r.comment }),
      rel: (r, R) => ({ from: R.one('province', r.from), to: R.one('province', r.to) }) },
    { name: 'province-edge', key: 'provinceId', keyOf: (r) => r.id, load: load(join(MAP, 'edges.json')),
      scalars: (r) => ({ km: r.km }),
      rel: (r, R) => ({ province: R.one('province', r.id) }) },
    { name: 'province-portal', key: 'provinceId', keyOf: (r) => r.id, load: load(join(MAP, 'portals.json')),
      scalars: (r) => ({ portals: r.portals }),
      rel: (r, R) => ({ province: R.one('province', r.id) }) },
  ];
}

// ── seeder ───────────────────────────────────────────────────────────────────
async function main() {
  // Content source: the committed world-bundle by default (generated/ is ephemeral exporter scratch).
  // --from-generated reads the freshly-written generated/ tree instead — the local regen path, where the
  // exporters have just produced new content and studio is seeded from it before a fixture snapshot.
  // --bundle <path> overrides the snapshot location (else SEED_BUNDLE env, else the committed fixture).
  if (!process.argv.includes('--from-generated')) {
    const i = process.argv.indexOf('--bundle');
    const path = (i >= 0 && process.argv[i + 1]) || process.env.SEED_BUNDLE || FIXTURE;
    BUNDLE = loadBundle(path);
    console.log(`[seed] bundle mode: ${path}`
      + ` (meta=${JSON.stringify(BUNDLE.meta)}, ${Object.keys(BUNDLE.resources).length} datasets)`);
  } else {
    console.log('[seed] file mode (--from-generated): reading the generated/ exporter scratch tree');
  }

  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  // This Strapi rejects a bare documentId on a relation whose TARGET is i18n-localized ("Invalid
  // relations") — it needs the locale-qualified connect form { set: [{ documentId, locale }] }. localizeRels
  // rewrites exactly those fields (non-i18n targets like terrain/bonus stay bare, which works). Without
  // this, every relation to an i18n type (province.owner/culture/religion, region.areas, …) silently
  // failed the PHASE B update — the bulk of the old "row errors". Document-Service path only; the --bulk
  // raw-INSERT path writes link tables directly and never hits this validator.
  const LOCALIZED = new Set(Object.entries(app.contentTypes)
    .filter(([, ct]) => ct.pluginOptions?.i18n?.localized).map(([u]) => u));
  const localizeRels = (u, data) => {
    const attrs = app.contentTypes[u].attributes;
    const out = {};
    for (const [field, val] of Object.entries(data)) {
      const target = attrs[field]?.target;
      if (target && LOCALIZED.has(target) && val != null) {
        const ids = Array.isArray(val) ? val : [val];
        out[field] = { set: ids.map((id) => ({ documentId: id, locale: 'en' })) };
      } else out[field] = val;
    }
    return out;
  };

  // --wipe: TRUNCATE every api::* content table (CASCADE → their relation link tables) before seeding,
  // for a CLEAN reseed. Needed when a DB carries stale rows the idempotent upsert wouldn't remove
  // (e.g. prod still holding old-model provinces/countries). Only touches api::* tables — admin/plugin
  // tables are untouched.
  // --bulk (raw SQL, ~100x fewer round-trips — for a remote/high-latency DB) always wipes itself.
  const bulk = process.argv.includes('--bulk');
  if (process.argv.includes('--wipe') && !bulk) await wipe(app);

  const specs = buildSpecs();
  const maps = {}; // name → Map(naturalKey → documentId)
  let misses = 0;
  const errors = []; // {phase, name, key, msg}
  const rec = (phase, name, key, e) => {
    if (errors.length < 20) errors.push(`[${phase}] ${name} ${key}: ${e.message}`);
    errors.count = (errors.count || 0) + 1;
  };

  const R = {
    one: (name, key) => {
      if (key === null || key === undefined) return undefined;
      const id = maps[name] && maps[name].get(key);
      if (!id) misses++;
      return id;
    },
    many: (name, keys) => {
      const m = maps[name] || new Map();
      return (keys || []).map((k) => {
        const id = m.get(k);
        if (!id) misses++;
        return id;
      }).filter(Boolean);
    },
  };

  async function findAll(u, fields) {
    const out = [];
    const PAGE = 2000;
    for (let start = 0; ; start += PAGE) {
      const batch = await app.documents(u).findMany({ fields, start, limit: PAGE });
      out.push(...batch);
      if (batch.length < PAGE) break;
    }
    return out;
  }

  if (bulk) {
    // Fast path: raw bulk INSERT (see bulkSeed). The loose bits below still use the Document Service.
    await bulkSeed(app, specs);
  } else {
    // PHASE A — scalars, build key→documentId maps
    for (const spec of specs) {
      const u = uid(spec.name);
      const keyOf = spec.keyOf || ((r) => r[spec.key]);
      spec.rows = spec.load();
      const existing = new Map();
      for (const d of await findAll(u, [spec.key])) existing.set(d[spec.key], d.documentId);
      const map = new Map();
      let created = 0;
      let updated = 0;
      await pool(spec.rows, CONC, async (row) => {
        const key = keyOf(row);
        const data = clean({ [spec.key]: key, ...spec.scalars(row) });
        try {
          const docId = existing.get(key);
          if (docId) {
            await app.documents(u).update({ documentId: docId, data });
            map.set(key, docId);
            updated++;
          } else {
            const doc = await app.documents(u).create({ data });
            map.set(key, doc.documentId);
            created++;
          }
        } catch (e) {
          rec('A', spec.name, key, e);
        }
      });
      maps[spec.name] = map;
      console.log(`[A] ${spec.name.padEnd(16)} ${String(spec.rows.length).padStart(5)}  (+${created} ~${updated})`);
    }

    // PHASE B — relations
    for (const spec of specs) {
      if (!spec.rel) continue;
      const u = uid(spec.name);
      const keyOf = spec.keyOf || ((r) => r[spec.key]);
      let linked = 0;
      await pool(spec.rows, CONC, async (row) => {
        const docId = maps[spec.name].get(keyOf(row));
        if (!docId) return;
        const data = clean(spec.rel(row, R));
        if (Object.keys(data).length === 0) return;
        try {
          await app.documents(u).update({ documentId: docId, data: localizeRels(u, data) });
          linked++;
        } catch (e) {
          rec('B', spec.name, keyOf(row), e);
        }
      });
      console.log(`[B] ${spec.name.padEnd(16)} linked ${linked}`);
    }
  }

  // ── calendar / naming (no relations) ──
  await wipeReseed(app, uid('feast'), loadFeasts(), (r) => r);
  await upsertPlain(app, uid('name-pool'), 'key', loadNamePools(), (r) => r);

  // ── wiki lore: scalars + one-way correlation relations to the canonical types (via entityRef/Key) ──
  await seedWikiArticles(app, findAll);

  // ── single types (this pass: the ones with a real source) ──
  await setSingle(app, uid('region-earth-map'), loadRegionEarthMap());
  await setSingle(app, uid('map-version'), loadMapVersion());
  await setSingleIfSourced(app, uid('economy-matrix'), loadEconomies());

  // ── balance profiles (a collection, one row per profile; gitignored source, so skip if absent) ──
  const profiles = loadBalanceProfiles();
  if (profiles) await upsertPlain(app, uid('balance-profile'), 'key', profiles, (r) => ({ label: r.label, configs: r.configs }));
  else console.log('[C] balance-profile   SKIPPED — no source file'
    + ' (run: mvn -pl civstudio-engine exec:exec -Dsim.main=com.civstudio.balance.export.BalanceProfileExporter)');

  // ── scenarios (a collection, one row per ScenarioDef; gitignored source, so skip if absent) ──
  const scenarios = loadScenarios();
  if (scenarios) await upsertPlain(app, uid('scenario'), 'key', scenarios,
    (r) => ({ label: r.label, blurb: r.blurb, shape: r.shape, balanceProfile: r.balanceProfile, flags: r.flags }));
  else console.log('[C] scenario          SKIPPED — no source file'
    + ' (run: mvn -pl civstudio-engine exec:exec -Dsim.main=com.civstudio.scenario.export.ScenarioExporter)');

  console.log(`[seed] done. unresolved relation targets: ${misses}; row errors: ${errors.count || 0}`);
  if (errors.length) console.log('  sample errors:\n   ' + errors.join('\n   '));
  await app.destroy();
}

// ── loose seeders (keyless / single) ─────────────────────────────────────────
async function wipeReseed(app, u, rows, toData) {
  const existing = [];
  const PAGE = 2000;
  for (let start = 0; ; start += PAGE) {
    const batch = await app.documents(u).findMany({ fields: ['documentId'], start, limit: PAGE });
    existing.push(...batch);
    if (batch.length < PAGE) break;
  }
  await pool(existing, CONC, (d) => app.documents(u).delete({ documentId: d.documentId }));
  await pool(rows, CONC, (r) => app.documents(u).create({ data: clean(toData(r)) }));
  console.log(`[C] ${u.split('.').pop().padEnd(16)} reseeded ${rows.length}`);
}

async function upsertPlain(app, u, key, rows, toData) {
  const existing = new Map();
  for (const d of await app.documents(u).findMany({ fields: [key], limit: 5000 })) existing.set(d[key], d.documentId);
  await pool(rows, CONC, async (r) => {
    const data = clean({ [key]: r[key], ...toData(r) });
    const docId = existing.get(r[key]);
    if (docId) await app.documents(u).update({ documentId: docId, data });
    else await app.documents(u).create({ data });
  });
  console.log(`[C] ${u.split('.').pop().padEnd(16)} upserted ${rows.length}`);
}

async function setSingle(app, u, data) {
  const cur = await app.documents(u).findFirst();
  if (cur) await app.documents(u).update({ documentId: cur.documentId, data: clean(data) });
  else await app.documents(u).create({ data: clean(data) });
  console.log(`[S] ${u.split('.').pop()} set`);
}

// As setSingle, but skips (loudly) when the source file is absent rather than writing an empty row.
// The economy matrix is generated by the engine's EconomyExporter into a GITIGNORED directory, so a
// clean checkout legitimately has none — and seeding `{}` there would turn "unauthored, keep the
// compiled constants" into "authored emptiness", which is a silent retune of every colony.
async function setSingleIfSourced(app, u, data) {
  if (!data) {
    console.log(`[S] ${u.split('.').pop()} SKIPPED — no source file`
      + ` (run: mvn -pl civstudio-engine exec:exec -Dsim.main=com.civstudio.era.export.EconomyExporter)`);
    return;
  }
  await setSingle(app, u, data);
}

// Wiki lore is NOT engine world-bundle content (the Java sim never reads it — it's for the web viewer +
// the future lore chatbot, which read Strapi directly). So it does not ride the bundle: the seeder reads
// the committed gzipped subset straight from src/main/resources (docs/wiki-lore-import-plan.md P1) — the
// one committed WikiArticleExporter output, like the GeoNames subset, so a clean checkout / CI seeds it
// without re-scraping. Kept behind an existence guard (absent != empty) for robustness.
// entityRef → [canonical type, its natural-key field, the wiki-article one-way m2o field to set]
const WIKI_REF = {
  country: ['country', 'tag', 'country'], culture: ['culture', 'key', 'culture'],
  religion: ['religion', 'key', 'religion'], province: ['province', 'provinceId', 'province'],
  region: ['region', 'key', 'region'], 'super-region': ['super-region', 'key', 'superRegion'],
};
async function seedWikiArticles(app, findAll) {
  const f = join(RES, 'wiki', 'wiki-article.json.gz');
  if (!existsSync(f)) {
    console.log('[C] wiki-article     SKIPPED — no source file'
      + ' (run: mvn -pl civstudio-engine exec:exec -Dsim.main=com.civstudio.wiki.export.WikiArticleExporter)');
    return;
  }
  const rows = JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));
  const u = uid('wiki-article');

  // PHASE A — scalars, building key → documentId
  const existing = new Map();
  for (const d of await findAll(u, ['key'])) existing.set(d.key, d.documentId);
  const wmap = new Map();
  await pool(rows, CONC, async (r) => {
    const data = clean({ key: r.key, title: r.title, pageId: r.pageId, url: r.url, template: r.template,
      entityType: r.entityType, entityRef: r.entityRef, entityKey: r.entityKey, isStub: r.isStub,
      imageFile: r.imageFile, imageUrl: r.imageUrl,
      summary: r.summary, body: r.body, categories: r.categories, links: r.links, infobox: r.infobox });
    const docId = existing.get(r.key);
    if (docId) { await app.documents(u).update({ documentId: docId, data }); wmap.set(r.key, docId); }
    else { const doc = await app.documents(u).create({ data }); wmap.set(r.key, doc.documentId); }
  });

  // PHASE B — correlation relations. entityRef names the canonical collection, entityKey its natural key;
  // resolve to a documentId (queried here, so this works in bundle & bulk modes alike) and set the
  // one-way m2o. entityKey is a string but a natural key may be numeric (provinceId) — match on String().
  const refs = new Set(rows.filter((r) => r.entityRef && r.entityKey && WIKI_REF[r.entityRef]).map((r) => r.entityRef));
  const canon = {};
  for (const ref of refs) {
    const [type, keyField] = WIKI_REF[ref];
    const m = new Map();
    for (const d of await findAll(uid(type), [keyField])) m.set(String(d[keyField]), d.documentId);
    canon[ref] = m;
  }
  // Both wiki-article and the canonical types are i18n-localized; this Strapi version rejects a bare
  // documentId on such a relation ("Invalid relations") and requires the locale-qualified connect form
  // {set:[{documentId, locale}]}. (The core seeder's bare-documentId rels silently fail the same way —
  // that's the bulk of its logged "row errors" — but it swallows them; we don't, so use the working form.)
  let linked = 0, relFail = 0;
  await pool(rows, CONC, async (r) => {
    if (!r.entityRef || !r.entityKey || !WIKI_REF[r.entityRef]) return;
    const targetId = canon[r.entityRef] && canon[r.entityRef].get(String(r.entityKey));
    if (!targetId) return;
    try {
      await app.documents(u).update({ documentId: wmap.get(r.key),
        data: { [WIKI_REF[r.entityRef][2]]: { set: [{ documentId: targetId, locale: 'en' }] } } });
      linked++;
    } catch (e) {
      relFail++;
    }
  });
  console.log(`[C] wiki-article     upserted ${rows.length}, linked ${linked}` + (relFail ? `, ${relFail} rel failures` : ''));
}

// ── source loaders for the loose bits ────────────────────────────────────────
function loadEconomies() {
  const f = join(GEN, 'balance', 'economies.json');
  if (!hasSource(f)) return null;
  return { economies: readJson(f) };
}
function loadBalanceProfiles() {
  // /balance/profiles.json is a map { key -> BalanceProfile }; flatten to one row per profile
  const f = join(GEN, 'balance', 'profiles.json');
  if (!hasSource(f)) return null;
  const map = readJson(f);
  return Object.entries(map).map(([key, configs]) => ({ key, label: key, configs }));
}
function loadScenarios() {
  // /scenarios.json is already a list of ScenarioDefs — one row each
  const f = join(GEN, 'scenarios.json');
  if (!hasSource(f)) return null;
  return readJson(f);
}
function loadFeasts() {
  const out = [];
  for (const [race, file] of [['human', join(RES, 'feasts.json')], ['harimari', join(RES, 'feasts-harimari.json')]]) {
    for (const f of readJson(file)) out.push({ month: f.month, day: f.day, name: f.name, race });
  }
  return out;
}
function loadNamePools() {
  // Only human names are committed/authored (/human-names/). Non-human races' pools are generated on
  // demand at runtime by NameStore (a gitignored per-machine cache under generated/names/) and are NOT
  // read from the world bundle — so studio holds the human pools only. (generated/names/ is gitignored,
  // so a clean CI checkout has no harimari cache anyway.)
  const dir = join(RES, 'human-names');
  return ['male', 'female', 'dynasty'].map((kind) => ({
    key: `human-${kind}`, race: 'human', kind, names: readJson(join(dir, `${kind}.json`)),
  }));
}
function loadRegionEarthMap() {
  const { note, specialNotes, ...regions } = readJson(join(RES, 'geo', 'region-earth-map.json'));
  const notes = [note, specialNotes ? JSON.stringify(specialNotes, null, 2) : null].filter(Boolean).join('\n\n');
  return { regions, notes };
}
function loadMapVersion() {
  // In bundle mode the version travels WITH the content — DERIVED from it, not copied from the
  // snapshot's meta. That distinction is the whole fix: contentVersion is Strapi's cache key for the
  // world-bundle projection, so a reseed whose data changed but whose stamp did not invalidates
  // nothing. On 2026-07-27 the six-realm split changed every province's `realm` while the stamp
  // stayed `seed-2026-07-23`; the reseed reported 5,268 provinces and 0 errors, and prod went on
  // serving the pre-split world ("Cannor: 0 provinces") because the key had not moved.
  //
  // Hashing the payload makes that unstateable: the version cannot fail to move when the content
  // does. The snapshot's own meta.contentVersion is kept only as a cross-check (tools/
  // verify-content-parity.mjs restamps it), never as the source of truth.
  if (BUNDLE) {
    const derived = contentHash(BUNDLE.resources);
    if (BUNDLE.meta.contentVersion && BUNDLE.meta.contentVersion !== derived)
      console.log(`[meta] contentVersion ${derived} (snapshot meta says `
        + `"${BUNDLE.meta.contentVersion}" — the DERIVED value wins; `
        + 'run `node tools/verify-content-parity.mjs --restamp` to restamp the committed snapshot)');
    return { mapVersion: BUNDLE.meta.mapVersion, contentVersion: derived,
      note: 'Seeded from the committed world-bundle by scripts/seed.js; contentVersion derived from its content.' };
  }
  const src = readFileSync(join(RES, '..', 'java', 'com', 'civstudio', 'settlement', 'ProvincePlotStore.java'), 'utf8');
  const m = src.match(/MAP_VERSION\s*=\s*(\d+)/);
  const mapVersion = m ? parseInt(m[1], 10) : 0;
  const contentVersion = `seed-${new Date().toISOString().slice(0, 10)}`;
  return { mapVersion, contentVersion, note: 'Seeded from ProvincePlotStore.MAP_VERSION by scripts/seed.js.' };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
