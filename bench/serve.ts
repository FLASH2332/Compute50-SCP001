/**
 * Serves a local fixture folder over HTTP (for the local benchmark sites).
 *
 *   npx tsx bench/serve.ts <folder> [port]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

export function serveFolder(folder: string, port: number): Promise<http.Server> {
  const root = path.resolve(folder);
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
    let file = path.join(root, rel);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    else if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('bench/serve.ts')) {
  const folder = process.argv[2];
  const port = Number(process.argv[3] || 4100);
  if (!folder) { console.error('usage: npx tsx bench/serve.ts <folder> [port]'); process.exit(2); }
  await serveFolder(folder, port);
  console.log(`Serving ${path.resolve(folder)} at http://127.0.0.1:${port}/`);
}
