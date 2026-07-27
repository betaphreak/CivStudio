// serverApi.ts — thin client for the CivStudio (Java spectator) server's admin API, used by the
// admin homepage ops widgets. The server lives on a *different origin* (dev.civstudio.com) than the
// Strapi admin (civstudio.com), but the two are the SAME registrable domain, so:
//   - CORS on the server already allows the civstudio.com origins WITH credentials (WebConfig), and
//   - the login session cookie is SameSite=Lax scoped to civstudio.com, so it rides these
//     cross-subdomain requests (same-site, not third-party).
// So the widgets call the server directly with `credentials:'include'` and the server enforces its
// existing ROLE_ADMIN. A 401/403 surfaces as a sign-in gate (the operator needs a *server* login,
// separate from their Strapi admin login).

// Configurable at build time (env VITE_CIVSTUDIO_SERVER); defaults to the live dev server.
//
// NOTE the exact `import.meta.env.X` shape. Vite's substitution is a LITERAL match, so the
// optional-chaining form (`import.meta?.env?.X`) is never replaced and the override silently never
// arrives — which is precisely what it did until 2026-07-20. See src/admin/vite.config.ts.
const RAW = import.meta.env.VITE_CIVSTUDIO_SERVER;
export const serverBase = (RAW || 'https://dev.civstudio.com').replace(/\/+$/, '');

export const signInUrl = `${serverBase}/api/auth/steam/login`;

/** Thrown on 401/403 so widgets can render the sign-in gate instead of an error. */
export class GateError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? 'not signed in' : 'not an admin');
  }
}

export async function serverFetch<T = any>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${serverBase}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 403) throw new GateError(res.status);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  if (res.status === 204) return {} as T;
  return (await res.json().catch(() => ({}))) as T;
}

/**
 * The game server's build identity, from `GET /actuator/info` — `build.version` (the reactor
 * version), plus the auto-incrementing `build.number` and short `build.commit` the Maven build bakes
 * in (see civstudio-server/pom.xml → build-info).
 *
 * Fetched WITHOUT credentials and outside {@link serverFetch}: actuator is public (SecurityConfig
 * permits everything and management.endpoints.web.cors allows the admin origin), and it is not under
 * `/api`, so the gate/error mapping serverFetch exists for does not apply. Cached for the life of
 * the page — a running server's version does not change under it; a redeployed one is a reload.
 */
export interface ServerInfo {
  version?: string;
  number?: string;
  commit?: string;
}

let infoPromise: Promise<ServerInfo> | null = null;

export function serverInfo(): Promise<ServerInfo> {
  if (!infoPromise)
    infoPromise = fetch(`${serverBase}/actuator/info`, { credentials: 'omit' })
      .then(async (r): Promise<{ build?: ServerInfo }> => (r.ok ? r.json() : {}))
      .then((j) => j?.build ?? {})
      // an unreachable or actuator-less server just has no version to show — never a broken page
      .catch(() => ({}));
  return infoPromise;
}

// ---- response shapes (GET /api/admin/status, GET /api/sessions) ----
export interface ServerStatus {
  plots: { cached: number; total: number; mapVersion: number; generating: number | null; storageUrl?: string };
  server: { uptimeMs: number; heapUsedMb: number; heapMaxMb: number; sessions: number; admins: number; you?: string };
}

/**
 * One lobby row from `GET /api/sessions` — mirrors SessionController#liveRow / #recordRow.
 *
 * NOTE the two control axes: the old single `state` was split into `clockState` (transport) and
 * `outcome` (verdict) by the session-management redesign, and the server stopped sending `owner`
 * (replaced by the boolean `mine`). Everything past `id` is optional because a *record* row — a run
 * recorded but not loaded in this process — carries no colony name and no live spectator count.
 */
export interface SessionRow {
  id: string;
  scenario?: string;
  kind?: 'demo' | 'single-player' | 'multiplayer' | 'timeline' | string;
  seed?: number;
  clockState?: 'CREATED' | 'RUNNING' | 'PAUSED' | 'STOPPED' | string;
  outcome?: 'LIVE' | 'WON' | 'LOST' | 'ABANDONED' | string;
  tick?: number;
  /** in-game date, ISO yyyy-MM-dd */
  date?: string;
  /** spectators currently watching */
  watching?: number;
  mine?: boolean;
  /**
   * The owner's human-readable name. The session key tags an owned run with the owner's surrogate
   * `app_user` GUID (`SessionHost.sessionKey`), which is unreadable in a list — this is the face to
   * show instead (see `displayId`). Absent for an unowned run (the demo) and for an owner the user
   * store no longer knows.
   */
  ownerName?: string | null;
  realm?: string;
  /** a run is named by its colony; absent for a Timeline or a colony-less run */
  colony?: string;
  /** Timeline rows only: seats founded / colonies still standing */
  seats?: number;
  standing?: number;
  endReason?: string;
}

