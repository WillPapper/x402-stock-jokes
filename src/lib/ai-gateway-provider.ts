/**
 * A pi-ai provider that runs Flue's own model turns through Cloudflare AI
 * Gateway machine payments (x402).
 *
 * Verified 2026-10-16: only `POST /ai/run` accepts `Payment-Method: x402`; it
 * returns `{ result: <OpenAI chat.completion>, success }`, supports `tools`,
 * and ignores `stream: true` (empty result). pi-ai's OpenAI adapter always
 * streams and builds its client with the `fetch` we pass in, so this module
 * hands it a fetch that (1) rewrites the chat-completions request into the
 * /ai/run envelope, (2) pays the x402 challenge, and (3) replays the
 * completed result as a one-shot SSE stream the adapter understands.
 */
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Model, ProviderStreams } from '@earendil-works/pi-ai';
import { upstreamIds } from './upstream.ts';
import type { createPaidFetch } from './x402.ts';

export const X402_PROVIDER_ID = 'x402-ai-gateway';

/** Models AI Gateway machine payments accept, per the docs on 2026-10-16. */
export const MACHINE_PAYMENT_MODELS = [
	'openai/gpt-oss-20b',
	'z-ai/glm-4.7-flash',
	'google/gemma-4-26b-a4b-it',
	'alibaba/qwen3.8-27b',
] as const;

type PaidFetch = ReturnType<typeof createPaidFetch>;

interface AiRunEnvelope {
	success: boolean;
	errors?: { code?: number; message?: string }[];
	result?: {
		id?: string;
		created?: number;
		model?: string;
		choices?: {
			index?: number;
			finish_reason?: string | null;
			message?: {
				role?: string;
				content?: string | null;
				reasoning_content?: string | null;
				tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[] | null;
			};
		}[];
		usage?: Record<string, unknown>;
	};
}

/** Turn a completed chat.completion into the SSE byte stream the OpenAI SDK expects. */
export function completionToSse(result: NonNullable<AiRunEnvelope['result']>): string {
	const base = { id: result.id ?? 'chatcmpl-x402', object: 'chat.completion.chunk', created: result.created ?? Math.floor(Date.now() / 1000), model: result.model ?? '' };
	const chunks: unknown[] = [];
	for (const choice of result.choices ?? []) {
		const m = choice.message ?? {};
		const delta: Record<string, unknown> = { role: m.role ?? 'assistant' };
		const reasoning = m.reasoning_content ?? (m as { reasoning?: string | null }).reasoning;
		if (reasoning) delta.reasoning_content = reasoning;
		if (m.content) delta.content = m.content;
		if (m.tool_calls?.length) {
			delta.tool_calls = m.tool_calls.map((tc, index) => ({ index, id: tc.id, type: tc.type ?? 'function', function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' } }));
		}
		chunks.push({ ...base, choices: [{ index: choice.index ?? 0, delta, finish_reason: null }] });
		chunks.push({ ...base, choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }] });
	}
	if (result.usage) chunks.push({ ...base, choices: [], usage: result.usage });
	return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/**
 * Workers AI's chat schema wants `content` as a string on every message, while
 * the OpenAI SDK (and pi-ai) send system/user content as part arrays and
 * assistant tool-call messages with `content: null`. Flatten both.
 */
export function normalizeMessagesForWorkersAi(messages: unknown): unknown {
	if (!Array.isArray(messages)) return messages;
	return messages.map((m) => {
		if (!m || typeof m !== 'object') return m;
		const msg = { ...(m as Record<string, unknown>) };
		const content = msg.content;
		if (Array.isArray(content)) {
			msg.content = content
				.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text ?? '') : typeof part === 'string' ? part : ''))
				.join('');
		} else if (content === null || content === undefined) {
			msg.content = '';
		}
		return msg;
	});
}

export interface X402AiGatewayOptions {
	/** Account id and token, or getters resolved per request (secrets stay lazy). */
	accountId: string | (() => string);
	apiToken: string | (() => string);
	/** Fetch that pays x402 challenges with the `upto` scheme. */
	paidFetch: PaidFetch;
	/** Model ids to expose, e.g. 'openai/gpt-oss-20b'. */
	models?: readonly string[];
	/** Hook for logging each paid turn. */
	onTurn?: (info: { model: string; status: number; ok: boolean; usage?: Record<string, unknown>; description: string; ids: Record<string, string>; durationMs: number; error?: string; finishReason?: string | null }) => void;
}

