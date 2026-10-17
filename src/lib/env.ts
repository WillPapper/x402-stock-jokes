import { env } from 'cloudflare:workers';
import type { GatewayPayments } from './alchemy.ts';
import { Budget, usdToBaseUnits } from './budget.ts';
import { ledger, paymentRecord } from './ledger.ts';
import { conversationScope, logEvent } from './log.ts';
import { addRunPayment } from './runs.ts';
import { createPaidFetch } from './x402.ts';

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
	ALCHEMY_GATEWAY_PAYMENTS?: string;
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
	/** Fails closed: only the exact value "credits" lets the Alchemy fallback buy credits. */
	get alchemyGatewayPayments(): GatewayPayments {
		return e.ALCHEMY_GATEWAY_PAYMENTS === 'credits' ? 'credits' : 'off';
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

/** The three kinds of paid call, each with its own per-payment cap and shared per-isolate cap. */
export type PaidKind = 'data' | 'inference' | 'alchemy';

let budgets: Record<PaidKind, Budget> | null = null;
/** Caps shared by every payment this isolate makes; created on first use. */
export function getBudgets() {
	return (budgets ??= {
		data: new Budget(usdToBaseUnits(config.maxUsdPerDataCall), usdToBaseUnits(config.maxUsdPerIsolate)),
		inference: new Budget(usdToBaseUnits(config.maxUsdPerInference), usdToBaseUnits(config.maxUsdPerIsolate)),
		alchemy: new Budget(usdToBaseUnits(config.maxUsdPerAlchemyTopup), usdToBaseUnits(config.maxUsdAlchemyPerIsolate)),
	});
}

const perPaymentCap: Record<PaidKind, () => string> = {
	data: () => config.maxUsdPerDataCall,
	inference: () => config.maxUsdPerInference,
	alchemy: () => config.maxUsdPerAlchemyTopup,
};

/**
 * A fetch that pays x402 challenges from the app wallet. Every completed
 * payment is logged as an `x402.payment` event and, when it belongs to a run,
 * stored in `run_payments` before the response is returned. Tools pass their
 * conversation id; the orchestrator's own turns (made by the pi-ai provider,
 * which knows no conversation) fall back to the agent's log scope.
 */
export function paidFetch(kind: PaidKind, label: string, conversationId?: string | null) {
	return createPaidFetch({
		privateKey: () => config.privateKey,
		budget: getBudgets()[kind],
		maxUsdPerPayment: `$${perPaymentCap[kind]()}`,
		label,
		onPayment: async (ev) => {
			const id = conversationId ?? conversationScope.get();
			logEvent('x402.payment', ev.ok, ev as unknown as Record<string, unknown>, { label, conversationId: id });
			const rec = paymentRecord(label, ev);
			if (!rec) return;
			ledger.record(rec);
			if (id) await addRunPayment(id, rec).catch((err) => console.warn('run payment persist failed', (err as Error).message.slice(0, 120)));
		},
	});
}

export const paidDataFetch = (label: string, conversationId?: string | null) => paidFetch('data', label, conversationId);
export const paidInferenceFetch = (label: string, conversationId?: string | null) => paidFetch('inference', label, conversationId);
/** Pays Alchemy's x402 gateway for credits when the free-plan key is out of capacity (src/lib/alchemy.ts). */
export const paidAlchemyFetch = (label: string) => paidFetch('alchemy', label, null);
