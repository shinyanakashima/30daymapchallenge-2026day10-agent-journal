// Minimal static server for dist/ under a GitHub Pages-style project path.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const BASE = '/30daymapchallenge-2026day10-agent-journal/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

export function serve(root = 'dist', port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(BASE)) { res.writeHead(404).end(); return; }
    let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(path.resolve(root)) && !path.resolve(file).startsWith(path.resolve(root))) { res.writeHead(403).end(); return; }
    try {
      const st = await stat(file);
      const target = st.isDirectory() ? path.join(file, 'index.html') : file;
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': TYPES[path.extname(target)] || 'application/octet-stream', 'content-length': body.length });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const { port: p } = server.address();
    resolve({ server, origin: `http://127.0.0.1:${p}`, url: `http://127.0.0.1:${p}${BASE}` });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await serve('dist', Number(process.env.PORT || 4173));
  console.log(`serving dist at ${url}`);
}
