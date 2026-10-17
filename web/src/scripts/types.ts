/** The JSON shapes the page reads from the Worker (src/routes/public.ts, src/lib/status.ts). */

export interface Payment {
	at: string;
	label: string;
	authorizedUsdc: string | null;
	scheme: string | null;
	tx: string | null;
	ok: boolean;
}

/** What a joke cost on-chain once settled (src/lib/settlement.ts). */
export interface Paid {
	exactUsdc: number;
	exactCount: number;
	aiUsdc: number;
	aiCount: number;
	totalUsdc: number;
}

export interface Buyer {
	usdc: number;
	from: string;
	tx: string | null;
	at: string;
}

/** A row of the feed (`/api/jokes`) or the per-ticker cache (`/api/jokes/latest`). */
export interface Joke {
	id: string;
	conversationId?: string;
	ticker: string;
	title?: string | null;
	joke: string;
	facts?: string[];
	payments?: Payment[];
	paidBy?: 'password' | 'x402' | null;
	/** Full tool outputs keyed stocktwits / ceramic / joke; null for jokes made before the archive existed. */
	steps?: Record<string, unknown> | null;
	paid?: Paid | null;
	buyer?: Buyer | null;
	createdAt: string;
}

export type ToolName = 'fetch_stocktwits_signals' | 'search_stock_news' | 'write_joke';
export type StepName = 'started' | ToolName | 'finished';
/** The key a tool's output is archived under, and the panel that shows it. */
export type HoodKey = 'stocktwits' | 'ceramic' | 'joke' | 'turns';

export interface StepStatus {
	state: 'pending' | 'running' | 'done' | 'error';
	detail?: string;
	output?: Record<string, unknown>;
}

/** `GET /joke/<id>`. */
export interface RunStatus {
	id: string;
	done: boolean;
	outcome: 'working' | 'completed' | 'failed' | 'unknown';
	error: string | null;
	failedStep: string | null;
	joke: string | null;
	basedOn: string | null;
	facts: string[] | null;
	ticker: string | null;
	steps: Record<string, StepStatus>;
	payments: Payment[];
	turns: number;
	lastEventAt: string | null;
	startedAt: string | null;
}

export interface Stats {
	count: number;
	tickers: number;
	perHour: { hour: string; count: number }[];
	earnedFromJokesUsdc: string;
	paidJokes: number;
	chain: { paidUsdc: number; paidCount: number; paidBySeller: Record<string, number>; earnedUsdc: number } | null;
}
