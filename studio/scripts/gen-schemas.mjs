// gen-schemas.mjs — regenerate the repetitive CivStudio content-type schemas.
//
// Part of the "Studio as the engine's authoritative content store" rebuild
// (docs/studio-datamodel-rebuild-plan.md, Phase 2b). This emits the
// schema.json + thin factory controller/route/service for the ~26 repetitive
// collection types. The three odd/graph-heavy types (province, tech, recipe)
// are HAND-WRITTEN and deliberately NOT touched here — they are listed in
// HAND_WRITTEN as a guard.
//
// All enum value-sets live in ENUMS below — the single source of truth for the
// Strapi enums, mirrored from the engine (com.civstudio.{era,skill,race,agent}
// enums) and the measured C2C/Anbennar datasets (docs/studio-exporter-datasets.md).
// When an engine enum changes, edit ENUMS and re-run:  node scripts/gen-schemas.mjs
//
// Run from studio/:  node scripts/gen-schemas.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, 'src', 'api');

// Types authored by hand — never generated/overwritten here.
const HAND_WRITTEN = new Set(['province', 'tech', 'recipe']);

// ─────────────────────────────────────────────────────────────────────────────
// Enum value-sets — single source of truth (mirror the engine + datasets).
// ─────────────────────────────────────────────────────────────────────────────
const ENUMS = {
  // com.civstudio.era.Era (C2C_ERA_* keys; here the bare constant names)
  era: ['PREHISTORIC', 'ANCIENT', 'CLASSICAL', 'MEDIEVAL', 'RENAISSANCE',
    'INDUSTRIAL', 'ATOMIC', 'INFORMATION', 'NANOTECH', 'TRANSHUMAN'],
  // com.civstudio.tech.Advisor
  advisor: ['ADVISOR_GROWTH', 'ADVISOR_ECONOMY', 'ADVISOR_MILITARY',
    'ADVISOR_SCIENCE', 'ADVISOR_CULTURE', 'ADVISOR_RELIGION'],
  // com.civstudio.skill.Skill (12; combat-class signature skill)
  skill: ['STEWARDSHIP', 'CONSTRUCTION', 'SURVIVAL', 'WARFARE', 'COMMERCE',
    'FAITH', 'HUNTING', 'MEDICINE', 'SUBTERFUGE', 'INTELLECTUAL', 'SOCIAL',
    'PRODUCTION'],
  // com.civstudio.agent.CaravanRole
  caravanRole: ['COVERT', 'EXPLORER', 'HEALER', 'HUNTER', 'MILITARY',
    'MISSIONARY', 'SETTLER', 'TRADE', 'WORKER'],
  // com.civstudio.race.Race (id slugs)
  race: ['human', 'harimari', 'elven', 'dwarven', 'degenerated_elf',
    'amadian_ruinborn_elf', 'devandi_ruinborn_elf', 'effelai_ruinborn_elf',
    'eltibhari_ruinborn_elf', 'eordan_ruinborn_elf', 'harafic_ruinborn_elf',
    'kheionai_ruinborn_elf', 'north_ruinborn_elf', 'south_ruinborn_elf',
    'taychendi_ruinborn_elf', 'ynnic_ruinborn_elf', 'akasi', 'alenic',
    'anbennarian', 'bom', 'bulwari', 'businori', 'centaur', 'dostanorian_g',
    'escanni', 'gerudian', 'giantkind', 'gnollish', 'gnomish', 'goblin',
    'gowon', 'halfling', 'harpy', 'hobgoblin', 'inyaswarosa', 'irsukuba',
    'kai', 'kelino', 'khantaar', 'kheteratan', 'khudi', 'kobold', 'lencori',
    'lizardfolk', 'mengi', 'middle_raheni', 'ogre', 'orcish', 'reachman',
    'triunic', 'trollsbayer', 'tyvorkan', 'upper_raheni', 'vurebindu',
    'west_sarhaly', 'wuhyun', 'yan', 'yanglam'],
  // geo descriptor enums (measured from map/provinces.json)
  provinceType: ['LAND', 'CAVERN', 'DWARVEN_HOLD', 'DWARVEN_HOLD_SURFACE',
    'DWARVEN_ROAD', 'ANCIENT_FOREST', 'GLADEWAY', 'FEY_GLADEWAY', 'BLOODGROVES',
    'MUSHROOM_FOREST', 'SHADOW_SWAMP', 'GLACIER', 'SEA', 'LAKE', 'IMPASSABLE'],
  // six realms since the split (docs/realms.md §The six realms). `halcann` is RETAINED as a legacy
  // value: rows seeded before the split still carry it, and Realm.fromKey resolves it to `cannor`.
  realm: ['cannor', 'serpentspine', 'haless', 'sarhal', 'aelantir', 'hinuilands', 'halcann'],
  continent: ['europe', 'serpentspine', 'asia', 'africa', 'north_america',
    'south_america', 'oceania'],
  severity: ['mild', 'normal', 'severe'], // winter / monsoon
  climate: ['arctic', 'arid', 'tropical'], // TEMPERATE = default/absent
  tradeGoodCategory: ['FOOD', 'LUXURY', 'STRATEGIC', 'MANUFACTURED', 'MAGICAL'],
  adjacencyType: ['sea', 'canal', 'lake'],
  buildingCategory: ['CULTURE', 'ECONOMY', 'GROWTH', 'MILITARY', 'RELIGION',
    'SCIENCE'],
  // build-queue B2 (docs/build-queue-plan.md): non-regular building kinds; absent = regular
  buildingKind: ['housing'],
  bonusClass: ['BONUSCLASS_CROP', 'BONUSCLASS_LIVESTOCK', 'BONUSCLASS_LUXURY',
    'BONUSCLASS_MANUFACTURED', 'BONUSCLASS_MISC', 'BONUSCLASS_PRODUCTION',
    'BONUSCLASS_SEAFOOD', 'BONUSCLASS_STRATEGIC', 'BONUSCLASS_WONDER'],
  unitDomain: ['DOMAIN_LAND', 'DOMAIN_SEA', 'DOMAIN_AIR', 'DOMAIN_IMMOBILE'],
  unitQuality: ['QUALITY_PATHETIC', 'QUALITY_INFERIOR', 'QUALITY_POOR',
    'QUALITY_MEDIOCRE', 'QUALITY_STANDARD', 'QUALITY_EXCEPTIONAL',
    'QUALITY_SUPERIOR', 'QUALITY_ELITE', 'QUALITY_EPIC'],
  bandSizeClass: ['GROUP_SOLO', 'GROUP_PARTY', 'GROUP_SQUAD', 'GROUP_COMPANY',
    'GROUP_BATTALION', 'GROUP_FORCES'],
  unitAI: ['UNITAI_ARTIST', 'UNITAI_ATTACK', 'UNITAI_ATTACK_CITY',
    'UNITAI_CITY_COUNTER', 'UNITAI_CITY_DEFENSE', 'UNITAI_CITY_SPECIAL', 'UNITAI_COUNTER',
    'UNITAI_ENGINEER', 'UNITAI_EXPLORE', 'UNITAI_GENERAL', 'UNITAI_GREAT_ADMIRAL',
    'UNITAI_GREAT_HUNTER', 'UNITAI_HEALER', 'UNITAI_HUNTER', 'UNITAI_INFILTRATOR',
    'UNITAI_MERCHANT', 'UNITAI_MISSIONARY', 'UNITAI_PARADROP', 'UNITAI_PILLAGE',
    'UNITAI_PILLAGE_COUNTER', 'UNITAI_PROPERTY_CONTROL', 'UNITAI_PROPHET',
    'UNITAI_RESERVE', 'UNITAI_SCIENTIST', 'UNITAI_SETTLE', 'UNITAI_SPY',
    'UNITAI_SUBDUED_ANIMAL', 'UNITAI_WORKER'],
  nameKind: ['male', 'female', 'dynasty'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Attribute builders (produce plain Strapi attribute objects).
// Wrap a scalar/enum with L(...) to mark it localized under i18n.
// ─────────────────────────────────────────────────────────────────────────────
const S = (o = {}) => ({ type: 'string', ...o });
const T = (o = {}) => ({ type: 'text', ...o });
const I = (o = {}) => ({ type: 'integer', ...o });
const N = (o = {}) => ({ type: 'decimal', ...o });
const B = (o = {}) => ({ type: 'boolean', ...o });
const J = (o = {}) => ({ type: 'json', ...o });
const En = (key, o = {}) => ({ type: 'enumeration', enum: ENUMS[key], ...o });
const uid = (n) => `api::${n}.${n}`;
// one-way relations (no inverse) — the default for FK keys we don't navigate back
const m2o = (target, extra = {}) => ({ type: 'relation', relation: 'manyToOne', target: uid(target), ...extra });
const m2m = (target, extra = {}) => ({ type: 'relation', relation: 'manyToMany', target: uid(target), ...extra });
// bidirectional owning side (declares inversedBy on the target)
const m2oInv = (target, inversedBy) => ({ type: 'relation', relation: 'manyToOne', target: uid(target), inversedBy });
const L = (attr) => ({ ...attr, __loc: true }); // mark localized

// ─────────────────────────────────────────────────────────────────────────────
// Collection-type specs.  { name, plural?, display, description?, i18n?, attributes }
// ─────────────────────────────────────────────────────────────────────────────
const SPECS = [
  // ── Geography ──────────────────────────────────────────────────────────────
  {
    name: 'country', plural: 'countries', display: 'Country', i18n: true,
    description: 'A polity (Anbennar EU4 tag).',
    attributes: {
      tag: S({ required: true, unique: true }),
      name: L(S({ required: true })),
      color: S(), // #rrggbb
    },
  },
  {
    name: 'culture', display: 'Culture', i18n: true,
    attributes: {
      key: S({ required: true, unique: true }),
      name: L(S({ required: true })),
      group: S(),
      color: S(),
    },
  },
  {
    name: 'religion', display: 'Religion', i18n: true,
    attributes: {
      key: S({ required: true, unique: true }),
      name: L(S({ required: true })),
      group: S(),
      color: S(),
    },
  },
  {
    name: 'trade-good', display: 'Trade Good', i18n: true,
    attributes: {
      key: S({ required: true, unique: true }),
      name: L(S({ required: true })),
      color: S(),
      category: En('tradeGoodCategory'),
    },
  },
  {
    name: 'area', display: 'Area', i18n: true,
    attributes: {
      key: S({ required: true, unique: true }),
      name: L(S({ required: true })),
      provinces: m2m('province'),
    },
  },
  {
    name: 'region', display: 'Region', i18n: true,
    attributes: {
      key: S({ required: true, unique: true }),
      name: L(S({ required: true })),
      areas: m2m('area'),
    },
  },
  {
    name: 'super-region', display: 'Super Region', i18n: true,
    attributes: {
      key: S({ required: true, unique: true }),
      name: L(S({ required: true })),
      regions: m2m('region'),
    },
  },
  {
    name: 'adjacency', plural: 'adjacencies', display: 'Adjacency',
    description: 'A special province-to-province link (sea/canal/lake crossing).',
    attributes: {
      key: S({ required: true, unique: true }), // `${from}_${to}` — natural key for upsert
      from: m2o('province'),
      to: m2o('province'),
      type: En('adjacencyType'),
      comment: S(),
    },
  },
  {
    name: 'province-edge', display: 'Province Edge',
    description: 'Per-province land-route edge geometry (km parallel to province.neighbors).',
    attributes: {
      provinceId: I({ required: true, unique: true }), // the province id — natural key for upsert
      province: m2o('province'),
      km: J(), // [n] — parallel to the province's neighbor list
    },
  },
  {
    name: 'province-portal', display: 'Province Portal',
    description: 'Per-province portal pixel geometry (teleporter endpoints).',
    attributes: {
      provinceId: I({ required: true, unique: true }), // the province id — natural key for upsert
      province: m2o('province'),
      portals: J(), // [{ to, x, y }]
    },
  },
  {
    name: 'route-model', display: 'Route Model',
    description: 'Civ4 route (road/rail) render model — art reference.',
    attributes: {
      key: S({ required: true, unique: true }), // `${routeType}_${modelFileKey}_${connections}_${modelConnections}`
      routeType: m2o('route'),
      modelFileKey: S(),
      modelFile: S(),
      lateModelFile: S(),
      animated: B(),
      connections: S(),
      modelConnections: S(),
      rotations: J(),
    },
  },
  {
    name: 'terrain-art', plural: 'terrain-arts', display: 'Terrain Art',
    description: 'Per-terrain render art reference.',
    attributes: {
      terrain: m2o('terrain'),
      artTag: S(),
      path: S(),
      grid: S(),
      detail: S(),
      layerOrder: I(),
      alphaShader: B(),
      blend: J(),
    },
  },

  // ── Game definitions ────────────────────────────────────────────────────────
  {
    name: 'building', display: 'Building', i18n: true,
    description: 'A C2C building.',
    attributes: {
      key: S({ required: true, unique: true }), // BUILDING_*
      name: L(S({ required: true })),
      pedia: L(T()),
      category: En('buildingCategory'),
      prereqTech: m2oInv('tech', 'unlockedBuildings'),
      andTechs: m2m('tech'),
      artDefineTag: S(),
      button: S(),
      cost: I(),
      // build-queue B2 fields (docs/build-queue-plan.md): the flat-catalog view the
      // queue brain reads. kind=housing marks the BUILDING_HOUSING_* line (whose rich
      // catalog is the `housing` type); autoBuild marks C2C's bookkeeping autobuilds.
      obsoleteTech: m2o('tech'),
      autoBuild: B(),
      kind: En('buildingKind'),
      flavors: J(), // C2C <Flavors> AI build weights: { FLAVOR_*: int }
      replacedBy: J(), // C2C <ReplacementBuildings> upgrade chain: [BUILDING_*]
    },
  },
  {
    name: 'unit', display: 'Unit', i18n: true,
    description: 'A C2C land unit.',
    attributes: {
      key: S({ required: true, unique: true }), // UNIT_*
      name: L(S({ required: true })),
      pedia: L(T()),
      prereqTech: m2oInv('tech', 'unlockedUnits'),
      andTechs: m2m('tech'),
      obsoleteTech: m2o('tech'),
      combatClass: m2o('combat-class'),
      defaultUnitAI: En('unitAI'),
      caravanRole: En('caravanRole'),
      domain: En('unitDomain'),
      quality: En('unitQuality'),
      bandSizeClass: En('bandSizeClass'),
      moves: I(),
      combat: I(),
      builds: J(), // [key] → improvement/route (mixed target; kept as key list)
      artDefineTag: S(),
      button: S(),
      special: S(),
      species: S(),
    },
  },
  {
    name: 'combat-class', plural: 'combat-classes', display: 'Combat Class',
    description: 'A C2C unit combat class; maps to a signature skill.',
    attributes: {
      key: S({ required: true, unique: true }), // UNITCOMBAT_*
      name: S(),
      signatureSkill: En('skill'),
      categoryButton: S(),
      earlyWithdrawChange: I(),
      tauntChange: I(),
      dodgeModifierChange: I(),
      damageModifierChange: I(),
      precisionModifierChange: I(),
      captureResistanceModifierChange: I(),
      forMilitary: B(),
    },
  },
  {
    name: 'housing', plural: 'housings', display: 'Housing Building',
    description: 'A C2C housing building — the rung catalog the build economy\'s housing targeting reads (docs/build-queue-plan.md).',
    attributes: {
      key: S({ required: true, unique: true }), // BUILDING_HOUSING_*
      name: S(), // display name (GameText), so the admin list is readable
      // cost = the exporter's hand-priced default (C2C auto-grants housing, so it ships
      // no iCost); authoredCost = the studio-authored override the seeder NEVER writes,
      // so admin edits survive every re-seed. Effective build cost = authoredCost ?? cost.
      cost: I(),
      authoredCost: I(),
      prereqTech: m2o('tech'),
      obsoleteTech: m2o('tech'),
      obsoletesToBuilding: m2o('building'),
      prereqPopulation: I(),
      freshWater: B(),
      autoBuild: B(),
      bonus: m2o('bonus'),
      prereqBonuses: m2m('bonus'),
      prereqBuildings: m2m('building'),
      prereqOrBuildings: m2m('building'),
      prereqOrFeatures: m2m('feature'),
      prereqOrTerrains: m2m('terrain'),
      replacements: m2m('building'),
      health: I(),
      happiness: I(),
      yieldChanges: J(),
      commerceChanges: J(),
    },
  },
  {
    name: 'resource-source', display: 'Resource Source',
    description: 'A base (C2C tier-1) resource producer — output bonus + gatherers.',
    attributes: {
      key: S({ required: true, unique: true }),
      output: m2o('bonus'),
      gatherers: J(), // [{ type, prereqTech, bonus, prereqBonuses[], ... }]
    },
  },

  // ── Terrain / plot reference ─────────────────────────────────────────────────
  {
    name: 'terrain', plural: 'terrains', display: 'Terrain',
    attributes: {
      key: S({ required: true, unique: true }), // TERRAIN_*
      yields: J(),
      found: B(),
      buildModifier: I(),
      healthPercent: I(),
      movement: I(),
    },
  },
  {
    name: 'feature', display: 'Feature',
    attributes: {
      key: S({ required: true, unique: true }), // FEATURE_*
      yieldChanges: J(),
      clearCost: I(),
      requiresFlatlands: B(),
      requiresRiver: B(),
      validTerrains: m2m('terrain'),
      healthPercent: I(),
      growth: I(),
      movement: I(),
      appearance: I(),
    },
  },
  {
    name: 'bonus', plural: 'bonuses', display: 'Bonus',
    description: 'A resource bonus (absorbs manufactured-bonuses via bonusClass=BONUSCLASS_MANUFACTURED).',
    attributes: {
      key: S({ required: true, unique: true }), // BONUS_*
      bonusClass: En('bonusClass'),
      yieldChanges: J(),
      techReveal: m2o('tech'),
      techCityTrade: m2o('tech'),
      health: I(),
      happiness: I(),
      minLatitude: I(),
      maxLatitude: I(),
      hills: B(),
      flatlands: B(),
      peaks: B(),
      validTerrains: m2m('terrain'),
      validFeatures: m2m('feature'),
      validFeatureTerrains: m2m('terrain'),
      placementOrder: I(),
      constAppearance: I(),
      randApps: J(),
      tilesPer: I(),
      minAreaSize: I(),
      groupRange: I(),
      groupRand: I(),
      techEra: I(),
    },
  },
  {
    name: 'improvement', display: 'Improvement',
    attributes: {
      key: S({ required: true, unique: true }), // IMPROVEMENT_*
      yieldChanges: J(),
      prereqTech: m2o('tech'),
      hillsMakesValid: B(),
      freshWaterMakesValid: B(),
      validTerrains: m2m('terrain'),
      validFeatures: m2m('feature'),
      buildCost: I(),
      healthPercent: I(),
      upgradeType: m2o('improvement'), // self
      upgradeTime: I(),
      culture: I(),
      actsAsCity: B(),
      techYieldChanges: J(),
    },
  },
  {
    name: 'route', plural: 'routes', display: 'Route',
    attributes: {
      key: S({ required: true, unique: true }), // ROUTE_*
      value: I(), // tier
      movement: I(),
      flatMovement: I(),
      advancedStartCost: I(),
      bonusType: m2o('bonus'),
      seaTunnel: B(),
      yields: J(),
      trail: B(),
    },
  },

  // ── Naming / calendar ────────────────────────────────────────────────────────
  {
    name: 'name-pool', display: 'Name Pool',
    description: 'A per-(race, kind) pool of given/dynasty names.',
    attributes: {
      key: S({ required: true, unique: true }), // `${race}-${kind}`
      race: En('race'),
      kind: En('nameKind'),
      names: J(),
    },
  },
  {
    name: 'feast', display: 'Feast', i18n: true,
    description: 'A liturgical feast day (race-scoped).',
    attributes: {
      month: I(),
      day: I(),
      name: L(S()),
      race: En('race'),
    },
  },
  {
    name: 'tech-effect', display: 'Tech Effect',
    description: 'eos per-tech productivity overlay (race-scoped; placeholder stub today).',
    attributes: {
      key: S({ required: true, unique: true }),
      tech: m2o('tech'),
      race: En('race'),
      effects: J(),
    },
  },

  // ── Reference ────────────────────────────────────────────────────────────────
  {
    name: 'place-name', display: 'Place Name',
    description: 'GeoNames populated-place subset (plot place-naming).',
    attributes: {
      geonameId: I({ required: true, unique: true }),
      name: S({ required: true }),
      countryCode: S(),
      latitude: N(),
      longitude: N(),
      elevation: I(),
      featureClass: S(),
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Emit.
// ─────────────────────────────────────────────────────────────────────────────
const RELATION = new Set(['relation', 'media', 'component']);

function buildSchema(spec) {
  const plural = spec.plural ?? `${spec.name}s`;
  const attributes = {};
  for (const [attrName, raw] of Object.entries(spec.attributes)) {
    const { __loc, ...attr } = raw;
    if (spec.i18n && !RELATION.has(attr.type)) {
      // localizable type: every scalar/enum carries an explicit localized flag
      attr.pluginOptions = { i18n: { localized: !!__loc } };
    }
    attributes[attrName] = attr;
  }
  const schema = {
    kind: 'collectionType',
    collectionName: plural.replace(/-/g, '_'),
    info: { singularName: spec.name, pluralName: plural, displayName: spec.display },
    options: { draftAndPublish: false },
    pluginOptions: spec.i18n ? { i18n: { localized: true } } : {},
    attributes,
  };
  if (spec.description) schema.info.description = spec.description;
  return schema;
}

const factory = (kind, name) =>
  `import { factories } from '@strapi/strapi';\n\nexport default factories.createCore${kind}('${uid(name)}');\n`;

let count = 0;
for (const spec of SPECS) {
  if (HAND_WRITTEN.has(spec.name)) {
    throw new Error(`${spec.name} is hand-written — remove it from SPECS`);
  }
  const dir = join(API, spec.name);
  const ctDir = join(dir, 'content-types', spec.name);
  mkdirSync(ctDir, { recursive: true });
  mkdirSync(join(dir, 'controllers'), { recursive: true });
  mkdirSync(join(dir, 'routes'), { recursive: true });
  mkdirSync(join(dir, 'services'), { recursive: true });

  writeFileSync(join(ctDir, 'schema.json'), JSON.stringify(buildSchema(spec), null, 2) + '\n');
  writeFileSync(join(dir, 'controllers', `${spec.name}.ts`), factory('Controller', spec.name));
  writeFileSync(join(dir, 'routes', `${spec.name}.ts`), factory('Router', spec.name));
  writeFileSync(join(dir, 'services', `${spec.name}.ts`), factory('Service', spec.name));
  count++;
  console.log(`  ${spec.name}  (${Object.keys(spec.attributes).length} attrs)`);
}
console.log(`\nGenerated ${count} collection types into src/api/`);
console.log(`Hand-written (untouched): ${[...HAND_WRITTEN].join(', ')}`);
