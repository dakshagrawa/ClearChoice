// @vitest-environment node
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { createFixtureTls, mockCheckoutHtml } from '../scripts/manual-qa-fixtures.mjs';
import { createServer } from 'node:https';
import { restrictedBrowserArgs } from '../scripts/manual-active-tab-qa.mjs';

test('only the two reserved fixture DNS names bypass the dead proxy', async () => {
  const args = restrictedBrowserArgs('/synthetic-extraction');
  expect(args).toContain('--proxy-bypass-list=<-loopback>;checkout-a.test;checkout-b.test');
  expect(args).toContain('--host-resolver-rules=MAP checkout-a.test 127.0.0.1, MAP checkout-b.test 127.0.0.1, MAP * ~NOTFOUND');
  const tls = await createFixtureTls();
  const server = createServer({ key: tls.key, cert: tls.cert }, (_request, response) => response.end(mockCheckoutHtml()));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: [...args, `--ignore-certificate-errors-spki-list=${tls.pin}`] });
  try {
    const page = await browser.newPage();
    for (const host of ['checkout-a.test', 'checkout-b.test']) {
      await expect(page.goto(`https://${host}:${port}`, { timeout: 3000 })).resolves.toBeTruthy();
      expect(await page.locator('form,input').count()).toBe(0);
    }
    for (const url of ['http://127.0.0.2:8080', 'http://192.0.2.1:8080', 'https://othernotmapped.test']) {
      await expect(page.goto(url, { timeout: 3000 })).rejects.toThrow();
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await tls.cleanup();
  }
});
