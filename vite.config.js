import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Serves published/candidate revisions (default: data/revisions of this workspace; LSV_REVISIONS overrides) at /revisions.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REV = path.resolve(process.env.LSV_REVISIONS || path.join(HERE, 'data', 'revisions'));
function revisions() {
  return {
    name: 'revisions',
    configureServer(server) {
      server.middlewares.use('/revisions', (req, res, next) => {
        const p = path.join(REV, decodeURIComponent(req.url.split('?')[0]));
        if (!p.startsWith(REV) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return next();
        res.setHeader('Content-Type', p.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(p).pipe(res);
      });
    },
  };
}

export default defineConfig({
  cacheDir: path.join(HERE, '.vite-cache'),      // per worktree: parallel dev servers must not share one dep cache
  plugins: [revisions()],
  server: { host: '127.0.0.1', port: 5188, strictPort: true, fs: { strict: false } },
  optimizeDeps: { exclude: ['@thatopen/fragments'] },
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { viewer: path.join(HERE, 'viewer/index.html'), poc: path.join(HERE, 'index.html') } } },
});
