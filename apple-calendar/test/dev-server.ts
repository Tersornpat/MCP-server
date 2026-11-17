// Local development server: `npm run dev`. Reads the same env vars as production.
import { serve } from '@hono/node-server';
import app from '../src/index.js';

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`Apple Calendar MCP listening on http://localhost:${port}`);
