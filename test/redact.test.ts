import { describe, expect, test } from 'bun:test';
import { redactAccountIds } from '../src/lib/redact.ts';

describe('redactAccountIds', () => {
	test('replaces the account id inside Cloudflare API URLs, wherever it is nested', () => {
		const input = {
			payments: [{ url: 'https://api.cloudflare.com/client/v4/accounts/fedcba9876543210fedcba9876543210/ai/run', tx: null }],
			steps: { joke: { payments: [{ url: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run' }] } },
		};
		const out = redactAccountIds(input);
		expect(out.payments[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/<account>/ai/run');
		expect(out.steps.joke.payments[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/<account>/ai/run');
		expect(JSON.stringify(out)).not.toMatch(/[0-9a-f]{32}/);
	});
	test('leaves values without an account id untouched, including other 32-hex strings', () => {
		const input = { tx: 'https://basescan.org/tx/0x23107b86878bb565e6f0adfec8ea5e699267417e3401ac67fd086be98dea9b9a', jti: '36567050ca8a425fa067be04a3c3c0de' };
		expect(redactAccountIds(input)).toEqual(input);
	});
});
