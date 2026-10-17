// Checks everything the app needs before it spends: wallet, balances, Permit2
// allowance, the three upstream 402 quotes, the Alchemy key and its paid
// fallback, and the Cloudflare token.
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ALCHEMY_GATEWAY, capacityLimit, signGatewaySiwe } from '../src/lib/alchemy.ts';
import { formatUsdc } from '../src/lib/budget.ts';
import { PERMIT2, USDC_BASE, decodePaymentRequired } from '../src/lib/x402.ts';
import { loadDevVars, privateKey, requireEnv, workerVars } from './_env.ts';

loadDevVars();
const vars = workerVars();
const orchestratorModel = vars.ORCHESTRATOR_MODEL ?? 'alibaba/qwen3.8-27b';
const ok = (msg: string) => console.log(`✓ ${msg}`);
const bad = (msg: string) => {
	console.log(`✗ ${msg}`);
	failures++;
};
let failures = 0;

const account = privateKeyToAccount(privateKey());
ok(`Wallet ${account.address}`);
if (process.env.EVM_BASE_ADDRESS && process.env.EVM_BASE_ADDRESS.toLowerCase() !== account.address.toLowerCase()) {
	bad(`EVM_BASE_ADDRESS does not match the key's address`);
}

const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org') });
const [eth, usdc, allowance] = await Promise.all([
	pub.getBalance({ address: account.address }),
	pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
	pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'allowance', args: [account.address, PERMIT2] }),
]);
(usdc > 0n ? ok : bad)(`USDC on Base: ${formatUnits(usdc, 6)}`);
(allowance > 0n ? ok : bad)(`Permit2 allowance: ${allowance > 0n ? formatUnits(allowance, 6) + ' USDC' : 'none (run: bun run approve)'}`);
console.log(`  ETH on Base: ${formatUnits(eth, 18)} (only needed for the one-time approval)`);

async function quote(label: string, url: string, init?: RequestInit) {
	const res = await fetch(url, init);
	const pr = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
	if (res.status !== 402 || !pr?.accepts?.length) {
		bad(`${label}: expected 402 with PAYMENT-REQUIRED, got ${res.status}`);
		return;
	}
	const q = pr.accepts[0]!;
	ok(`${label}: ${q.scheme} ${formatUsdc(BigInt(q.amount))} USDC on ${q.network}`);
}

await quote('StockTwits symbols/trending', 'https://api-staging-mgw.stocktwits.com/api/2/symbols/trending/AAPL.json');
await quote('StockTwits symbols/show', 'https://api-staging-mgw.stocktwits.com/api/2/symbols/show/AAPL.json');
await quote('Ceramic search', 'https://api.ceramic.ai/search', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ query: 'doctor' }),
});

// Alchemy: the free-plan key first, then the x402 gateway it falls back to (src/lib/alchemy.ts).
const gatewayPayments = vars.ALCHEMY_GATEWAY_PAYMENTS === 'credits' ? 'credits' : 'off';
const rpcPing = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
const alchemyKey = process.env.ALCHEMY_API_KEY;
if (alchemyKey) {
	const res = await fetch(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcPing });
	const text = await res.text();
	const limit = capacityLimit(res.status, text);
	if (res.ok && !limit) ok('Alchemy key: working');
	else if (limit) console.log(`! Alchemy key: out of ${limit} capacity, calls will use the gateway`);
	else bad(`Alchemy key: HTTP ${res.status} ${text.slice(0, 120)}`);
} else console.log('! ALCHEMY_API_KEY not set: every Alchemy call will use the gateway');
const { token: siwe } = await signGatewaySiwe(account);
const gateway = await fetch(`${ALCHEMY_GATEWAY}/base-mainnet/v2`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `SIWE ${siwe}` }, body: rpcPing });
const gatewayQuote = decodePaymentRequired(gateway.headers.get('PAYMENT-REQUIRED'))?.accepts?.[0];
const topUps = gatewayPayments === 'credits' ? 'top-ups ON (at most one a day)' : 'top-ups OFF (ALCHEMY_GATEWAY_PAYMENTS)';
if (gateway.ok) ok(`Alchemy gateway fallback: the wallet has credits; ${topUps}`);
else if (gateway.status === 402 && gatewayQuote)
	console.log(`! Alchemy gateway fallback: no credits on the wallet (quote ${formatUsdc(BigInt(gatewayQuote.amount))} USDC); ${topUps}${gatewayPayments === 'off' ? ', so the fallback will fail rather than pay' : ''}`);
else bad(`Alchemy gateway fallback: HTTP ${gateway.status}`);

const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
const token = requireEnv('CLOUDFLARE_API_TOKEN');
const verify = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${token}` } });
const v = (await verify.json()) as { success?: boolean; result?: { status?: string } };
(v.success ? ok : bad)(`Cloudflare token ${v.result?.status ?? 'invalid'}`);
await quote(`AI Gateway /ai/run (${orchestratorModel})`, `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`, {
	method: 'POST',
	headers: { authorization: `Bearer ${token}`, 'payment-method': 'x402', 'content-type': 'application/json' },
	body: JSON.stringify({ model: orchestratorModel, input: { messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 } }),
});

console.log(failures ? `\n${failures} problem(s).` : '\nReady.');
process.exit(failures ? 1 : 0);
