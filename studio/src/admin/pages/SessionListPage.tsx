import { Link } from 'react-router-dom';
import { Box, Flex, Typography } from '@strapi/design-system';
import { Layouts, Page } from '@strapi/admin/strapi-admin';
import { serverFetch, serverBase, type SessionRow } from '../lib/serverApi';
import { useServerPoll } from '../lib/useServerPoll';
import { KIND_LABEL, displayId, sessionPath, sessionTitle } from '../lib/sessions';
import { CenteredLoader, Gate } from '../components/opsShared';
import { Pill, StatePair, SessionFigures } from '../components/sessionBits';

/**
 * Every session the operator can see, as rows that open the detail page. The same feed as the
 * homepage "Live sessions" widget — this is the roomier view, and the one that can afford to show a
 * finished run's endReason in full.
 */
export default function SessionListPage() {
  const { data, loading, gate } = useServerPoll<SessionRow[] | { sessions?: SessionRow[] }>(() =>
    serverFetch('GET', '/api/sessions'),
  );

  const rows: SessionRow[] = Array.isArray(data) ? data : (data?.sessions ?? []);

  return (
    <Page.Main>
      <Page.Title>Sessions</Page.Title>
      <Layouts.Header
        title="Sessions"
        subtitle={`Live runs on ${serverBase.replace(/^https?:\/\//, '')}`}
      />
      <Layouts.Content>
        {gate ? (
          <Gate status={gate} />
        ) : loading && !data ? (
          <CenteredLoader />
        ) : rows.length === 0 ? (
          <Typography variant="omega" textColor="neutral600">
            No sessions.
          </Typography>
        ) : (
          <Flex direction="column" alignItems="stretch" gap={3}>
            {rows.map((s) => (
              <Box
                key={s.id}
                background="neutral0"
                hasRadius
                shadow="tableShadow"
                padding={4}
                tag={Link}
                to={sessionPath(s.id)}
                cursor="pointer"
                // the whole card is the link, so the title must read as a heading rather than
                // inherit the bare anchor blue
                style={{ textDecoration: 'none', display: 'block' }}
              >
                <Flex direction="column" alignItems="stretch" gap={2}>
                  <Flex justifyContent="space-between" alignItems="flex-start" gap={2}>
                    <Flex direction="column" alignItems="flex-start" gap={0} style={{ minWidth: 0 }}>
                      <Typography variant="delta" textColor="neutral800" ellipsis>
                        {sessionTitle(s)}
                      </Typography>
                      <Typography variant="pi" textColor="neutral600" ellipsis title={s.id}>
                        {displayId(s)}
                      </Typography>
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
                </Flex>
              </Box>
            ))}
          </Flex>
        )}
      </Layouts.Content>
    </Page.Main>
  );
}
