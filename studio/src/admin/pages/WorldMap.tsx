import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Flex, LinkButton } from '@strapi/design-system';
import { ExternalLink } from '@strapi/icons';
import { Layouts, Page } from '@strapi/admin/strapi-admin';
import { provinceMapUrl, worldMapBase, worldMapUrl } from '../lib/worldmap';
import { serverInfo } from '../lib/serverApi';
import WorldMapFrame from '../components/WorldMapFrame';

/**
 * The World map admin page — the viewer embedded full-height (docs/studio-control-plane-plan.md §D4).
 *
 * It forwards `?p=` / `?realm=` straight through to the frame, so `/admin/civstudio-map?p=4411` is a
 * shareable admin link to a province. That is the same deep-link contract the viewer already honours
 * (web/js/main.mjs readDeepLink), which is why this page needs no bridge to it: changing the iframe
 * `src` re-navigates the viewer, and the viewer does the rest.
 */
export default function WorldMap() {
  const [params] = useSearchParams();
  const p = params.get('p');
  const realm = params.get('realm');
  // The page's title is the PRODUCT and its version, not the generic words "World map" — this page
  // is the only place in the admin that shows the running build, and "which version am I looking
  // at" is the first question asked of anything that renders a world. Empty until actuator answers,
  // so the header never flashes a wrong version.
  const [version, setVersion] = useState('');
  useEffect(() => {
    let live = true;
    serverInfo().then((i) => { if (live && i.version) setVersion(i.version); });
    return () => { live = false; };
  }, []);
  const host = worldMapBase.replace(/^https?:\/\//, '');
  // embedded: the frame skips the lobby; the new-tab link below deliberately keeps it
  const src = p ? provinceMapUrl(p, realm, { embedded: true }) : worldMapUrl(realm, { embedded: true });
  const tabHref = p ? provinceMapUrl(p, realm) : worldMapUrl(realm);

  return (
    <Page.Main>
      <Page.Title>World map</Page.Title>
      <Layouts.Header
        title={version ? `CivStudio ${version}` : 'CivStudio'}
        subtitle={p
          ? `Province ${p}${realm ? ` · ${realm}` : ''} (${host})`
          : `The World of Anbennar (${host})`}
        primaryAction={
          <Flex gap={1}>
            <LinkButton href={tabHref} target="_blank" rel="noopener noreferrer"
              variant="tertiary" endIcon={<ExternalLink />}>
              Open in a new tab
            </LinkButton>
          </Flex>
        }
      />
      <Layouts.Content>
        {/* fill the viewport below the header/nav rather than a fixed box — this page IS the map */}
        <WorldMapFrame src={src} height="calc(100vh - 220px)" />
      </Layouts.Content>
    </Page.Main>
  );
}
