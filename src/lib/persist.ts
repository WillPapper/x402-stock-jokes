/**
 * Storing a finished joke in D1 from the run's own records. Called twice per
 * run: by `write_joke` as soon as the joke exists (the agent's closing turn can
 * still fail, and the paid-for joke must not vanish with it) and by the finish
 * hook, which tops the row up with the closing turn's payments. Both go
 * through the same path, so a Durable Object restart in between changes nothing.
 */
import { completeJoke, insertJoke, jokeForConversation } from './db.ts';
import { config } from './env.ts';
import { totalAuthorizedUsdc } from './ledger.ts';
import { getRun, runPayments } from './runs.ts';

export interface JokeStep {
	joke: string;
	model: string;
	facts: string[];
	input?: { symbol?: string; company?: string };
}

export type Persisted = { outcome: 'inserted'; jokeId: string; ticker: string } | { outcome: 'completed'; ticker: string } | { outcome: 'none'; reason: string };

export async function persistJoke(conversationId: string): Promise<Persisted> {
	const [run, payments, existing] = await Promise.all([getRun(conversationId), runPayments(conversationId), jokeForConversation(conversationId)]);
	const steps = (run?.steps as Record<string, unknown> | null) ?? null;
	const total = totalAuthorizedUsdc(payments);
	if (existing) {
		await completeJoke(conversationId, { payments, totalAuthorizedUsdc: total, steps });
		return { outcome: 'completed', ticker: existing.ticker };
	}
	const draft = steps?.joke as JokeStep | undefined;
	if (!draft?.joke) return { outcome: 'none', reason: 'write_joke has not returned a joke' };
	const ticker = (run?.ticker ?? draft.input?.symbol ?? '').toUpperCase();
	if (!ticker) return { outcome: 'none', reason: 'the run has no ticker' };
	const listing = steps?.stocktwits as { title?: string | null } | undefined;
	const row = await insertJoke({
		conversationId,
		ticker,
		title: listing?.title ?? draft.input?.company ?? null,
		joke: draft.joke,
		facts: draft.facts ?? [],
		payments,
		totalAuthorizedUsdc: total,
		orchestratorModel: config.orchestratorModel,
		jokeModel: draft.model,
		paidBy: run?.paidBy ?? null,
		steps,
	});
	return { outcome: 'inserted', jokeId: row.id, ticker: row.ticker };
}
