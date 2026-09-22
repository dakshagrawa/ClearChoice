import { beforeEach, expect, it, vi } from 'vitest';

import { getDismissed, setDismissed } from './storage';

const get = vi.fn();
const set = vi.fn();

beforeEach(() => {
  get.mockReset();
  set.mockReset();
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { storage: { local: { get, set } } },
  });
});

it('reads only the local dismissed flag', async () => {
  get.mockResolvedValue({ dismissed: true, unrelated: 'not read' });

  await expect(getDismissed()).resolves.toBe(true);
  expect(get).toHaveBeenCalledWith('dismissed');
});

it('persists only the dismissed boolean locally', async () => {
  set.mockResolvedValue(undefined);

  await setDismissed(true);

  expect(set).toHaveBeenCalledWith({ dismissed: true });
  expect(set).toHaveBeenCalledTimes(1);
});

it('surfaces local storage errors', async () => {
  const error = new Error('storage unavailable');
  get.mockRejectedValue(error);

  await expect(getDismissed()).rejects.toThrow('storage unavailable');
});
