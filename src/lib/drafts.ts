/**
 * Hand-off between the write_joke tool and the agent's finish hook, keyed by
 * conversation id, so the finished joke can be stored in D1 with its payments.
 */
const drafts = new Map<string, JokeDraft>();
const access = new Map<string, 'password' | 'x402'>();
const titles = new Map<string, string>();

export interface JokeDraft {
	symbol: string;
	facts: string[];
	joke: string;
	model: string;
}

export const handoff = {
	setDraft: (conversationId: string, d: JokeDraft) => drafts.set(conversationId, d),
	takeDraft: (conversationId: string) => {
		const d = drafts.get(conversationId) ?? null;
		drafts.delete(conversationId);
		return d;
	},
	setAccess: (conversationId: string, by: 'password' | 'x402') => access.set(conversationId, by),
	takeAccess: (conversationId: string) => {
		const a = access.get(conversationId) ?? null;
		access.delete(conversationId);
		return a;
	},
	setTitle: (symbol: string, title: string) => titles.set(symbol.toUpperCase(), title),
	title: (symbol: string) => titles.get(symbol.toUpperCase()) ?? null,
};
