'use agent';
import { useModel } from '@flue/runtime';

// StockJoke is the agent's durable identity: it names the generated Durable
// Object class (FlueStockJokeAgent) and the migration entry in wrangler.jsonc.
export function StockJoke() {
	// Orchestrator model: keyless Workers AI through the `AI` binding declared in
	// wrangler.jsonc, routed through AI Gateway by default. The joke itself will
	// come from an x402-paid AI Gateway /ai/run call inside the write_joke tool
	// (PLAN.md, step 5); this model only routes tool calls and writes the reply.
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	return [
		'You are StockJoke. You write one short, witty joke about a publicly traded stock.',
		'The user names a ticker (for example NVDA or AAPL). Reply with a single joke of at most 60 words that references the company or ticker.',
		'If no ticker is given, ask for one. Never give financial advice.',
	].join(' ');
}
