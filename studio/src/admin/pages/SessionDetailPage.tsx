import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Box, Flex, Typography, Button, Tabs, SingleSelect, SingleSelectOption } from '@strapi/design-system';
import { ArrowLeft } from '@strapi/icons';
import { Layouts, Page } from '@strapi/admin/strapi-admin';
import { serverFetch, type SessionRow, type SessionSnapshot } from '../lib/serverApi';
import { useServerPoll } from '../lib/useServerPoll';
import { KIND_LABEL, controlsFor, controlSession, displayId, sessionTitle, type ControlAction } from '../lib/sessions';
import { CenteredLoader, Gate, ActionResult } from '../components/opsShared';
import { Pill, StatePair, SessionFigures } from '../components/sessionBits';
import ColonyPanel from '../components/panels/ColonyPanel';
import CaravansPanel from '../components/panels/CaravansPanel';
import CourtPanel from '../components/panels/CourtPanel';
import EventsPanel from '../components/panels/EventsPanel';
import CommandsPanel from '../components/panels/CommandsPanel';

/**
 * One run, in full — the page the "Live sessions" widget and the list link into.
 *
 * Overview plus the §C3 panels: colony composition, bands, the court, the event log and the command
 * log — each reading an endpoint that already exists (`/colony`, `/caravan/{id}`, `/person/{id}`,
 * `/events`, `/commands`).
 *
 * The run is found by filtering the lobby list rather than by a per-session endpoint: `GET
 * /api/sessions` is the only route that returns the lobby row shape, and it already applies the
 * caller's visibility rules, so a run the operator may not see simply is not here.
 *
 * The <b>snapshot</b> is fetched alongside it because two things are enumerated nowhere else: the
 * run's caravans, and each colony's seated advisors. It answers 204 before the first frame, so every
 * field is treated as possibly absent.
 */
