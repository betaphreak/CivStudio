import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Box, Flex, Typography, Button } from '@strapi/design-system';
import { serverFetch, type SessionRow } from '../lib/serverApi';
import { useServerPoll } from '../lib/useServerPoll';
import { KIND_LABEL, controlsFor, controlSession, displayId, sessionPath, sessionTitle,
  type ControlAction } from '../lib/sessions';
import { CenteredLoader, Gate, ActionResult } from './opsShared';
import { Pill, StatePair, SessionFigures } from './sessionBits';

/**
 * Homepage widget: the live sessions from the old admin.html "Sessions" panel, with per-session
 * pause / resume / stop. Control is a POST /api/sessions/{id}/control with a {action} body — admins
 * bypass the session ownership check on the server.
 *
 * Each row's title links into the Sessions page (`/admin/civstudio-sessions/<id>`), which is the
 * roomier view of the same feed. The state colours, control rules and figure grid are shared with
 * that page (`lib/sessions.ts`, `sessionBits.tsx`) so the two cannot disagree.
 */
export default function SessionsWidget() {
  const { data, loading, gate, reload } = useServerPoll<SessionRow[] | { sessions?: SessionRow[] }>(() =>
    serverFetch('GET', '/api/sessions'),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<{ message: string; tone: 'success' | 'danger' } | null>(null);

  if (gate) return <Gate status={gate} />;
  if (loading && !data) return <CenteredLoader />;

  const rows: SessionRow[] = Array.isArray(data) ? data : (data?.sessions ?? []);

  async function control(id: string, action: ControlAction) {
    if (action === 'stop' && !window.confirm(`Stop session ${id}? (it can be re-founded)`)) return;
    setBusyId(id);
    setResult(null);
    try {
      await controlSession(id, action);
      setResult({ message: `Session ${id}: ${action}`, tone: 'success' });
    } catch (e) {
      setResult({ message: e instanceof Error ? e.message : String(e), tone: 'danger' });
    } finally {
      setBusyId(null);
      reload();
    }
  }

  return (
    // Cap the height so a busy server can't stretch the homepage grid — the list scrolls instead.
    <Flex direction="column" alignItems="stretch" gap={2} style={{ maxHeight: 420, overflowY: 'auto' }}>
      {rows.length === 0 && (
        <Typography variant="omega" textColor="neutral600">
          No live sessions.
        </Typography>
      )}

      {rows.map((s) => {
        const busy = busyId === s.id;
        const can = controlsFor(s);

        return (
          <Flex key={s.id} direction="column" alignItems="stretch" gap={2}
            background="neutral100" hasRadius padding={3}>
            {/* identity: colony name is the title (and the link), id the subtitle */}
            <Flex justifyContent="space-between" alignItems="flex-start" gap={2}>
              <Flex direction="column" alignItems="flex-start" gap={0} style={{ minWidth: 0 }}>
                <Typography variant="omega" fontWeight="bold" ellipsis tag={Link}
                  to={sessionPath(s.id)} textColor="primary600">
                  {sessionTitle(s)}
                </Typography>
                {s.colony && (
                  <Typography variant="pi" textColor="neutral600" ellipsis title={s.id}>
                    {displayId(s)}
                  </Typography>
                )}
              </Flex>
              <Flex gap={1} style={{ flexShrink: 0 }}>
                {s.mine && <Pill tone="primary">Mine</Pill>}
                {s.kind && <Pill>{KIND_LABEL[s.kind] ?? s.kind}</Pill>}
              </Flex>
            </Flex>

            <StatePair session={s} />
            <SessionFigures session={s} />

            {s.endReason && (
              <Typography variant="pi" textColor="neutral600" style={{ fontStyle: 'italic' }}>
                {s.endReason}
              </Typography>
            )}

            <Flex gap={1} justifyContent="flex-end">
              <Button size="S" variant="tertiary" disabled={busy || !can.pause} onClick={() => control(s.id, 'pause')}>
                Pause
              </Button>
              <Button size="S" variant="tertiary" disabled={busy || !can.resume} onClick={() => control(s.id, 'resume')}>
                Resume
              </Button>
              <Button size="S" variant="danger-light" disabled={busy || !can.stop} onClick={() => control(s.id, 'stop')}>
                Stop
              </Button>
            </Flex>
          </Flex>
        );
      })}

      <ActionResult message={result?.message ?? null} tone={result?.tone ?? 'success'} />
    </Flex>
  );
}
