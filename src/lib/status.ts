/**
 * The public status of a run (GET /joke/<id>): the `runs` row, the joke row if
 * one exists, and the run's payments, folded into the shape the page polls.
 * Pure (no Worker bindings) so it can be unit-tested; `runStatus` in
 * src/lib/runs.ts loads the rows and calls `statusOf`.
 */
import type { JokeRow } from './db.ts';
import type { PaymentRecord } from './ledger.ts';
import type { RunRow, StepState, ToolName, StepKey } from './runs.ts';

const TOOL_ORDER: readonly ToolName[] = ['fetch_stocktwits_signals', 'search_stock_news', 'write_joke'];
const STEP_KEY: Record<ToolName, StepKey> = { fetch_stocktwits_signals: 'stocktwits', search_stock_news: 'ceramic', write_joke: 'joke' };

/** A queued or running row nobody has touched for this long is reported as failed. */
export const STALE_AFTER_MS = 20 * 60_000;

export interface StepStatus {
	state: StepState | 'pending';
	detail?: string;
	receipts?: unknown;
	output?: unknown;
}

export interface RunStatus {
	id: string;
	done: boolean;
	outcome: 'working' | 'completed' | 'failed' | 'unknown';
	error: string | null;
	/** A model turn or tool failed and the runtime is retrying it; the run is still working. */
	retrying: boolean;
	lastError: string | null;
	failedStep: string | null;
	joke: string | null;
	basedOn: string | null;
	facts: string[] | null;
	ticker: string | null;
	steps: Record<string, StepStatus>;
	payments: { label: string; authorizedUsdc: string | null; scheme: string | null; tx: string | null; ok: boolean; at: string }[];
	turns: number;
	lastEventAt: string | null;
	startedAt: string | null;
	jokeId: string | null;
	note?: string;
}

export function statusOf(id: string, run: RunRow | null, joke: JokeRow | null, payments: PaymentRecord[], now = Date.now()): RunStatus {
	const steps: Record<string, StepStatus> = {};
	for (const t of TOOL_ORDER) {
		const s = run?.stepStates[t];
		const output = run?.steps?.[STEP_KEY[t]];
		if (!s) steps[t] = { state: joke && !run ? 'done' : 'pending' };
		else if (s.state === 'done') steps[t] = { state: 'done', output, receipts: (output as { payments?: unknown } | undefined)?.payments };
		else if (s.state === 'error') steps[t] = { state: 'error', detail: s.error ?? 'failed' };
		else steps[t] = { state: 'running' };
	}

	let done = false;
	let outcome: RunStatus['outcome'] = 'unknown';
	let error: string | null = null;
	if (run?.state === 'done' || (!run && joke)) {
		done = true;
		outcome = 'completed';
	} else if (run?.state === 'failed') {
		done = true;
		outcome = 'failed';
		error = run.error ?? run.lastError ?? 'the agent finished without a joke';
	} else if (run) {
		const idleMs = now - Date.parse(run.updatedAt);
		if (idleMs > STALE_AFTER_MS) {
			done = true;
			outcome = 'failed';
			error = run.lastError ?? (run.state === 'queued' ? 'the run never started' : 'no progress for 20 minutes');
		} else {
			outcome = 'working';
		}
	}
	// A completed run whose joke row is missing (it never should be) still reports completed, without the text.
	if (outcome === 'completed' && !joke && run?.steps?.joke) {
		const j = run.steps.joke as { joke?: string; facts?: string[] };
		joke = joke ?? null;
		return finish({ joke: j.joke ?? null, facts: j.facts ?? null, jokeId: null });
	}
	return finish({ joke: joke?.joke ?? null, facts: joke?.facts ?? null, jokeId: joke?.id ?? null });

	function finish(j: { joke: string | null; facts: string[] | null; jokeId: string | null }): RunStatus {
		return {
			id,
			done,
			outcome,
			error,
			retrying: !done && run?.lastError != null,
			lastError: !done ? (run?.lastError ?? null) : null,
			failedStep: done && outcome === 'failed' ? (run?.failedStep ?? null) : null,
			joke: j.joke,
			basedOn: j.facts ? j.facts.slice(0, 3).join('; ') : null,
			facts: j.facts,
			ticker: joke?.ticker ?? run?.ticker ?? null,
			steps,
			payments: payments.map((p) => ({ label: p.label, authorizedUsdc: p.authorizedUsdc, scheme: p.scheme, tx: p.tx, ok: p.ok, at: p.at })),
			turns: run?.turns ?? 0,
			lastEventAt: run?.updatedAt ?? joke?.createdAt ?? null,
			startedAt: run?.createdAt ?? joke?.createdAt ?? null,
			jokeId: j.jokeId,
		};
	}
}
