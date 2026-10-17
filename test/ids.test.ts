import { describe, expect, test } from 'bun:test';
import { JOKE_ID, jokeConversationId } from '../src/lib/ids.ts';

describe('jokeConversationId', () => {
	test('ticker, base-36 time, four random chars', () => {
		const id = jokeConversationId('DIS', 1792284707000, 0.123456789);
		expect(id).toMatch(JOKE_ID);
		expect(id.startsWith('j-dis-')).toBe(true);
		expect(id.split('-')[2]).toBe((1792284707000).toString(36));
		expect(id.split('-')[3]).toHaveLength(4);
	});
	test('sorts by creation time within a ticker', () => {
		const a = jokeConversationId('NET', 1792284707000, 0.5);
		const b = jokeConversationId('NET', 1792284707001, 0.5);
		expect(a < b).toBe(true);
	});
	test('keeps dots, strips anything else, never empties', () => {
		expect(jokeConversationId('BRK.B', 1, 0.5).startsWith('j-brk.b-')).toBe(true);
		expect(jokeConversationId('$$', 1, 0.5).startsWith('j-x-')).toBe(true);
		expect(jokeConversationId('A', 1792284707000, 0)).toMatch(JOKE_ID);
	});
	test('real IDs match the shape, hand-typed ones do not', () => {
		expect('j-dis-mvbohnzt-2wsz').toMatch(JOKE_ID);
		expect('web-379b3aeb').not.toMatch(JOKE_ID);
		expect('test-demo-1').not.toMatch(JOKE_ID);
	});
});
