import EpisodeViewer from "./episode-viewer";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; dataset: string; episode: string }>;
}) {
  // Route segments arrive URL-encoded; a pinned reference (`org/name@rev`)
  // carries an "@" that must be decoded before it reaches the URL builders.
  const raw = await params;
  const org = decodeURIComponent(raw.org);
  const dataset = decodeURIComponent(raw.dataset);
  const episode = decodeURIComponent(raw.episode);
  return {
    title: `${org}/${dataset} | episode ${episode}`,
  };
}

export default async function EpisodePage({
  params,
}: {
  params: Promise<{ org: string; dataset: string; episode: string }>;
}) {
  // episode is like 'episode_1'
  // Route segments arrive URL-encoded; a pinned reference (`org/name@rev`)
  // carries an "@" that must be decoded before it reaches the URL builders.
  const raw = await params;
  const org = decodeURIComponent(raw.org);
  const dataset = decodeURIComponent(raw.dataset);
  const episode = decodeURIComponent(raw.episode);
  // fetchData should be updated if needed to support this path pattern
  const episodeNumber = Number(episode.replace(/^episode_/, ""));
  return (
    <Suspense fallback={null}>
      <EpisodeViewer org={org} dataset={dataset} episodeId={episodeNumber} />
    </Suspense>
  );
}