// ---- session detail shapes (com.civstudio.server.render.*) ----
// These mirror the Java render records field-for-field; see docs/studio-control-plane-plan.md §C1.

/** A skill averaged across a group (ColonyDetail / CaravanDetail). `avg` is a 0..20 skill level. */
export interface SkillAvg {
  skill: string;
  avg: number;
}

/** One household head in a colony's roster (ColonyDetail.Resident). */
export interface Resident {
  name: string;
  role: string;
  race: string;
  age: number;
  topSkill: string | null;
  topSkillLevel: number;
  ruler: boolean;
  noble: boolean;
}

/** GET /api/sessions/{sid}/colony[?colony=] */
export interface ColonyDetail {
  name: string;
  tier: string | null;
  province: string | null;
  rulerName: string | null;
  population: number;
  nobles: number;
  poolSize: number;
  skills: SkillAvg[];
  members: Resident[];
}

/** One band member (CaravanDetail.Crew); the list is sorted by survival — the succession order. */
export interface Crew {
  name: string;
  race: string;
  age: number;
  survival: number;
  leader: boolean;
}

/** GET /api/sessions/{sid}/caravan/{id} */
export interface CaravanDetail {
  id: number;
  leader: string;
  unitName: string | null;
  role: string | null;
  bandSize: number;
  larder: number;
  hoard: number;
  skills: SkillAvg[];
  members: Crew[];
}

/** One of a person's 12 skills (PersonDetail.SkillView). */
export interface SkillView {
  skill: string;
  level: number;
  passion: 'none' | 'minor' | 'major' | string;
}

/** A person's household member (PersonDetail.MemberView). */
export interface MemberView {
  name: string;
  relation: 'head' | 'spouse' | 'child' | string;
  ageYears: number;
  gender: string;
  race: string;
  alive: boolean;
}

/** GET /api/sessions/{sid}/person/{id}[?colony=] */
export interface PersonDetail {
  personId: number;
  name: string;
  race: string;
  gender: string;
  culture: string | null;
  role: string;
  ageYears: number;
  skills: SkillView[];
  household: MemberView[];
}

/** One event-log line (LogLine). `sev` drives the colour; `curated` marks the headline events. */
export interface LogLine {
  date: string;
  text: string;
  curated: boolean;
  sev: 'info' | 'warn' | 'error' | string;
  rank: string | null;
  rankLevel: number;
}

/** One applied command (CommandView); lever/rate null for a type with no codec. */
export interface CommandView {
  tick: number;
  type: string;
  lever: string | null;
  rate: number | null;
}

/** GET /api/sessions/{sid}/commands — the applied replay log plus the in-flight count. */
export interface CommandLogView {
  history: CommandView[];
  pending: number;
}

/** A seated advisor (AdvisorView); unfilled roles are simply absent from the list. */
export interface AdvisorView {
  role: string;
  personId: number;
  name: string;
  race: string;
  gender: string;
  culture: string | null;
}

/** A wandering band or colony excursion as it appears in the snapshot (CaravanView). */
export interface CaravanView {
  id: number;
  label: string;
  leader: string;
  province: string;
  provinceId: number;
  onGraph: boolean;
  settled: boolean;
  bandSize: number;
  larder: number;
  hoard: number;
  role: string;
  unitName: string | null;
  signatureSkill: string | null;
  leaderSkill: number;
}

/** A colony's live vitals in the snapshot (ColonyView) — the subset the admin page reads. */
export interface ColonyView {
  name: string;
  alive: boolean;
  population: number;
  children: number;
  nobles: number;
  firms: number;
  poolSize: number;
  cpi: number;
  necessityPrice: number;
  enjoymentPrice: number;
  plotCount: number;
  maxPlots: number;
  bankProfitTax: number;
  nobleIncomeTax: number;
  advisors: AdvisorView[];
  knownTechs: string[];
  tier: string | null;
  provinceId: number;
  researchingTech: string | null;
  researchProgress: number;
  culture: string | null;
}

/**
 * GET /api/sessions/{sid}/snapshot — the render frame.
 *
 * NOTE `log` is a DELTA (a drain-once buffer), not history: a STOPPED run's cached frame hands you
 * the same lines forever. Use GET /events for anything historical. Answers **204** before the first
 * frame, which serverFetch turns into `{}` — so every field must be treated as possibly absent.
 */
export interface SessionSnapshot {
  sessionId?: string;
  seed?: number;
  scenario?: string;
  clockState?: string;
  outcome?: string;
  endReason?: string | null;
  tick?: number;
  date?: string;
  colonies?: ColonyView[];
  caravans?: CaravanView[];
  log?: LogLine[];
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
