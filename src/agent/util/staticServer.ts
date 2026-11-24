import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** Serves a folder over http on 127.0.0.1 (the demo fixture). Port 0 picks a free port. */
export async function serveDir(dir: string, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
    let file = path.resolve(root, '.' + (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const { port: p } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${p}`, close: () => new Promise(r => server.close(() => r())) };
}

// `npm run fixture` serves test-site/ on port 5050
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('util', 'staticServer.ts'))) {
  const dir = process.argv[2] || 'test-site';
  serveDir(dir, Number(process.argv[3] || 5050)).then(s => console.log(`Serving ${dir} at ${s.url}/index.html`));
}
