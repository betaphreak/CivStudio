import type { Schema, Struct } from '@strapi/strapi';

export interface AdminApiToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_tokens';
  info: {
    description: '';
    displayName: 'Api Token';
    name: 'Api Token';
    pluralName: 'api-tokens';
    singularName: 'api-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    adminPermissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::permission'
    >;
    adminUserOwner: Schema.Attribute.Relation<'manyToOne', 'admin::user'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    encryptedKey: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    expiresAt: Schema.Attribute.DateTime;
    kind: Schema.Attribute.Enumeration<['content-api', 'admin']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'content-api'>;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::api-token'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::api-token-permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.Enumeration<['read-only', 'full-access', 'custom']> &
      Schema.Attribute.DefaultTo<'read-only'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminApiTokenPermission extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_token_permissions';
  info: {
    description: '';
    displayName: 'API Token Permission';
    name: 'API Token Permission';
    pluralName: 'api-token-permissions';
    singularName: 'api-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::api-token-permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::api-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminPermission extends Struct.CollectionTypeSchema {
  collectionName: 'admin_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'Permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    actionParameters: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    apiToken: Schema.Attribute.Relation<'manyToOne', 'admin::api-token'>;
    conditions: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<[]>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::permission'> &
      Schema.Attribute.Private;
    properties: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<'manyToOne', 'admin::role'>;
    subject: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminRole extends Struct.CollectionTypeSchema {
  collectionName: 'admin_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'Role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::role'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<'oneToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users: Schema.Attribute.Relation<'manyToMany', 'admin::user'>;
  };
}

export interface AdminSession extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_sessions';
  info: {
    description: 'Session Manager storage';
    displayName: 'Session';
    name: 'Session';
    pluralName: 'sessions';
    singularName: 'session';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
    i18n: {
      localized: false;
    };
  };
  attributes: {
    absoluteExpiresAt: Schema.Attribute.DateTime & Schema.Attribute.Private;
    childId: Schema.Attribute.String & Schema.Attribute.Private;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deviceId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    expiresAt: Schema.Attribute.DateTime &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::session'> &
      Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON & Schema.Attribute.Private;
    origin: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    sessionId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.Unique;
    status: Schema.Attribute.String & Schema.Attribute.Private;
    type: Schema.Attribute.String & Schema.Attribute.Private;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    userId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
  };
}

