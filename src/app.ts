import { setProvider } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { StockJoke } from './agents/joker.ts';
import { createX402AiGatewayProvider } from './lib/ai-gateway-provider.ts';
import { config, paidInferenceFetch } from './lib/env.ts';
import { ledger } from './lib/ledger.ts';
import { PERMIT2, USDC_BASE, walletFromKey } from './lib/x402.ts';

// The agent's own model turns go through AI Gateway machine payments: every
// chat-completions call pi-ai makes is rewritten to /ai/run and paid with x402.
setProvider(
	createX402AiGatewayProvider({
		accountId: config.accountId,
		apiToken: config.apiToken,
		paidFetch: paidInferenceFetch('AI Gateway orchestrator turn'),
		onTurn: (t) => console.log(`[x402-ai-gateway] ${t.model} ${t.status} ${t.description}`),
	}),
);

const app = new Hono();

// Talk to StockJoke with one POST per message, then GET the same URL to read:
//
//   curl -X POST http://localhost:5173/agents/joker/demo-1 \
//     -H 'content-type: application/json' \
//     -d '{"kind":"user","body":"Tell me a joke about NVDA."}'
//   curl http://localhost:5173/agents/joker/demo-1
app.route('/agents/joker', createAgentRouter(StockJoke));

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/wallet', async (c) => {
	const address = walletFromKey(config.privateKey).address;
	const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
	const [usdc, allowance] = await Promise.all([
		client.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
		client.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'allowance', args: [address, PERMIT2] }),
	]);
	return c.json({ address, network: 'eip155:8453', usdc: formatUnits(usdc, 6), permit2Approved: allowance > 0n, basescan: `https://basescan.org/address/${address}` });
});

app.get('/api/ledger', (c) => c.json({ payments: ledger.all() }));

export default app;
