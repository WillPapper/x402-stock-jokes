/**
 * Hand-off between the write_joke tool and the agent's finish hook, keyed by
 * conversation id, so the finished joke can be stored in D1 with its payments.
 */
const drafts = new Map<string, JokeDraft>();
const steps = new Map<string, Record<string, unknown>>();
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
	/** Raw tool outputs for the "under the hood" view, keyed by conversation. */
	setStep: (conversationId: string, name: 'stocktwits' | 'ceramic' | 'joke', output: unknown) => {
		steps.set(conversationId, { ...(steps.get(conversationId) ?? {}), [name]: output });
	},
	takeSteps: (conversationId: string) => {
		const s = steps.get(conversationId) ?? null;
		steps.delete(conversationId);
		return s;
	},
	setTitle: (symbol: string, title: string) => titles.set(symbol.toUpperCase(), title),
	title: (symbol: string) => titles.get(symbol.toUpperCase()) ?? null,
};
