import { afterEach, describe, expect, it, vi } from 'vitest';
import { importWithReload, isStaleChunkError } from './staleBuild';

describe('stale build recovery', () => {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
  afterEach(() => {
    reload.mockClear();
    sessionStorage.clear();
  });

  it('recognises missing-chunk errors from Chrome, Firefox and Safari', () => {
    expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/EventPage-_taYIqdj.js'))).toBe(true);
    expect(isStaleChunkError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunkError(new Error('Bout not found'))).toBe(false);
  });

  it('reloads once on a stale chunk, then lets a repeat failure surface (no reload loop)', async () => {
    const fail = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: x'));
    void importWithReload(fail)();
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(importWithReload(fail)()).rejects.toThrow(/Failed to fetch/);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload for other errors', async () => {
    await expect(importWithReload(() => Promise.reject(new Error('boom')))()).rejects.toThrow('boom');
    expect(reload).not.toHaveBeenCalled();
  });
});
