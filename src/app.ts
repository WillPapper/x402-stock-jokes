import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { StockJoke } from './agents/joker.ts';

const app = new Hono();

// The route map: every agent, channel, and custom route is mounted here
// explicitly. Talk to StockJoke with one POST per message:
//
//   curl -X POST http://localhost:5173/agents/joker/demo-1 \
//     -H 'content-type: application/json' \
//     -d '{"kind":"user","body":"Tell me a joke about NVDA."}'
app.route('/agents/joker', createAgentRouter(StockJoke));

app.get('/health', (c) => c.json({ ok: true }));

export default app;
