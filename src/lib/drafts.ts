/**
 * Hand-off between the write_joke tool and the agent's finish hook, keyed by
 * conversation id, so the finished joke can be stored in D1 with its payments.
 */
const drafts = new Map<string, JokeDraft>();
const steps = new Map<string, Record<string, unknown>>();
const titles = new Map<string, string>();
const marks = new Map<string, number>();

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
	steps: (conversationId: string) => steps.get(conversationId) ?? null,
	takeSteps: (conversationId: string) => {
		const s = steps.get(conversationId) ?? null;
		steps.delete(conversationId);
		return s;
	},
	/** Ledger position when the conversation started, so tools can total its payments so far. */
	setMark: (conversationId: string, mark: number) => marks.set(conversationId, mark),
	mark: (conversationId: string) => marks.get(conversationId) ?? 0,
	takeMark: (conversationId: string) => {
		const m = marks.get(conversationId) ?? 0;
		marks.delete(conversationId);
		return m;
	},
	setTitle: (symbol: string, title: string) => titles.set(symbol.toUpperCase(), title),
	title: (symbol: string) => titles.get(symbol.toUpperCase()) ?? null,
};
