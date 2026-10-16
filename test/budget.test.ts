import { describe, expect, test } from 'bun:test';
import { Budget, BudgetExceededError, formatUsdc, usdToBaseUnits } from '../src/lib/budget.ts';
import { completionToSse, normalizeMessagesForWorkersAi } from '../src/lib/ai-gateway-provider.ts';
import { decodePaymentRequired, decodeReceipt } from '../src/lib/x402.ts';

describe('usdc units', () => {
	test('converts dollars to base units and back', () => {
		expect(usdToBaseUnits('0.01')).toBe(10000n);
		expect(usdToBaseUnits('1')).toBe(1000000n);
		expect(usdToBaseUnits('0.025606')).toBe(25606n);
		expect(formatUsdc(25606n)).toBe('0.025606');
		expect(formatUsdc(1000n)).toBe('0.001000');
	});
});

describe('Budget', () => {
	test('refuses a payment over the per-payment cap before reserving', () => {
		const b = new Budget(10000n, 1000000n);
		expect(() => b.reserve(10001n)).toThrow(BudgetExceededError);
		expect(b.remaining).toBe(1000000n);
	});
	test('reserve, commit and release track totals', () => {
		const b = new Budget(10000n, 2500n);
		b.reserve(1000n);
		expect(b.remaining).toBe(1500n);
		b.commit(1000n);
		expect(b.spent).toBe(1000n);
		b.reserve(1000n);
		b.release(1000n);
		expect(b.remaining).toBe(1500n);
		expect(() => b.reserve(1501n)).toThrow(/remaining budget/);
	});
});

describe('x402 header decoding', () => {
	const b64 = (o: unknown) => btoa(JSON.stringify(o));
	test('decodes PAYMENT-REQUIRED and PAYMENT-RESPONSE', () => {
		expect(decodePaymentRequired(b64({ x402Version: 2, accepts: [{ scheme: 'exact', amount: '1000' }] }))?.accepts[0]?.amount).toBe('1000');
		expect(decodeReceipt(b64({ success: true, transaction: '0xabc' }))?.transaction).toBe('0xabc');
		expect(decodeReceipt('not base64 json')).toBeNull();
		expect(decodeReceipt(null)).toBeNull();
	});
});

describe('completionToSse', () => {
	test('replays a tool call completion as chunks the OpenAI SDK can parse', () => {
		const sse = completionToSse({
			id: 'chatcmpl-1',
			model: 'openai/gpt-oss-20b',
			choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: 'think', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] } }],
			usage: { prompt_tokens: 1, completion_tokens: 2 },
		});
		const events = sse.split('\n\n').filter(Boolean).map((l) => l.replace(/^data: /, ''));
		expect(events.at(-1)).toBe('[DONE]');
		const first = JSON.parse(events[0]!);
		expect(first.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: 't1', function: { name: 'f', arguments: '{"a":1}' } });
		expect(first.choices[0].delta.reasoning_content).toBe('think');
		expect(JSON.parse(events[1]!).choices[0].finish_reason).toBe('tool_calls');
		expect(JSON.parse(events[2]!).usage.completion_tokens).toBe(2);
	});
});

describe('normalizeMessagesForWorkersAi', () => {
	test('flattens part arrays and null content to strings', () => {
		const out = normalizeMessagesForWorkersAi([
			{ role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
			{ role: 'assistant', content: null, tool_calls: [{ id: 't' }] },
			{ role: 'tool', content: 'ok', tool_call_id: 't' },
		]) as { content: unknown; tool_calls?: unknown }[];
		expect(out[0]!.content).toBe('ab');
		expect(out[1]!.content).toBe('');
		expect(out[1]!.tool_calls).toBeDefined();
		expect(out[2]!.content).toBe('ok');
	});
});