export interface AdminTransferToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_tokens';
  info: {
    description: '';
    displayName: 'Transfer Token';
    name: 'Transfer Token';
    pluralName: 'transfer-tokens';
    singularName: 'transfer-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    expiresAt: Schema.Attribute.DateTime;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token-permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminTransferTokenPermission
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_token_permissions';
  info: {
    description: '';
    displayName: 'Transfer Token Permission';
    name: 'Transfer Token Permission';
    pluralName: 'transfer-token-permissions';
    singularName: 'transfer-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token-permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::transfer-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminUser extends Struct.CollectionTypeSchema {
  collectionName: 'admin_users';
  info: {
    description: '';
    displayName: 'User';
    name: 'User';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    apiTokens: Schema.Attribute.Relation<'oneToMany', 'admin::api-token'> &
      Schema.Attribute.Private;
    blocked: Schema.Attribute.Boolean &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    firstname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    isActive: Schema.Attribute.Boolean &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<false>;
    lastname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::user'> &
      Schema.Attribute.Private;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    preferedLanguage: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    registrationToken: Schema.Attribute.String & Schema.Attribute.Private;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    roles: Schema.Attribute.Relation<'manyToMany', 'admin::role'> &
      Schema.Attribute.Private;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    username: Schema.Attribute.String;
  };
}

export interface ApiAdjacencyAdjacency extends Struct.CollectionTypeSchema {
  collectionName: 'adjacencies';
  info: {
    description: 'A special province-to-province link (sea/canal/lake crossing).';
    displayName: 'Adjacency';
    pluralName: 'adjacencies';
    singularName: 'adjacency';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    comment: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    from: Schema.Attribute.Relation<'manyToOne', 'api::province.province'>;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::adjacency.adjacency'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    to: Schema.Attribute.Relation<'manyToOne', 'api::province.province'>;
    type: Schema.Attribute.Enumeration<['sea', 'canal', 'lake']>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAreaArea extends Struct.CollectionTypeSchema {
  collectionName: 'areas';
  info: {
    displayName: 'Area';
    pluralName: 'areas';
    singularName: 'area';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::area.area'>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    provinces: Schema.Attribute.Relation<
      'manyToMany',
      'api::province.province'
    >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiBalanceProfileBalanceProfile
  extends Struct.CollectionTypeSchema {
  collectionName: 'balance_profiles';
  info: {
    description: "A named bundle of agent-behaviour tuning the engine founds a colony on (BalanceProfile: firm/bank/noble/retinue/laborer/wedding/granary/childrenFirm/strategicFirm/science/builderFirm configs). Served to the engine as /balance/profiles.json keyed by `key`; 'default' is always present. LOAD-BEARING \u2014 editing configs changes simulation behaviour, so a run is reproducible only as seed + contentVersion + command log. NOT the economy (that is the era x race matrix).";
    displayName: 'Balance Profile';
    pluralName: 'balance-profiles';
    singularName: 'balance-profile';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    configs: Schema.Attribute.JSON & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    label: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::balance-profile.balance-profile'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiBonusBonus extends Struct.CollectionTypeSchema {
  collectionName: 'bonuses';
  info: {
    description: 'A resource bonus (absorbs manufactured-bonuses via bonusClass=BONUSCLASS_MANUFACTURED).';
    displayName: 'Bonus';
    pluralName: 'bonuses';
    singularName: 'bonus';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    bonusClass: Schema.Attribute.Enumeration<
      [
        'BONUSCLASS_CROP',
        'BONUSCLASS_LIVESTOCK',
        'BONUSCLASS_LUXURY',
        'BONUSCLASS_MANUFACTURED',
        'BONUSCLASS_MISC',
        'BONUSCLASS_PRODUCTION',
        'BONUSCLASS_SEAFOOD',
        'BONUSCLASS_STRATEGIC',
        'BONUSCLASS_WONDER',
      ]
    >;
    constAppearance: Schema.Attribute.Integer;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    flatlands: Schema.Attribute.Boolean;
    groupRand: Schema.Attribute.Integer;
    groupRange: Schema.Attribute.Integer;
    happiness: Schema.Attribute.Integer;
    health: Schema.Attribute.Integer;
    hills: Schema.Attribute.Boolean;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::bonus.bonus'> &
      Schema.Attribute.Private;
    maxLatitude: Schema.Attribute.Integer;
    minAreaSize: Schema.Attribute.Integer;
    minLatitude: Schema.Attribute.Integer;
    peaks: Schema.Attribute.Boolean;
    placementOrder: Schema.Attribute.Integer;
    publishedAt: Schema.Attribute.DateTime;
    randApps: Schema.Attribute.JSON;
    techCityTrade: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    techEra: Schema.Attribute.Integer;
    techReveal: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    tilesPer: Schema.Attribute.Integer;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    validFeatures: Schema.Attribute.Relation<
      'manyToMany',
      'api::feature.feature'
    >;
    validFeatureTerrains: Schema.Attribute.Relation<
      'manyToMany',
      'api::terrain.terrain'
    >;
    validTerrains: Schema.Attribute.Relation<
      'manyToMany',
      'api::terrain.terrain'
    >;
    yieldChanges: Schema.Attribute.JSON;
  };
}

export interface ApiBuildingBuilding extends Struct.CollectionTypeSchema {
  collectionName: 'buildings';
  info: {
    description: 'A C2C building.';
    displayName: 'Building';
    pluralName: 'buildings';
    singularName: 'building';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    andTechs: Schema.Attribute.Relation<'manyToMany', 'api::tech.tech'>;
    artDefineTag: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    autoBuild: Schema.Attribute.Boolean &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    button: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    category: Schema.Attribute.Enumeration<
      ['CULTURE', 'ECONOMY', 'GROWTH', 'MILITARY', 'RELIGION', 'SCIENCE']
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    cost: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    flavors: Schema.Attribute.JSON &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    kind: Schema.Attribute.Enumeration<['housing']> &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::building.building'
    >;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    obsoleteTech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    pedia: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    prereqTech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    publishedAt: Schema.Attribute.DateTime;
    replacedBy: Schema.Attribute.JSON &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiCombatClassCombatClass extends Struct.CollectionTypeSchema {
  collectionName: 'combat_classes';
  info: {
    description: 'A C2C unit combat class; maps to a signature skill.';
    displayName: 'Combat Class';
    pluralName: 'combat-classes';
    singularName: 'combat-class';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    captureResistanceModifierChange: Schema.Attribute.Integer;
    categoryButton: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    damageModifierChange: Schema.Attribute.Integer;
    dodgeModifierChange: Schema.Attribute.Integer;
    earlyWithdrawChange: Schema.Attribute.Integer;
    forMilitary: Schema.Attribute.Boolean;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::combat-class.combat-class'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    precisionModifierChange: Schema.Attribute.Integer;
    publishedAt: Schema.Attribute.DateTime;
    signatureSkill: Schema.Attribute.Enumeration<
      [
        'STEWARDSHIP',
        'CONSTRUCTION',
        'SURVIVAL',
        'WARFARE',
        'COMMERCE',
        'FAITH',
        'HUNTING',
        'MEDICINE',
        'SUBTERFUGE',
        'INTELLECTUAL',
        'SOCIAL',
        'PRODUCTION',
      ]
    >;
    tauntChange: Schema.Attribute.Integer;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiCountryCountry extends Struct.CollectionTypeSchema {
  collectionName: 'countries';
  info: {
    description: 'A polity (Anbennar EU4 tag).';
    displayName: 'Country';
    pluralName: 'countries';
    singularName: 'country';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    color: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::country.country'
    >;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    publishedAt: Schema.Attribute.DateTime;
    tag: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiCultureCulture extends Struct.CollectionTypeSchema {
  collectionName: 'cultures';
  info: {
    displayName: 'Culture';
    pluralName: 'cultures';
    singularName: 'culture';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    color: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    group: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::culture.culture'
    >;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiEconomyMatrixEconomyMatrix extends Struct.SingleTypeSchema {
  collectionName: 'economy_matrices';
  info: {
    description: "The era x race economy matrix the engine founds colonies on: prices, agent starting balances, tax rates and peasant-pool sizing, keyed era -> race -> economy (enum names). Served to the engine as /balance/economies.json; a race with no column of its own falls back to HUMAN's. LOAD-BEARING \u2014 editing these numbers changes simulation behaviour, so a run is reproducible only as seed + contentVersion + command log.";
    displayName: 'Economy Matrix';
    pluralName: 'economy-matrices';
    singularName: 'economy-matrix';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    economies: Schema.Attribute.JSON & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::economy-matrix.economy-matrix'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiEraModifierEraModifier extends Struct.SingleTypeSchema {
  collectionName: 'era_modifiers';
  info: {
    description: "Per-era Civ-style percentage modifiers (growth/train/construct/create/research/build/improve/gp/anarchy), keyed by the era enum. Replaces the per-era fields of the retired 'era' collection.";
    displayName: 'Era Modifiers';
    pluralName: 'era-modifiers';
    singularName: 'era-modifier';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::era-modifier.era-modifier'
    > &
      Schema.Attribute.Private;
    modifiers: Schema.Attribute.JSON & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiFeastFeast extends Struct.CollectionTypeSchema {
  collectionName: 'feasts';
  info: {
    description: 'A liturgical feast day (race-scoped).';
    displayName: 'Feast';
    pluralName: 'feasts';
    singularName: 'feast';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    day: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::feast.feast'>;
    month: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    name: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    publishedAt: Schema.Attribute.DateTime;
    race: Schema.Attribute.Enumeration<
      [
        'human',
        'harimari',
        'elven',
        'dwarven',
        'degenerated_elf',
        'amadian_ruinborn_elf',
        'devandi_ruinborn_elf',
        'effelai_ruinborn_elf',
        'eltibhari_ruinborn_elf',
        'eordan_ruinborn_elf',
        'harafic_ruinborn_elf',
        'kheionai_ruinborn_elf',
        'north_ruinborn_elf',
        'south_ruinborn_elf',
        'taychendi_ruinborn_elf',
        'ynnic_ruinborn_elf',
        'akasi',
        'alenic',
        'anbennarian',
        'bom',
        'bulwari',
        'businori',
        'centaur',
        'dostanorian_g',
        'escanni',
        'gerudian',
        'giantkind',
        'gnollish',
        'gnomish',
        'goblin',
        'gowon',
        'halfling',
        'harpy',
        'hobgoblin',
        'inyaswarosa',
        'irsukuba',
        'kai',
        'kelino',
        'khantaar',
        'kheteratan',
        'khudi',
        'kobold',
        'lencori',
        'lizardfolk',
        'mengi',
        'middle_raheni',
        'ogre',
        'orcish',
        'reachman',
        'triunic',
        'trollsbayer',
        'tyvorkan',
        'upper_raheni',
        'vurebindu',
        'west_sarhaly',
        'wuhyun',
        'yan',
        'yanglam',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiFeatureFeature extends Struct.CollectionTypeSchema {
  collectionName: 'features';
  info: {
    displayName: 'Feature';
    pluralName: 'features';
    singularName: 'feature';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    appearance: Schema.Attribute.Integer;
    clearCost: Schema.Attribute.Integer;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    growth: Schema.Attribute.Integer;
    healthPercent: Schema.Attribute.Integer;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::feature.feature'
    > &
      Schema.Attribute.Private;
    movement: Schema.Attribute.Integer;
    publishedAt: Schema.Attribute.DateTime;
    requiresFlatlands: Schema.Attribute.Boolean;
    requiresRiver: Schema.Attribute.Boolean;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    validTerrains: Schema.Attribute.Relation<
      'manyToMany',
      'api::terrain.terrain'
    >;
    yieldChanges: Schema.Attribute.JSON;
  };
}

export interface ApiHousingHousing extends Struct.CollectionTypeSchema {
  collectionName: 'housings';
  info: {
    description: "A C2C housing building \u2014 the rung catalog the build economy's housing targeting reads (docs/build-queue-plan.md).";
    displayName: 'Housing Building';
    pluralName: 'housings';
    singularName: 'housing';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    authoredCost: Schema.Attribute.Integer;
    autoBuild: Schema.Attribute.Boolean;
    bonus: Schema.Attribute.Relation<'manyToOne', 'api::bonus.bonus'>;
    commerceChanges: Schema.Attribute.JSON;
    cost: Schema.Attribute.Integer;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    freshWater: Schema.Attribute.Boolean;
    happiness: Schema.Attribute.Integer;
    health: Schema.Attribute.Integer;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::housing.housing'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    obsoletesToBuilding: Schema.Attribute.Relation<
      'manyToOne',
      'api::building.building'
    >;
    obsoleteTech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    prereqBonuses: Schema.Attribute.Relation<'manyToMany', 'api::bonus.bonus'>;
    prereqBuildings: Schema.Attribute.Relation<
      'manyToMany',
      'api::building.building'
    >;
    prereqOrBuildings: Schema.Attribute.Relation<
      'manyToMany',
      'api::building.building'
    >;
    prereqOrFeatures: Schema.Attribute.Relation<
      'manyToMany',
      'api::feature.feature'
    >;
    prereqOrTerrains: Schema.Attribute.Relation<
      'manyToMany',
      'api::terrain.terrain'
    >;
    prereqPopulation: Schema.Attribute.Integer;
    prereqTech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    publishedAt: Schema.Attribute.DateTime;
    replacements: Schema.Attribute.Relation<
      'manyToMany',
      'api::building.building'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    yieldChanges: Schema.Attribute.JSON;
  };
}

export interface ApiImprovementImprovement extends Struct.CollectionTypeSchema {
  collectionName: 'improvements';
  info: {
    displayName: 'Improvement';
    pluralName: 'improvements';
    singularName: 'improvement';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    actsAsCity: Schema.Attribute.Boolean;
    buildCost: Schema.Attribute.Integer;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    culture: Schema.Attribute.Integer;
    freshWaterMakesValid: Schema.Attribute.Boolean;
    healthPercent: Schema.Attribute.Integer;
    hillsMakesValid: Schema.Attribute.Boolean;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::improvement.improvement'
    > &
      Schema.Attribute.Private;
    prereqTech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    publishedAt: Schema.Attribute.DateTime;
    techYieldChanges: Schema.Attribute.JSON;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    upgradeTime: Schema.Attribute.Integer;
    upgradeType: Schema.Attribute.Relation<
      'manyToOne',
      'api::improvement.improvement'
    >;
    validFeatures: Schema.Attribute.Relation<
      'manyToMany',
      'api::feature.feature'
    >;
    validTerrains: Schema.Attribute.Relation<
      'manyToMany',
      'api::terrain.terrain'
    >;
    yieldChanges: Schema.Attribute.JSON;
  };
}

export interface ApiMapVersionMapVersion extends Struct.SingleTypeSchema {
  collectionName: 'map_version';
  info: {
    description: 'The authoritative content/plot-cache generation stamp. Retires the compile-time-inlined MAP_VERSION/GEN_VERSION constant: engine, server and bake read mapVersion at boot to key the .map plot cache; contentVersion is bumped on every reseed so a run records which content snapshot it used (reproducibility = seed + contentVersion).';
    displayName: 'Map Version';
    pluralName: 'map-versions';
    singularName: 'map-version';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    contentVersion: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::map-version.map-version'
    > &
      Schema.Attribute.Private;
    mapVersion: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    note: Schema.Attribute.Text;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiNamePoolNamePool extends Struct.CollectionTypeSchema {
  collectionName: 'name_pools';
  info: {
    description: 'A per-(race, kind) pool of given/dynasty names.';
    displayName: 'Name Pool';
    pluralName: 'name-pools';
    singularName: 'name-pool';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    kind: Schema.Attribute.Enumeration<['male', 'female', 'dynasty']>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::name-pool.name-pool'
    > &
      Schema.Attribute.Private;
    names: Schema.Attribute.JSON;
    publishedAt: Schema.Attribute.DateTime;
    race: Schema.Attribute.Enumeration<
      [
        'human',
        'harimari',
        'elven',
        'dwarven',
        'degenerated_elf',
        'amadian_ruinborn_elf',
        'devandi_ruinborn_elf',
        'effelai_ruinborn_elf',
        'eltibhari_ruinborn_elf',
        'eordan_ruinborn_elf',
        'harafic_ruinborn_elf',
        'kheionai_ruinborn_elf',
        'north_ruinborn_elf',
        'south_ruinborn_elf',
        'taychendi_ruinborn_elf',
        'ynnic_ruinborn_elf',
        'akasi',
        'alenic',
        'anbennarian',
        'bom',
        'bulwari',
        'businori',
        'centaur',
        'dostanorian_g',
        'escanni',
        'gerudian',
        'giantkind',
        'gnollish',
        'gnomish',
        'goblin',
        'gowon',
        'halfling',
        'harpy',
        'hobgoblin',
        'inyaswarosa',
        'irsukuba',
        'kai',
        'kelino',
        'khantaar',
        'kheteratan',
        'khudi',
        'kobold',
        'lencori',
        'lizardfolk',
        'mengi',
        'middle_raheni',
        'ogre',
        'orcish',
        'reachman',
        'triunic',
        'trollsbayer',
        'tyvorkan',
        'upper_raheni',
        'vurebindu',
        'west_sarhaly',
        'wuhyun',
        'yan',
        'yanglam',
      ]
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiPlaceNamePlaceName extends Struct.CollectionTypeSchema {
  collectionName: 'place_names';
  info: {
    description: 'GeoNames populated-place subset (plot place-naming).';
    displayName: 'Place Name';
    pluralName: 'place-names';
    singularName: 'place-name';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    countryCode: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    elevation: Schema.Attribute.Integer;
    featureClass: Schema.Attribute.String;
    geonameId: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    latitude: Schema.Attribute.Decimal;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::place-name.place-name'
    > &
      Schema.Attribute.Private;
    longitude: Schema.Attribute.Decimal;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiProvinceEdgeProvinceEdge
  extends Struct.CollectionTypeSchema {
  collectionName: 'province_edges';
  info: {
    description: 'Per-province land-route edge geometry (km parallel to province.neighbors).';
    displayName: 'Province Edge';
    pluralName: 'province-edges';
    singularName: 'province-edge';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    km: Schema.Attribute.JSON;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::province-edge.province-edge'
    > &
      Schema.Attribute.Private;
    province: Schema.Attribute.Relation<'manyToOne', 'api::province.province'>;
    provinceId: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiProvincePortalProvincePortal
  extends Struct.CollectionTypeSchema {
  collectionName: 'province_portals';
  info: {
    description: 'Per-province portal pixel geometry (teleporter endpoints).';
    displayName: 'Province Portal';
    pluralName: 'province-portals';
    singularName: 'province-portal';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::province-portal.province-portal'
    > &
      Schema.Attribute.Private;
    portals: Schema.Attribute.JSON;
    province: Schema.Attribute.Relation<'manyToOne', 'api::province.province'>;
    provinceId: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiProvinceProvince extends Struct.CollectionTypeSchema {
  collectionName: 'provinces';
  info: {
    description: 'An imported Anbennar EU4 province \u2014 the world-map hub entity.';
    displayName: 'Province';
    pluralName: 'provinces';
    singularName: 'province';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    area: Schema.Attribute.Relation<'manyToOne', 'api::area.area'>;
    baseManpower: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    baseProduction: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    baseTax: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    city: Schema.Attribute.Boolean &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }> &
      Schema.Attribute.DefaultTo<false>;
    climate: Schema.Attribute.Enumeration<['arctic', 'arid', 'tropical']> &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    continent: Schema.Attribute.Enumeration<
      [
        'europe',
        'serpentspine',
        'asia',
        'africa',
        'north_america',
        'south_america',
        'oceania',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    controller: Schema.Attribute.Relation<'manyToOne', 'api::country.country'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    culture: Schema.Attribute.Relation<'manyToOne', 'api::culture.culture'>;
    isNeighborOf: Schema.Attribute.Relation<
      'manyToMany',
      'api::province.province'
    >;
    latitude: Schema.Attribute.Decimal &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }> &
      Schema.Attribute.SetMinMax<
        {
          max: 90;
          min: -90;
        },
        number
      >;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::province.province'
    >;
    longitude: Schema.Attribute.Decimal &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }> &
      Schema.Attribute.SetMinMax<
        {
          max: 180;
          min: -180;
        },
        number
      >;
    monsoon: Schema.Attribute.Enumeration<['mild', 'normal', 'severe']> &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    neighbors: Schema.Attribute.Relation<
      'manyToMany',
      'api::province.province'
    >;
    owner: Schema.Attribute.Relation<'manyToOne', 'api::country.country'>;
    plots: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }> &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    provinceId: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }> &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publishedAt: Schema.Attribute.DateTime;
    realm: Schema.Attribute.Enumeration<
      [
        'cannor',
        'serpentspine',
        'haless',
        'sarhal',
        'aelantir',
        'hinuilands',
        'halcann',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    region: Schema.Attribute.Relation<'manyToOne', 'api::region.region'>;
    religion: Schema.Attribute.Relation<'manyToOne', 'api::religion.religion'>;
    tradeGood: Schema.Attribute.Relation<
      'manyToOne',
      'api::trade-good.trade-good'
    >;
    type: Schema.Attribute.Enumeration<
      [
        'LAND',
        'CAVERN',
        'DWARVEN_HOLD',
        'DWARVEN_HOLD_SURFACE',
        'DWARVEN_ROAD',
        'ANCIENT_FOREST',
        'GLADEWAY',
        'FEY_GLADEWAY',
        'BLOODGROVES',
        'MUSHROOM_FOREST',
        'SHADOW_SWAMP',
        'GLACIER',
        'SEA',
        'LAKE',
        'IMPASSABLE',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }> &
      Schema.Attribute.DefaultTo<'LAND'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    waterPlots: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }> &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    winter: Schema.Attribute.Enumeration<['mild', 'normal', 'severe']> &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
  };
}

export interface ApiRankLadderRankLadder extends Struct.SingleTypeSchema {
  collectionName: 'rank_ladder';
  info: {
    description: "The social/political rank ladder: per-rank titles (administrative/military/diplomatic, gendered) and casus-belli copy, keyed by the rank enum. Replaces the retired 'rank' collection (English-only for now).";
    displayName: 'Rank Ladder';
    pluralName: 'rank-ladders';
    singularName: 'rank-ladder';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::rank-ladder.rank-ladder'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    ranks: Schema.Attribute.JSON & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiRecipeRecipe extends Struct.CollectionTypeSchema {
  collectionName: 'recipes';
  info: {
    description: 'A C2C production recipe \u2014 a building that turns input bonuses into an output bonus under tech/terrain/vicinity prerequisites.';
    displayName: 'Recipe';
    pluralName: 'recipes';
    singularName: 'recipe';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    bonus: Schema.Attribute.Relation<'manyToOne', 'api::bonus.bonus'>;
    building: Schema.Attribute.Relation<'manyToOne', 'api::building.building'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    freshWater: Schema.Attribute.Boolean;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::recipe.recipe'
    > &
      Schema.Attribute.Private;
    obsoleteTech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    outputs: Schema.Attribute.Relation<'manyToMany', 'api::bonus.bonus'>;
    prereqBonuses: Schema.Attribute.Relation<'manyToMany', 'api::bonus.bonus'>;
    prereqBuildings: Schema.Attribute.Relation<
      'manyToMany',
      'api::building.building'
    >;
    prereqOrBuildings: Schema.Attribute.Relation<
      'manyToMany',
      'api::building.building'
    >;
    prereqOrFeatures: Schema.Attribute.Relation<
      'manyToMany',
      'api::feature.feature'
    >;
    prereqOrTerrains: Schema.Attribute.Relation<
      'manyToMany',
      'api::terrain.terrain'
    >;
    prereqTech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    publishedAt: Schema.Attribute.DateTime;
    rawVicinityBonuses: Schema.Attribute.Relation<
      'manyToMany',
      'api::bonus.bonus'
    >;
    river: Schema.Attribute.Boolean;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    vicinityBonuses: Schema.Attribute.Relation<
      'manyToMany',
      'api::bonus.bonus'
    >;
  };
}

export interface ApiRegionEarthMapRegionEarthMap
  extends Struct.SingleTypeSchema {
  collectionName: 'region_earth_maps';
  info: {
    description: 'The Anbennar-region \u2192 Earth ISO-3166 country-code map that drives plot place-naming (from geo/region-earth-map.json).';
    displayName: 'Region Earth Map';
    pluralName: 'region-earth-maps';
    singularName: 'region-earth-map';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::region-earth-map.region-earth-map'
    > &
      Schema.Attribute.Private;
    notes: Schema.Attribute.Text;
    publishedAt: Schema.Attribute.DateTime;
    regions: Schema.Attribute.JSON & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiRegionRegion extends Struct.CollectionTypeSchema {
  collectionName: 'regions';
  info: {
    displayName: 'Region';
    pluralName: 'regions';
    singularName: 'region';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    areas: Schema.Attribute.Relation<'manyToMany', 'api::area.area'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::region.region'>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiReligionReligion extends Struct.CollectionTypeSchema {
  collectionName: 'religions';
  info: {
    displayName: 'Religion';
    pluralName: 'religions';
    singularName: 'religion';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    color: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    group: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::religion.religion'
    >;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiResourceSourceResourceSource
  extends Struct.CollectionTypeSchema {
  collectionName: 'resource_sources';
  info: {
    description: 'A base (C2C tier-1) resource producer \u2014 output bonus + gatherers.';
    displayName: 'Resource Source';
    pluralName: 'resource-sources';
    singularName: 'resource-source';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    gatherers: Schema.Attribute.JSON;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::resource-source.resource-source'
    > &
      Schema.Attribute.Private;
    output: Schema.Attribute.Relation<'manyToOne', 'api::bonus.bonus'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiRouteModelRouteModel extends Struct.CollectionTypeSchema {
  collectionName: 'route_models';
  info: {
    description: 'Civ4 route (road/rail) render model \u2014 art reference.';
    displayName: 'Route Model';
    pluralName: 'route-models';
    singularName: 'route-model';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    animated: Schema.Attribute.Boolean;
    connections: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    lateModelFile: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::route-model.route-model'
    > &
      Schema.Attribute.Private;
    modelConnections: Schema.Attribute.String;
    modelFile: Schema.Attribute.String;
    modelFileKey: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    rotations: Schema.Attribute.JSON;
    routeType: Schema.Attribute.Relation<'manyToOne', 'api::route.route'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiRouteRoute extends Struct.CollectionTypeSchema {
  collectionName: 'routes';
  info: {
    displayName: 'Route';
    pluralName: 'routes';
    singularName: 'route';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    advancedStartCost: Schema.Attribute.Integer;
    bonusType: Schema.Attribute.Relation<'manyToOne', 'api::bonus.bonus'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    flatMovement: Schema.Attribute.Integer;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::route.route'> &
      Schema.Attribute.Private;
    movement: Schema.Attribute.Integer;
    publishedAt: Schema.Attribute.DateTime;
    seaTunnel: Schema.Attribute.Boolean;
    trail: Schema.Attribute.Boolean;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    value: Schema.Attribute.Integer;
    yields: Schema.Attribute.JSON;
  };
}

export interface ApiScenarioScenario extends Struct.CollectionTypeSchema {
  collectionName: 'scenarios';
  info: {
    description: 'A foundable scenario as data (engine: ScenarioRegistry/ScenarioDef): its founding shape, the balance profile it tunes agents with, and free-form flags. Served to the engine as /scenarios.json; the host resolves spec.scenario() against it. Seed and province are NOT here \u2014 they are per-session instance params on the SessionSpec, not the scenario definition. balanceProfile is a plain string (a BalanceProfiles key, resolved forgivingly), not a relation.';
    displayName: 'Scenario';
    pluralName: 'scenarios';
    singularName: 'scenario';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    balanceProfile: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    blurb: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    flags: Schema.Attribute.JSON &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    label: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::scenario.scenario'
    >;
    publishedAt: Schema.Attribute.DateTime;
    shape: Schema.Attribute.Enumeration<
      ['STANDARD_COLONY', 'CAMP', 'TIMELINE']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiSuperRegionSuperRegion extends Struct.CollectionTypeSchema {
  collectionName: 'super_regions';
  info: {
    displayName: 'Super Region';
    pluralName: 'super-regions';
    singularName: 'super-region';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::super-region.super-region'
    >;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    publishedAt: Schema.Attribute.DateTime;
    regions: Schema.Attribute.Relation<'manyToMany', 'api::region.region'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiTechEffectTechEffect extends Struct.CollectionTypeSchema {
  collectionName: 'tech_effects';
  info: {
    description: 'eos per-tech productivity overlay (race-scoped; placeholder stub today).';
    displayName: 'Tech Effect';
    pluralName: 'tech-effects';
    singularName: 'tech-effect';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    effects: Schema.Attribute.JSON;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::tech-effect.tech-effect'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    race: Schema.Attribute.Enumeration<
      [
        'human',
        'harimari',
        'elven',
        'dwarven',
        'degenerated_elf',
        'amadian_ruinborn_elf',
        'devandi_ruinborn_elf',
        'effelai_ruinborn_elf',
        'eltibhari_ruinborn_elf',
        'eordan_ruinborn_elf',
        'harafic_ruinborn_elf',
        'kheionai_ruinborn_elf',
        'north_ruinborn_elf',
        'south_ruinborn_elf',
        'taychendi_ruinborn_elf',
        'ynnic_ruinborn_elf',
        'akasi',
        'alenic',
        'anbennarian',
        'bom',
        'bulwari',
        'businori',
        'centaur',
        'dostanorian_g',
        'escanni',
        'gerudian',
        'giantkind',
        'gnollish',
        'gnomish',
        'goblin',
        'gowon',
        'halfling',
        'harpy',
        'hobgoblin',
        'inyaswarosa',
        'irsukuba',
        'kai',
        'kelino',
        'khantaar',
        'kheteratan',
        'khudi',
        'kobold',
        'lencori',
        'lizardfolk',
        'mengi',
        'middle_raheni',
        'ogre',
        'orcish',
        'reachman',
        'triunic',
        'trollsbayer',
        'tyvorkan',
        'upper_raheni',
        'vurebindu',
        'west_sarhaly',
        'wuhyun',
        'yan',
        'yanglam',
      ]
    >;
    tech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiTechTech extends Struct.CollectionTypeSchema {
  collectionName: 'techs';
  info: {
    description: 'A technology-tree node (C2C). Era is an enum attribute; And/Or prerequisites are self-relations.';
    displayName: 'Tech';
    pluralName: 'techs';
    singularName: 'tech';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    advisor: Schema.Attribute.Enumeration<
      [
        'ADVISOR_GROWTH',
        'ADVISOR_ECONOMY',
        'ADVISOR_MILITARY',
        'ADVISOR_SCIENCE',
        'ADVISOR_CULTURE',
        'ADVISOR_RELIGION',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    andPreReqs: Schema.Attribute.Relation<'manyToMany', 'api::tech.tech'>;
    button: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    civilopedia: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    cost: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    era: Schema.Attribute.Enumeration<
      [
        'PREHISTORIC',
        'ANCIENT',
        'CLASSICAL',
        'MEDIEVAL',
        'RENAISSANCE',
        'INDUSTRIAL',
        'ATOMIC',
        'INFORMATION',
        'NANOTECH',
        'TRANSHUMAN',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    flavors: Schema.Attribute.JSON &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    goodyTech: Schema.Attribute.Boolean &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    gridX: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    gridY: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    help: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::tech.tech'>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    orPreReqs: Schema.Attribute.Relation<'manyToMany', 'api::tech.tech'>;
    publishedAt: Schema.Attribute.DateTime;
    quote: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    sound: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    trade: Schema.Attribute.Boolean &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    unlockedBuildings: Schema.Attribute.Relation<
      'oneToMany',
      'api::building.building'
    >;
    unlockedUnits: Schema.Attribute.Relation<'oneToMany', 'api::unit.unit'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiTerrainArtTerrainArt extends Struct.CollectionTypeSchema {
  collectionName: 'terrain_arts';
  info: {
    description: 'Per-terrain render art reference.';
    displayName: 'Terrain Art';
    pluralName: 'terrain-arts';
    singularName: 'terrain-art';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    alphaShader: Schema.Attribute.Boolean;
    artTag: Schema.Attribute.String;
    blend: Schema.Attribute.JSON;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    detail: Schema.Attribute.String;
    grid: Schema.Attribute.String;
    layerOrder: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::terrain-art.terrain-art'
    > &
      Schema.Attribute.Private;
    path: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    terrain: Schema.Attribute.Relation<'manyToOne', 'api::terrain.terrain'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiTerrainTerrain extends Struct.CollectionTypeSchema {
  collectionName: 'terrains';
  info: {
    displayName: 'Terrain';
    pluralName: 'terrains';
    singularName: 'terrain';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    buildModifier: Schema.Attribute.Integer;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    found: Schema.Attribute.Boolean;
    healthPercent: Schema.Attribute.Integer;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::terrain.terrain'
    > &
      Schema.Attribute.Private;
    movement: Schema.Attribute.Integer;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    yields: Schema.Attribute.JSON;
  };
}

export interface ApiTradeGoodTradeGood extends Struct.CollectionTypeSchema {
  collectionName: 'trade_goods';
  info: {
    displayName: 'Trade Good';
    pluralName: 'trade-goods';
    singularName: 'trade-good';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    category: Schema.Attribute.Enumeration<
      ['FOOD', 'LUXURY', 'STRATEGIC', 'MANUFACTURED', 'MAGICAL']
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    color: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::trade-good.trade-good'
    >;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiUnitUnit extends Struct.CollectionTypeSchema {
  collectionName: 'units';
  info: {
    description: 'A C2C land unit.';
    displayName: 'Unit';
    pluralName: 'units';
    singularName: 'unit';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    andTechs: Schema.Attribute.Relation<'manyToMany', 'api::tech.tech'>;
    artDefineTag: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    bandSizeClass: Schema.Attribute.Enumeration<
      [
        'GROUP_SOLO',
        'GROUP_PARTY',
        'GROUP_SQUAD',
        'GROUP_COMPANY',
        'GROUP_BATTALION',
        'GROUP_FORCES',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    builds: Schema.Attribute.JSON &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    button: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    caravanRole: Schema.Attribute.Enumeration<
      [
        'COVERT',
        'EXPLORER',
        'HEALER',
        'HUNTER',
        'MILITARY',
        'MISSIONARY',
        'SETTLER',
        'TRADE',
        'WORKER',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    combat: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    combatClass: Schema.Attribute.Relation<
      'manyToOne',
      'api::combat-class.combat-class'
    >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    defaultUnitAI: Schema.Attribute.Enumeration<
      [
        'UNITAI_ARTIST',
        'UNITAI_ATTACK',
        'UNITAI_ATTACK_CITY',
        'UNITAI_CITY_COUNTER',
        'UNITAI_CITY_DEFENSE',
        'UNITAI_CITY_SPECIAL',
        'UNITAI_COUNTER',
        'UNITAI_ENGINEER',
        'UNITAI_EXPLORE',
        'UNITAI_GENERAL',
        'UNITAI_GREAT_ADMIRAL',
        'UNITAI_GREAT_HUNTER',
        'UNITAI_HEALER',
        'UNITAI_HUNTER',
        'UNITAI_INFILTRATOR',
        'UNITAI_MERCHANT',
        'UNITAI_MISSIONARY',
        'UNITAI_PARADROP',
        'UNITAI_PILLAGE',
        'UNITAI_PILLAGE_COUNTER',
        'UNITAI_PROPERTY_CONTROL',
        'UNITAI_PROPHET',
        'UNITAI_RESERVE',
        'UNITAI_SCIENTIST',
        'UNITAI_SETTLE',
        'UNITAI_SPY',
        'UNITAI_SUBDUED_ANIMAL',
        'UNITAI_WORKER',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    domain: Schema.Attribute.Enumeration<
      ['DOMAIN_LAND', 'DOMAIN_SEA', 'DOMAIN_AIR', 'DOMAIN_IMMOBILE']
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::unit.unit'>;
    moves: Schema.Attribute.Integer &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    obsoleteTech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    pedia: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    prereqTech: Schema.Attribute.Relation<'manyToOne', 'api::tech.tech'>;
    publishedAt: Schema.Attribute.DateTime;
    quality: Schema.Attribute.Enumeration<
      [
        'QUALITY_PATHETIC',
        'QUALITY_INFERIOR',
        'QUALITY_POOR',
        'QUALITY_MEDIOCRE',
        'QUALITY_STANDARD',
        'QUALITY_EXCEPTIONAL',
        'QUALITY_SUPERIOR',
        'QUALITY_ELITE',
        'QUALITY_EPIC',
      ]
    > &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    special: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    species: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiWikiArticleWikiArticle extends Struct.CollectionTypeSchema {
  collectionName: 'wiki_articles';
  info: {
    description: 'An imported Anbennar Fandom lore article (CC BY-SA). Base type; typed subtypes + entity correlation are a later projection.';
    displayName: 'Wiki Article';
    pluralName: 'wiki-articles';
    singularName: 'wiki-article';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    body: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    categories: Schema.Attribute.JSON &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    country: Schema.Attribute.Relation<'manyToOne', 'api::country.country'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    culture: Schema.Attribute.Relation<'manyToOne', 'api::culture.culture'>;
    entityKey: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    entityRef: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    entityType: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    imageFile: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    imageUrl: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    infobox: Schema.Attribute.JSON &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    isStub: Schema.Attribute.Boolean &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }> &
      Schema.Attribute.DefaultTo<false>;
    key: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    links: Schema.Attribute.JSON &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    locale: Schema.Attribute.String;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::wiki-article.wiki-article'
    >;
    pageId: Schema.Attribute.Integer &
      Schema.Attribute.Unique &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    province: Schema.Attribute.Relation<'manyToOne', 'api::province.province'>;
    publishedAt: Schema.Attribute.DateTime;
    region: Schema.Attribute.Relation<'manyToOne', 'api::region.region'>;
    religion: Schema.Attribute.Relation<'manyToOne', 'api::religion.religion'>;
    summary: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    superRegion: Schema.Attribute.Relation<
      'manyToOne',
      'api::super-region.super-region'
    >;
    template: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    url: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: false;
        };
      }>;
  };
}

export interface PluginContentReleasesRelease
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_releases';
  info: {
    displayName: 'Release';
    pluralName: 'releases';
    singularName: 'release';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    actions: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release-action'
    >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    releasedAt: Schema.Attribute.DateTime;
    scheduledAt: Schema.Attribute.DateTime;
    status: Schema.Attribute.Enumeration<
      ['ready', 'blocked', 'failed', 'done', 'empty']
    > &
      Schema.Attribute.Required;
    timezone: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginContentReleasesReleaseAction
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_release_actions';
  info: {
    displayName: 'Release Action';
    pluralName: 'release-actions';
    singularName: 'release-action';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentType: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    entryDocumentId: Schema.Attribute.String;
    isEntryValid: Schema.Attribute.Boolean;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release-action'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    release: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::content-releases.release'
    >;
    type: Schema.Attribute.Enumeration<['publish', 'unpublish']> &
      Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginI18NLocale extends Struct.CollectionTypeSchema {
  collectionName: 'i18n_locale';
  info: {
    collectionName: 'locales';
    description: '';
    displayName: 'Locale';
    pluralName: 'locales';
    singularName: 'locale';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String & Schema.Attribute.Unique;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::i18n.locale'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.SetMinMax<
        {
          max: 50;
          min: 1;
        },
        number
      >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflow
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows';
  info: {
    description: '';
    displayName: 'Workflow';
    name: 'Workflow';
    pluralName: 'workflows';
    singularName: 'workflow';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentTypes: Schema.Attribute.JSON &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'[]'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    stageRequiredToPublish: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::review-workflows.workflow-stage'
    >;
    stages: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow-stage'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflowStage
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows_stages';
  info: {
    description: '';
    displayName: 'Stages';
    name: 'Workflow Stage';
    pluralName: 'workflow-stages';
    singularName: 'workflow-stage';
  };
  options: {
    draftAndPublish: false;
    version: '1.1.0';
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    color: Schema.Attribute.String & Schema.Attribute.DefaultTo<'#4945FF'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow-stage'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    permissions: Schema.Attribute.Relation<'manyToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    workflow: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::review-workflows.workflow'
    >;
  };
}

export interface PluginUploadFile extends Struct.CollectionTypeSchema {
  collectionName: 'files';
  info: {
    description: '';
    displayName: 'File';
    pluralName: 'files';
    singularName: 'file';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    alternativeText: Schema.Attribute.Text;
    caption: Schema.Attribute.Text;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    ext: Schema.Attribute.String;
    focalPoint: Schema.Attribute.JSON;
    folder: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'> &
      Schema.Attribute.Private;
    folderPath: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    formats: Schema.Attribute.JSON;
    hash: Schema.Attribute.String & Schema.Attribute.Required;
    height: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::upload.file'
    > &
      Schema.Attribute.Private;
    mime: Schema.Attribute.String & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    previewUrl: Schema.Attribute.Text;
    provider: Schema.Attribute.String & Schema.Attribute.Required;
    provider_metadata: Schema.Attribute.JSON;
    publishedAt: Schema.Attribute.DateTime;
    related: Schema.Attribute.Relation<'morphToMany'>;
    size: Schema.Attribute.Decimal & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    url: Schema.Attribute.Text & Schema.Attribute.Required;
    width: Schema.Attribute.Integer;
  };
}

export interface PluginUploadFolder extends Struct.CollectionTypeSchema {
  collectionName: 'upload_folders';
  info: {
    displayName: 'Folder';
    pluralName: 'folders';
    singularName: 'folder';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    children: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.folder'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    files: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.file'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::upload.folder'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    parent: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'>;
    path: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    pathId: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsPermission
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.role'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsRole
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.role'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.String & Schema.Attribute.Unique;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.user'
    >;
  };
}

export interface PluginUsersPermissionsUser
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_users';
  info: {
    description: '';
    displayName: 'User';
    name: 'user';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
    timestamps: true;
  };
  attributes: {
    blocked: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    confirmationToken: Schema.Attribute.String & Schema.Attribute.Private;
    confirmed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.user'
    > &
      Schema.Attribute.Private;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    provider: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    role: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.role'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    username: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
  };
}

declare module '@strapi/strapi' {
  export namespace Public {
    export interface ContentTypeSchemas {
      'admin::api-token': AdminApiToken;
      'admin::api-token-permission': AdminApiTokenPermission;
      'admin::permission': AdminPermission;
      'admin::role': AdminRole;
      'admin::session': AdminSession;
      'admin::transfer-token': AdminTransferToken;
      'admin::transfer-token-permission': AdminTransferTokenPermission;
      'admin::user': AdminUser;
      'api::adjacency.adjacency': ApiAdjacencyAdjacency;
      'api::area.area': ApiAreaArea;
      'api::balance-profile.balance-profile': ApiBalanceProfileBalanceProfile;
      'api::bonus.bonus': ApiBonusBonus;
      'api::building.building': ApiBuildingBuilding;
      'api::combat-class.combat-class': ApiCombatClassCombatClass;
      'api::country.country': ApiCountryCountry;
      'api::culture.culture': ApiCultureCulture;
      'api::economy-matrix.economy-matrix': ApiEconomyMatrixEconomyMatrix;
      'api::era-modifier.era-modifier': ApiEraModifierEraModifier;
      'api::feast.feast': ApiFeastFeast;
      'api::feature.feature': ApiFeatureFeature;
      'api::housing.housing': ApiHousingHousing;
      'api::improvement.improvement': ApiImprovementImprovement;
      'api::map-version.map-version': ApiMapVersionMapVersion;
      'api::name-pool.name-pool': ApiNamePoolNamePool;
      'api::place-name.place-name': ApiPlaceNamePlaceName;
      'api::province-edge.province-edge': ApiProvinceEdgeProvinceEdge;
      'api::province-portal.province-portal': ApiProvincePortalProvincePortal;
      'api::province.province': ApiProvinceProvince;
      'api::rank-ladder.rank-ladder': ApiRankLadderRankLadder;
      'api::recipe.recipe': ApiRecipeRecipe;
      'api::region-earth-map.region-earth-map': ApiRegionEarthMapRegionEarthMap;
      'api::region.region': ApiRegionRegion;
      'api::religion.religion': ApiReligionReligion;
      'api::resource-source.resource-source': ApiResourceSourceResourceSource;
      'api::route-model.route-model': ApiRouteModelRouteModel;
      'api::route.route': ApiRouteRoute;
      'api::scenario.scenario': ApiScenarioScenario;
      'api::super-region.super-region': ApiSuperRegionSuperRegion;
      'api::tech-effect.tech-effect': ApiTechEffectTechEffect;
      'api::tech.tech': ApiTechTech;
      'api::terrain-art.terrain-art': ApiTerrainArtTerrainArt;
      'api::terrain.terrain': ApiTerrainTerrain;
      'api::trade-good.trade-good': ApiTradeGoodTradeGood;
      'api::unit.unit': ApiUnitUnit;
      'api::wiki-article.wiki-article': ApiWikiArticleWikiArticle;
      'plugin::content-releases.release': PluginContentReleasesRelease;
      'plugin::content-releases.release-action': PluginContentReleasesReleaseAction;
      'plugin::i18n.locale': PluginI18NLocale;
      'plugin::review-workflows.workflow': PluginReviewWorkflowsWorkflow;
      'plugin::review-workflows.workflow-stage': PluginReviewWorkflowsWorkflowStage;
      'plugin::upload.file': PluginUploadFile;
      'plugin::upload.folder': PluginUploadFolder;
      'plugin::users-permissions.permission': PluginUsersPermissionsPermission;
      'plugin::users-permissions.role': PluginUsersPermissionsRole;
      'plugin::users-permissions.user': PluginUsersPermissionsUser;
    }
  }
}
