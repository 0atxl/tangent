import { defineConfig } from 'vite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Dev middleware so /api/* Vercel serverless functions run locally
 * during `npm run dev` (using the built-in in-memory Redis fallback
 * when UPSTASH_REDIS_REST_URL is not configured).
 */
function localApiPlugin() {
  const projectRoot = process.cwd();
  return {
    name: 'tangent-local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) return next();

        try {
          const urlObj = new URL(req.url, 'http://localhost');
          const pathname = urlObj.pathname;

          let relPath = null;
          let routeParams = {};

          if (pathname === '/api/record') relPath = 'api/record.js';
          else if (pathname === '/api/submit') relPath = 'api/submit.js';
          else if (pathname === '/api/wiki') relPath = 'api/wiki.js';
          else if (pathname === '/api/daily') relPath = 'api/daily.js';
          else if (pathname === '/api/room/create') relPath = 'api/room/create.js';
          else if (pathname === '/api/room/join') relPath = 'api/room/join.js';
          else if (pathname === '/api/room/start') relPath = 'api/room/start.js';
          else if (pathname === '/api/room/progress') relPath = 'api/room/progress.js';
          else if (/^\/api\/room\/([A-Za-z0-9_-]+)$/.test(pathname)) {
            relPath = 'api/room/[code].js';
            routeParams.code = pathname.split('/').pop();
          }

          if (!relPath) return next();

          // Parse JSON body for POST/PUT
          let body = {};
          if (req.method === 'POST' || req.method === 'PUT') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw) {
              try {
                body = JSON.parse(raw);
              } catch {
                body = {};
              }
            }
          }

          const query = Object.fromEntries(urlObj.searchParams.entries());
          Object.assign(query, routeParams);

          const absUrl = pathToFileURL(path.resolve(projectRoot, relPath)).href;
          const mod = await import(`${absUrl}?t=${Date.now()}`);
          const handler = mod.default;

          const mockReq = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            query,
            body,
            socket: req.socket
          };

          const mockRes = {
            statusCode: 200,
            get headersSent() {
              return res.headersSent;
            },
            setHeader(k, v) {
              res.setHeader(k, v);
              return this;
            },
            flushHeaders() {
              if (typeof res.flushHeaders === 'function') res.flushHeaders();
            },
            status(code) {
              this.statusCode = code;
              res.statusCode = code;
              return this;
            },
            write(chunk) {
              res.statusCode = this.statusCode;
              return res.write(chunk);
            },
            json(payload) {
              if (!res.headersSent) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
              }
              res.statusCode = this.statusCode;
              res.end(JSON.stringify(payload));
            },
            end(data) {
              res.statusCode = this.statusCode;
              res.end(data);
            },
            destroy(err) {
              if (typeof res.destroy === 'function') res.destroy(err);
              else res.end();
            }
          };

          await handler(mockReq, mockRes);
        } catch (err) {
          console.error('[local-api]', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Local API error', details: err.message }));
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [localApiPlugin()],
  build: {
    target: 'es2022',
    outDir: 'dist'
  },
  server: {
    port: 5173,
    strictPort: false
  }
});
