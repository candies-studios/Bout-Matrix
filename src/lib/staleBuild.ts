// After a new version is deployed, a tab opened earlier still points at the old file names
// (e.g. assets/EventPage-abc123.js), which no longer exist. Reload once to pick up the new version.
const KEY = 'reloaded-for-new-version-at';

export function isStaleChunkError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(msg);
}

/** Reloads the page once (not more than every 30 s, so a real outage can't cause a reload loop). */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // storage unavailable: still reload once per page load
  }
  window.location.reload();
  return true;
}

/** Wraps a dynamic import so a stale-version failure reloads the page instead of showing an error. */
export function importWithReload<T>(loader: () => Promise<T>): () => Promise<T> {
  return () =>
    loader().catch((e: unknown) => {
      if (isStaleChunkError(e) && reloadForNewVersion()) return new Promise<T>(() => {}); // page is reloading
      throw e;
    });
}