export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ message: string; tone: 'success' | 'danger' } | null>(null);
  const [colony, setColony] = useState<string>('');

  const { data, loading, gate, reload } = useServerPoll<SessionRow[] | { sessions?: SessionRow[] }>(() =>
    serverFetch('GET', '/api/sessions'),
  );
  const { data: snapshot } = useServerPoll<SessionSnapshot>(() =>
    serverFetch('GET', `/api/sessions/${id}/snapshot`),
  );

  const rows: SessionRow[] = Array.isArray(data) ? data : (data?.sessions ?? []);
  const session = rows.find((s) => s.id === id);

  const colonies = snapshot?.colonies ?? [];
  const caravans = snapshot?.caravans ?? [];
  // which colony the colony-scoped panels are about. Empty means "the POV colony" — the server's
  // own default — so a single-colony run never needs to choose, and never shows a chooser.
  const activeColony = colonies.find((c) => c.name === colony) ?? colonies[0];
  const advisors = activeColony?.advisors ?? [];
  // Name a colony only when it is NOT the run's first. That keeps the single-colony case on the
  // server's own default resolution — which also works before the first snapshot frame arrives,
  // when we do not yet know any colony's name.
  const colonyParam = colonies.length > 1 && activeColony && activeColony.name !== colonies[0].name
    ? activeColony.name
    : undefined;

  async function control(action: ControlAction) {
    if (action === 'stop' && !window.confirm(`Stop session ${id}? (it can be re-founded)`)) return;
    setBusy(true);
    setResult(null);
    try {
      await controlSession(id, action);
      setResult({ message: `Session ${id}: ${action}`, tone: 'success' });
    } catch (e) {
      setResult({ message: e instanceof Error ? e.message : String(e), tone: 'danger' });
    } finally {
      setBusy(false);
      reload();
    }
  }

  const back = (
    <Button variant="tertiary" startIcon={<ArrowLeft />} onClick={() => navigate('/civstudio-sessions')}>
      Sessions
    </Button>
  );

  if (gate) {
    return (
      <Page.Main>
        <Layouts.Header title={id} navigationAction={back} />
        <Layouts.Content>
          <Gate status={gate} />
        </Layouts.Content>
      </Page.Main>
    );
  }

  if (loading && !data) {
    return (
      <Page.Main>
        <Layouts.Header title={id} navigationAction={back} />
        <Layouts.Content>
          <CenteredLoader />
        </Layouts.Content>
      </Page.Main>
    );
  }

  if (!session) {
    // either no such run, or one this operator may not see — GET /api/sessions already filtered it,
    // and saying which of the two it is would leak the existence of someone else's private run
    return (
      <Page.Main>
        <Page.Title>{id}</Page.Title>
        <Layouts.Header title={id} navigationAction={back} />
        <Layouts.Content>
          <Typography variant="omega" textColor="neutral600">
            No session <b>{id}</b> is visible to you.
          </Typography>
        </Layouts.Content>
      </Page.Main>
    );
  }

  const can = controlsFor(session);

  return (
    <Page.Main>
      <Page.Title>{sessionTitle(session)}</Page.Title>
      <Layouts.Header
        title={sessionTitle(session)}
        subtitle={displayId(session)}
        navigationAction={back}
        primaryAction={
          <Flex gap={1}>
            <Button variant="tertiary" disabled={busy || !can.pause} onClick={() => control('pause')}>
              Pause
            </Button>
            <Button variant="tertiary" disabled={busy || !can.resume} onClick={() => control('resume')}>
              Resume
            </Button>
            <Button variant="danger-light" disabled={busy || !can.stop} onClick={() => control('stop')}>
              Stop
            </Button>
          </Flex>
        }
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Box background="neutral0" hasRadius shadow="tableShadow" padding={5}>
            <Flex direction="column" alignItems="stretch" gap={3}>
              <Flex justifyContent="space-between" alignItems="center" gap={2}>
                <StatePair session={session} />
                <Flex gap={1} style={{ flexShrink: 0 }}>
                  {session.mine && <Pill tone="primary">Mine</Pill>}
                  {session.kind && <Pill>{KIND_LABEL[session.kind] ?? session.kind}</Pill>}
                </Flex>
              </Flex>
              <SessionFigures session={session} />
              {session.endReason && (
                <Typography variant="pi" textColor="neutral600" style={{ fontStyle: 'italic' }}>
                  {session.endReason}
                </Typography>
              )}
              <ActionResult message={result?.message ?? null} tone={result?.tone ?? 'success'} />
            </Flex>
          </Box>

          {/* A Timeline is many colonies in one run, so the colony-scoped panels need to say which.
              Only shown when there is actually a choice — a one-colony run gets no dead control. */}
          {colonies.length > 1 && (
            <Flex gap={2} alignItems="center">
              <Typography variant="pi" textColor="neutral600">Colony</Typography>
              <Box style={{ width: 280 }}>
                <SingleSelect aria-label="Colony" value={activeColony?.name ?? ''}
                  onChange={(v) => setColony(String(v ?? ''))}>
                  {colonies.map((c) => (
                    <SingleSelectOption key={c.name} value={c.name}>
                      {c.alive ? c.name : `${c.name} (dead)`}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
              </Box>
              <Typography variant="pi" textColor="neutral500">
                {colonies.length} seats in this run
              </Typography>
            </Flex>
          )}

          <Tabs.Root defaultValue="colony">
            <Tabs.List aria-label="Session detail">
              <Tabs.Trigger value="colony">Colony</Tabs.Trigger>
              <Tabs.Trigger value="court">Court{advisors.length ? ` (${advisors.length})` : ''}</Tabs.Trigger>
              <Tabs.Trigger value="bands">Bands{caravans.length ? ` (${caravans.length})` : ''}</Tabs.Trigger>
              <Tabs.Trigger value="events">Events</Tabs.Trigger>
              <Tabs.Trigger value="commands">Commands</Tabs.Trigger>
            </Tabs.List>

            <Box paddingTop={4}>
              <Tabs.Content value="colony">
                <ColonyPanel sessionId={session.id} colony={colonyParam} />
              </Tabs.Content>
              <Tabs.Content value="court">
                <CourtPanel sessionId={session.id} colony={colonyParam} advisors={advisors} />
              </Tabs.Content>
              <Tabs.Content value="bands">
                <CaravansPanel sessionId={session.id} caravans={caravans} />
              </Tabs.Content>
              <Tabs.Content value="events">
                <EventsPanel sessionId={session.id} />
              </Tabs.Content>
              <Tabs.Content value="commands">
                <CommandsPanel sessionId={session.id} />
              </Tabs.Content>
            </Box>
          </Tabs.Root>
        </Flex>
      </Layouts.Content>
    </Page.Main>
  );
}
