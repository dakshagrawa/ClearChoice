import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROUTES = new Map([
  ['/checkout/clean', 'clean-checkout.html'],
  ['/checkout/recurring', 'recurring-checkout.html'],
  ['/checkout/addon', 'paid-addon-checkout.html'],
  ['/checkout/mixed', 'mixed-checkout.html'],
]);

function configuredPort(value) {
  if (value === undefined) return 4173;
  if (!/^(?:0|[1-9]\d{0,4})$/.test(value)) throw new Error('PORT must be an integer from 0 through 65535.');
  const port = Number(value);
  if (port > 65535) throw new Error('PORT must be an integer from 0 through 65535.');
  return port;
}

const fixtures = new Map(await Promise.all(
  Array.from(ROUTES, async ([route, filename]) => [
    route,
    await readFile(fileURLToPath(new globalThis.URL(`../fixtures/${filename}`, import.meta.url)), 'utf8'),
  ]),
));

const server = createServer((request, response) => {
  const fixture = request.method === 'GET' ? fixtures.get(request.url) : undefined;
  if (fixture === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixture);
});

server.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(configuredPort(process.env.PORT), '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port.');
  console.log(`Mock checkout: http://127.0.0.1:${address.port}`);
});
