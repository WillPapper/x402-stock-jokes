import { env } from 'cloudflare:workers';
import { Budget, usdToBaseUnits } from './budget.ts';
import { createPaidFetch } from './x402.ts';
import { ledger } from './ledger.ts';

interface Bindings {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	EVM_BASE_PRIVATE_KEY: string;
	EVM_BASE_ADDRESS?: string;
	MAX_USDC_PER_DATA_CALL?: string;
	MAX_USDC_PER_INFERENCE?: string;
	MAX_USDC_PER_ISOLATE?: string;
	ORCHESTRATOR_MODEL?: string;
	JOKE_MODEL?: string;
}

const e = env as unknown as Bindings;

function need(name: keyof Bindings): string {
	const v = e[name];
	if (!v) throw new Error(`Missing secret ${name}. Set it in .dev.vars (local) or with wrangler secret put (deployed).`);
	return v;
}

export const config = {
	get accountId() {
		return need('CLOUDFLARE_ACCOUNT_ID');
	},
	get apiToken() {
		return need('CLOUDFLARE_API_TOKEN');
	},
	get privateKey(): `0x${string}` {
		const pk = need('EVM_BASE_PRIVATE_KEY');
		return (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
	},
	get orchestratorModel() {
		return e.ORCHESTRATOR_MODEL ?? 'openai/gpt-oss-20b';
	},
	get jokeModel() {
		return e.JOKE_MODEL ?? 'z-ai/glm-4.7-flash';
	},
	get maxUsdPerDataCall() {
		return e.MAX_USDC_PER_DATA_CALL ?? '0.01';
	},
	get maxUsdPerInference() {
		return e.MAX_USDC_PER_INFERENCE ?? '0.10';
	},
	get maxUsdPerIsolate() {
		return e.MAX_USDC_PER_ISOLATE ?? '5';
	},
	get aiRunUrl() {
		return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run`;
	},
};

/** Caps shared by every data call this isolate makes (StockTwits, Ceramic). */
export const dataBudget = new Budget(usdToBaseUnits(config.maxUsdPerDataCall), usdToBaseUnits(config.maxUsdPerIsolate));
/** Caps shared by every inference authorization this isolate makes (AI Gateway). */
export const inferenceBudget = new Budget(usdToBaseUnits(config.maxUsdPerInference), usdToBaseUnits(config.maxUsdPerIsolate));

export function paidDataFetch(label: string) {
	return createPaidFetch({
		privateKey: config.privateKey,
		budget: dataBudget,
		maxUsdPerPayment: `$${config.maxUsdPerDataCall}`,
		onReceipt: (ev) => ledger.record(label, ev),
	});
}

export function paidInferenceFetch(label: string) {
	return createPaidFetch({
		privateKey: config.privateKey,
		budget: inferenceBudget,
		maxUsdPerPayment: `$${config.maxUsdPerInference}`,
		onReceipt: (ev) => ledger.record(label, ev),
	});
}