/**
 * Build the translating fetch. Exported for tests; `createX402AiGatewayProvider`
 * wires it into pi-ai.
 */
const resolve = (v: string | (() => string)) => (typeof v === 'function' ? v() : v);

export function createAiRunFetch(options: X402AiGatewayOptions): typeof fetch {
	return async (input, init) => {
		const aiRunUrl = `https://api.cloudflare.com/client/v4/accounts/${resolve(options.accountId)}/ai/run`;
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		if (!url.endsWith('/chat/completions')) {
			return options.paidFetch(input as string, init);
		}
		const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
		const { model, stream: _stream, stream_options: _so, store: _store, ...rest } = body;
		if ('messages' in rest) rest.messages = normalizeMessagesForWorkersAi(rest.messages);
		// Orchestration turns are tool routing; keep gpt-oss reasoning short and cheap.
		if (typeof model === 'string' && model.startsWith('openai/') && !('reasoning_effort' in rest)) rest.reasoning_effort = 'low';
		// Thinking stays ON for orchestration: without it Qwen asked the user to
		// confirm the ticker instead of calling the tools. (Slower final turn.)
		if (!('max_tokens' in rest) && !('max_completion_tokens' in rest)) rest.max_tokens = 2048;
		const started = Date.now();
		const res = await options.paidFetch(aiRunUrl, {
			method: 'POST',
			headers: { authorization: `Bearer ${resolve(options.apiToken)}`, 'payment-method': 'x402', 'content-type': 'application/json' },
			body: JSON.stringify({ model, input: rest }),
			signal: init?.signal ?? undefined,
		});
		const text = await res.text();
		let envelope: AiRunEnvelope | null = null;
		try {
			envelope = JSON.parse(text) as AiRunEnvelope;
		} catch {
			/* non-JSON error body */
		}
		if (!res.ok || !envelope?.success || !envelope.result) {
			const message = (envelope?.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || text.slice(0, 300) || res.statusText) + ` [cf-ray ${res.headers.get('cf-ray') ?? '-'}]`;
			options.onTurn?.({ model: String(model), status: res.status, ok: false, description: `failed: ${message} | ${options.paidFetch.describeLast()}`, ids: upstreamIds(res), durationMs: Date.now() - started, error: message });
			return new Response(JSON.stringify({ error: { message: `AI Gateway /ai/run ${res.status}: ${message}`, type: 'ai_gateway_error' } }), {
				status: res.ok ? 502 : res.status,
				headers: { 'content-type': 'application/json' },
			});
		}
		options.onTurn?.({ model: String(model), status: res.status, ok: true, usage: envelope.result.usage, description: options.paidFetch.describeLast(), ids: upstreamIds(res), durationMs: Date.now() - started, finishReason: envelope.result.choices?.[0]?.finish_reason ?? null });
		return new Response(completionToSse(envelope.result), { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};
}

export function createX402AiGatewayProvider(options: X402AiGatewayOptions) {
	const aiRunFetch = createAiRunFetch(options);
	const base = openAICompletionsApi();
	const withPayment = <F extends (...args: any[]) => any>(fn: F): F =>
		((model: unknown, context: unknown, opts?: Record<string, unknown>) =>
			fn(model, context, { ...opts, fetch: aiRunFetch, headers: { ...(opts?.headers as Record<string, string> | undefined), 'payment-method': 'x402' } })) as unknown as F;
	const api: ProviderStreams = { stream: withPayment(base.stream), streamSimple: withPayment(base.streamSimple) };

	const models = (options.models ?? MACHINE_PAYMENT_MODELS).map(
		(id): Model<'openai-completions'> => ({
			id,
			name: `${id} (x402 via AI Gateway)`,
			api: 'openai-completions',
			provider: X402_PROVIDER_ID,
			// Placeholder: createAiRunFetch rewrites every request to /ai/run.
			baseUrl: 'https://api.cloudflare.com/client/v4/accounts/_/ai/v1',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			compat: { maxTokensField: 'max_tokens', supportsUsageInStreaming: true, supportsStore: false },
		}),
	);

	return createProvider<'openai-completions'>({
		id: X402_PROVIDER_ID,
		name: 'Cloudflare AI Gateway (x402 machine payments)',
		auth: {
			apiKey: {
				name: 'Cloudflare API token',
				resolve: async () => ({ auth: { apiKey: resolve(options.apiToken) } }),
			},
		},
		models,
		api,
	});
}
