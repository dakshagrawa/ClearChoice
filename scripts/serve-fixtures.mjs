import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new globalThis.URL('../fixtures/mock-checkout.html', import.meta.url));
const checkoutFixture = await readFile(fixturePath, 'utf8');

const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/checkout') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(checkoutFixture);
});

server.listen(4173, '127.0.0.1', () => {
  console.log('Mock checkout: http://127.0.0.1:4173/checkout');
});
