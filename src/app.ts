/**
 * The route map. Every route is mounted here, in these four modules:
 *
 *   src/routes/agent.ts      POST /joke/<TICKER>, GET /joke/<id>, the gated /agents/joke/* conversation routes
 *   src/routes/public.ts     /api/health, /api/jokes, /api/jokes/latest, /api/stats, /api/transfers, /api/wallet, /api/ledger
 *   src/routes/permalink.ts  GET /j/<id>
 *   src/routes/internal.ts   /api/events, /api/_trace (behind Cloudflare Access)
 *
 * The x402 AI Gateway provider the agent runs on is registered in src/cloudflare.ts.
 */
import { Hono } from 'hono';
import { agentRoutes } from './routes/agent.ts';
import { internalRoutes } from './routes/internal.ts';
import { permalinkRoutes } from './routes/permalink.ts';
import { publicRoutes } from './routes/public.ts';

const app = new Hono();
app.route('/', agentRoutes);
app.route('/', publicRoutes);
app.route('/', permalinkRoutes);
app.route('/', internalRoutes);

export default app;
