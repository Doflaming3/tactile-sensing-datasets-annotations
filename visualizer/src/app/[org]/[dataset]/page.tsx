import { redirect } from "next/navigation";

export default async function DatasetRootPage({
  params,
}: {
  params: Promise<{ org: string; dataset: string }>;
}) {
  // segments arrive URL-encoded (a pinned `org/name@rev` carries an "@")
  const raw = await params;
  const org = decodeURIComponent(raw.org);
  const dataset = decodeURIComponent(raw.dataset);
  const episodeN =
    process.env.EPISODES?.split(/\s+/)
      .map((x) => parseInt(x.trim(), 10))
      .filter((x) => !isNaN(x))[0] ?? 0;

  redirect(`/${org}/${dataset}/episode_${episodeN}`);
}
