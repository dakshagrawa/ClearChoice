import { expect, it, vi } from 'vitest';

import { analyzeActiveTab, restoreActiveTab } from './tab-analysis';

function installChrome(overrides: Partial<typeof chrome> = {}): {
  query: ReturnType<typeof vi.fn>;
  executeScript: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn().mockResolvedValue([{ id: 42, active: true }]);
  const executeScript = vi.fn().mockResolvedValue([]);
  const sendMessage = vi.fn().mockResolvedValue({ ok: true, status: 'supported', findingCount: 1 });
  vi.stubGlobal('chrome', {
    ...overrides,
    tabs: { query, sendMessage },
    scripting: { executeScript },
  });
  return { query, executeScript, sendMessage };
}

it('queries exactly the active current tab then injects and messages that tab only', async () => {
  const { query, executeScript, sendMessage } = installChrome();

  await expect(analyzeActiveTab()).resolves.toEqual({ ok: true, status: 'supported', findingCount: 1 });

  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  expect(executeScript).toHaveBeenCalledTimes(1);
  expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ['content.js'] });
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledWith(42, { type: 'CLEARCHOICE_ANALYZE' });
});

it('does not inject or message when the current active tab has no ID', async () => {
  const { executeScript, sendMessage } = installChrome({
    tabs: { query: vi.fn().mockResolvedValue([{ active: true }]), sendMessage: vi.fn() },
  });

  await expect(analyzeActiveTab()).resolves.toEqual({ ok: false, error: 'request-failed' });

  expect(executeScript).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

it.each([
  'Cannot access contents of url "chrome://settings". Extension manifest must request permission to access this host.',
  'Cannot access a chrome:// URL',
  'The extensions gallery cannot be scripted.',
  'Cannot access contents of url "https://chrome.google.com/webstore".',
  'Cannot access a PDF document.',
])('maps restricted injection errors to restricted-page', async (message) => {
  installChrome({
    scripting: { executeScript: vi.fn().mockRejectedValue(new Error(message)) },
  });

  await expect(analyzeActiveTab()).resolves.toEqual({ ok: false, error: 'restricted-page' });
});

it('maps generic injection failures and malformed message responses safely', async () => {
  const first = installChrome({
    scripting: { executeScript: vi.fn().mockRejectedValue(new Error('script failed')) },
  });
  await expect(analyzeActiveTab()).resolves.toEqual({ ok: false, error: 'injection-failed' });
  expect(first.sendMessage).not.toHaveBeenCalled();

  const second = installChrome({
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42, active: true }]), sendMessage: vi.fn().mockResolvedValue({ ok: true, result: {} }) },
  });
  await expect(restoreActiveTab()).resolves.toEqual({ ok: false, error: 'request-failed' });
  expect(second.sendMessage).toHaveBeenCalledWith(42, { type: 'CLEARCHOICE_RESTORE' });
});
