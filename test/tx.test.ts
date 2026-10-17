import { describe, expect, test } from 'bun:test';
import { basescanTxUrl } from '../src/lib/tx.ts';

describe('basescanTxUrl', () => {
	const hash = '0x' + 'ab'.repeat(32);
	test('links a real transaction hash, lower-cased', () => {
		expect(basescanTxUrl(hash.toUpperCase().replace('0X', '0x'))).toBe(`https://basescan.org/tx/${hash}`);
	});
	test('refuses anything that is not a 32-byte hex hash', () => {
		expect(basescanTxUrl('0x1234')).toBeNull();
		expect(basescanTxUrl(`${hash}" onmouseover="alert(1)`)).toBeNull();
		expect(basescanTxUrl(undefined)).toBeNull();
		expect(basescanTxUrl(42)).toBeNull();
	});
});
