/**
 * A hash of the harness code (bench/, without snapshots, results and reports). Stored in every snapshot and every
 * run, so a comparison can check that both variants were crawled and run by the same harness.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['snapshots', 'results', 'report', 'node_modules']);

export function benchHash(root = path.resolve('bench')): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(root, f).replace(/\\/g, '/') + '\0');
    // Line endings differ between checkouts on Windows (CRLF vs LF): hash the text with LF
    h.update(fs.readFileSync(f).toString('binary').replace(/\r\n/g, '\n') + '\0');
  }
  return h.digest('hex').slice(0, 16);
}
