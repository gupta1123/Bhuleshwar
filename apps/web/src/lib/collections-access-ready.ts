export function collectionsAccessReady({ loading, error, enforcementRequired, snapshot }: {
  loading: boolean; error: string | null; enforcementRequired: boolean; snapshot: unknown;
}) {
  return !loading && !error && (!enforcementRequired || Boolean(snapshot));
}
