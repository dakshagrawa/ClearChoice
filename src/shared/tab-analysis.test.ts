import { expect, it, vi } from 'vitest';
import { isCurrentActiveTab } from './tab-analysis';

it('checks only the current active tab identity, not another window or a stale tab ID', async () => {
  const query = vi.fn().mockResolvedValueOnce([{ id: 42 }]).mockResolvedValueOnce([{ id: 7 }]);
  vi.stubGlobal('chrome', { tabs: { query } });
  await expect(isCurrentActiveTab(42)).resolves.toBe(true);
  await expect(isCurrentActiveTab(42)).resolves.toBe(false);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  vi.unstubAllGlobals();
});
