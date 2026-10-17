import { env } from 'cloudflare:workers';
import { Budget, usdToBaseUnits } from './budget.ts';
import { createPaidFetch } from './x402.ts';
import { ledger } from './ledger.ts';
import { logEvent } from './log.ts';

interface Bindings {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	EVM_BASE_PRIVATE_KEY: string;
	EVM_BASE_ADDRESS?: string;
	MAX_USDC_PER_DATA_CALL?: string;
	MAX_USDC_PER_INFERENCE?: string;
	MAX_USDC_PER_ISOLATE?: string;
	MAX_USDC_PER_ALCHEMY_TOPUP?: string;
	MAX_USDC_ALCHEMY_PER_ISOLATE?: string;
	ORCHESTRATOR_MODEL?: string;
	JOKE_MODEL?: string;
	ALCHEMY_API_KEY?: string;
	RUNNER_LOCATION_HINT?: string;
	JOKE_RUNNER?: DurableObjectNamespace;
}

// `env` from cloudflare:workers is live, so reads happen at call time, never at module load.
const e = env as unknown as Bindings;

function need(name: 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_API_TOKEN' | 'EVM_BASE_PRIVATE_KEY'): string {
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
		return e.ORCHESTRATOR_MODEL ?? 'alibaba/qwen3.8-27b';
	},
	get jokeModel() {
		return e.JOKE_MODEL ?? 'google/gemma-4-26b-a4b-it';
	},
	get maxUsdPerDataCall() {
		return e.MAX_USDC_PER_DATA_CALL ?? '0.01';
	},
	get maxUsdPerInference() {
		return e.MAX_USDC_PER_INFERENCE ?? '0.25';
	},
	get maxUsdPerIsolate() {
		return e.MAX_USDC_PER_ISOLATE ?? '5';
	},
	/** Alchemy's gateway sells credits in $1 top-ups; a larger quote is refused. */
	get maxUsdPerAlchemyTopup() {
		return e.MAX_USDC_PER_ALCHEMY_TOPUP ?? '1';
	},
	get maxUsdAlchemyPerIsolate() {
		return e.MAX_USDC_ALCHEMY_PER_ISOLATE ?? '1';
	},
	get runnerLocationHint(): DurableObjectLocationHint {
		return (e.RUNNER_LOCATION_HINT ?? 'wnam') as DurableObjectLocationHint;
	},
	get runner(): DurableObjectNamespace {
		if (!e.JOKE_RUNNER) throw new Error('JOKE_RUNNER Durable Object binding is missing; check wrangler.jsonc');
		return e.JOKE_RUNNER;
	},
	get alchemyKey() {
		return e.ALCHEMY_API_KEY ?? null;
	},
	get aiRunUrl() {
		return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run`;
	},
};

let budgets: { data: Budget; inference: Budget; alchemy: Budget } | null = null;
/** Caps shared by every payment this isolate makes; created on first use. */
export function getBudgets() {
	return (budgets ??= {
		data: new Budget(usdToBaseUnits(config.maxUsdPerDataCall), usdToBaseUnits(config.maxUsdPerIsolate)),
		inference: new Budget(usdToBaseUnits(config.maxUsdPerInference), usdToBaseUnits(config.maxUsdPerIsolate)),
		alchemy: new Budget(usdToBaseUnits(config.maxUsdPerAlchemyTopup), usdToBaseUnits(config.maxUsdAlchemyPerIsolate)),
	});
}

export function paidDataFetch(label: string) {
	return createPaidFetch({
		privateKey: () => config.privateKey,
		budget: getBudgets().data,
		maxUsdPerPayment: `$${config.maxUsdPerDataCall}`,
		label,
		onReceipt: (ev) => ledger.record(label, ev),
		onEvent: (ev) => logEvent('x402.payment', ev.ok, ev as unknown as Record<string, unknown>, { label }),
	});
}

/** Pays Alchemy's x402 gateway for credits when the free-plan key is out of capacity (src/lib/alchemy.ts). */
export function paidAlchemyFetch(label: string) {
	return createPaidFetch({
		privateKey: () => config.privateKey,
		budget: getBudgets().alchemy,
		maxUsdPerPayment: `$${config.maxUsdPerAlchemyTopup}`,
		label,
		onReceipt: (ev) => ledger.record(label, ev),
		onEvent: (ev) => logEvent('x402.payment', ev.ok, ev as unknown as Record<string, unknown>, { label }),
	});
}

export function paidInferenceFetch(label: string) {
	return createPaidFetch({
		privateKey: () => config.privateKey,
		budget: getBudgets().inference,
		maxUsdPerPayment: `$${config.maxUsdPerInference}`,
		label,
		onReceipt: (ev) => ledger.record(label, ev),
		onEvent: (ev) => logEvent('x402.payment', ev.ok, ev as unknown as Record<string, unknown>, { label }),
	});
}
