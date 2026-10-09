// The shop's own server, started by `pnpm start`. next.config.ts refuses `next start`.
import { createServer } from 'node:http';

import next from 'next';

process.env.SHOP_SERVER = '1';
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const app = next({ dev: false, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
createServer((req, res) => {
  void handle(req, res);
}).listen(port, hostname, () => {
  console.log(`> Shop ready on http://${hostname}:${String(port)}`);
});
