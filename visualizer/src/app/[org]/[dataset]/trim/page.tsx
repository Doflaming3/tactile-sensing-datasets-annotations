import { Suspense } from "react";

import TrimPage from "./trim-page";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; dataset: string }>;
}) {
  const raw = await params;
  const org = decodeURIComponent(raw.org);
  const dataset = decodeURIComponent(raw.dataset);
  return { title: `${org}/${dataset} | trim` };
}

/** `/{org}/{dataset}/trim` — a fixed segment, so it wins over the
 * `[episode]` route next to it. Segments arrive URL-encoded. */
export default async function TrimRoute({
  params,
}: {
  params: Promise<{ org: string; dataset: string }>;
}) {
  const raw = await params;
  const org = decodeURIComponent(raw.org);
  const dataset = decodeURIComponent(raw.dataset);
  return (
    <Suspense fallback={null}>
      <TrimPage org={org} dataset={dataset} />
    </Suspense>
  );
}
