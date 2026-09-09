import { Suspense } from "react";

import BatchPage from "./batch-page";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string; dataset: string }>;
}) {
  const raw = await params;
  const org = decodeURIComponent(raw.org);
  const dataset = decodeURIComponent(raw.dataset);
  return { title: `${org}/${dataset} | batch auto-label` };
}

/** `/{org}/{dataset}/batch` — a fixed segment, so it wins over the
 * `[episode]` route next to it. Segments arrive URL-encoded (a pinned
 * `org/name@rev` carries an "@"). */
export default async function BatchRoute({
  params,
}: {
  params: Promise<{ org: string; dataset: string }>;
}) {
  const raw = await params;
  const org = decodeURIComponent(raw.org);
  const dataset = decodeURIComponent(raw.dataset);
  return (
    <Suspense fallback={null}>
      <BatchPage org={org} dataset={dataset} />
    </Suspense>
  );
}
