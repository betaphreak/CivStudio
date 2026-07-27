// Session presentation + control rules, shared by the homepage widget and the Sessions admin page.
// Kept out of the components so the two surfaces cannot disagree about what a state means or about
// which controls the server will actually accept.
import { serverFetch, type SessionRow } from './serverApi';

/** The transport axis — is it ticking? (server: ClockState) */
export const CLOCK_COLOR: Record<string, string> = {
  RUNNING: 'success600',
  PAUSED: 'warning600',
  STOPPED: 'neutral500',
  CREATED: 'neutral500',
};

/** The verdict axis — is it decided? (server: Outcome) */
export const OUTCOME_COLOR: Record<string, string> = {
  LIVE: 'success600',
  WON: 'primary600',
  LOST: 'danger600',
  ABANDONED: 'warning600',
};

export const KIND_LABEL: Record<string, string> = {
  demo: 'Demo',
  'single-player': 'Single-player',
  multiplayer: 'Multiplayer',
  timeline: 'Timeline',
};

export type ControlAction = 'pause' | 'resume' | 'stop';

/**
 * Which controls the server will accept for this run (mirrors SessionController#control):
 *  - a DECIDED run (outcome != LIVE) takes no orders at all — it 409s "session is over";
 *  - a merely STOPPED run is NOT finished: getOrRestore revives it, so resume still works.
 * So the gate is the outcome; past that we only grey out the exact no-ops.
 */
export function controlsFor(s: SessionRow): Record<ControlAction, boolean> {
  const clock = s.clockState ?? 'CREATED';
  const decided = (s.outcome ?? 'LIVE') !== 'LIVE';
  return {
    pause: !decided && clock !== 'PAUSED' && clock !== 'STOPPED',
    resume: !decided && clock !== 'RUNNING',
    stop: !decided && clock !== 'STOPPED',
  };
}

/** Drive a session's clock. Admins bypass the server's ownership check. */
export function controlSession(id: string, action: ControlAction): Promise<unknown> {
  return serverFetch('POST', `/api/sessions/${id}/control`, { action });
}

/** The run's display title — a run is named by its colony, falling back to its id. */
export function sessionTitle(s: SessionRow): string {
  return s.colony ?? s.id;
}

/**
 * The id as a human should read it. An owned run's key is `<spec-id>@<app_user GUID>`
 * (`SessionHost.sessionKey`) — the GUID is the ownership key, and it is noise on screen, so the
 * owner's NAME stands in its place: `caravan-demo-9131759@alexandru`.
 *
 * Cosmetic only: the real id is what every API call still uses, so this must never be fed back to
 * the server. With no `ownerName` (an unowned demo, or an owner the store has forgotten) the id is
 * shown exactly as it is, GUID and all — a wrong name would be worse than an ugly one.
 */
export function displayId(s: SessionRow): string {
  const at = s.id.indexOf('@');
  if (at < 0 || !s.ownerName) return s.id;
  return `${s.id.slice(0, at)}@${s.ownerName}`;
}

/** Route to a session's detail page, relative to the admin basename. */
export function sessionPath(id: string): string {
  return `/civstudio-sessions/${encodeURIComponent(id)}`;
}
