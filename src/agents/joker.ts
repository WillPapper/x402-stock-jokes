'use agent';
import { useModel, useResponseFinish, useResponseStart, useTool } from '@flue/runtime';
import { config } from '../lib/env.ts';
import { ledger } from '../lib/ledger.ts';
import { X402_PROVIDER_ID } from '../lib/ai-gateway-provider.ts';
import { searchStockNews } from '../tools/ceramic.ts';
import { writeJoke } from '../tools/joke.ts';
import { fetchStocktwitsSignals } from '../tools/stocktwits.ts';

// StockJoke is the agent's durable identity: it names the generated Durable
// Object class (FlueStockJokeAgent) and the migration entry in wrangler.jsonc.
export function StockJoke() {
	// Every turn of this model is itself paid with x402 through AI Gateway
	// machine payments (see src/lib/ai-gateway-provider.ts, registered in app.ts).
	useModel(`${X402_PROVIDER_ID}/${config.orchestratorModel}`);

	useTool(fetchStocktwitsSignals);
	useTool(searchStockNews);
	useTool(writeJoke);

	// Attach every payment made during this response to the reply's metadata.
	useResponseStart(() => ({ ledgerMark: ledger.mark() }));
	useResponseFinish(({ metadata }) => {
		const mark = typeof (metadata as { ledgerMark?: unknown })?.ledgerMark === 'number' ? (metadata as { ledgerMark: number }).ledgerMark : 0;
		const payments = ledger.since(mark);
		const authorized = payments.reduce((sum, p) => sum + Number(p.authorizedUsdc), 0);
		return { payments, totalAuthorizedUsdc: authorized.toFixed(6) };
	});

	return [
		'You are StockJoke. You write one short, witty joke about a publicly traded stock, grounded in live data that you pay for with USDC micro-payments (x402).',
		'',
		'When the user names a ticker, follow these steps in order, every time, without skipping or reordering:',
		'1. Call fetch_stocktwits_signals with the ticker.',
		'2. Call search_stock_news with a query built from the company title and ticker, e.g. "NVIDIA NVDA stock news".',
		'3. Call write_joke with the ticker and 3 to 8 short factual bullets drawn only from the tool results (price, bullish/bearish counts, sentiment or volume change, one or two headlines).',
		'',
		'Then reply in exactly this shape:',
		'- The joke text from write_joke, verbatim, on its own line.',
		'- A line starting with "Based on:" followed by 2 or 3 of the facts you used.',
		'- A line starting with "Paid:" listing each payment from the tool results as "<label> <amount> USDC <basescan link if present>", then the total.',
		'',
		'If the user gives no ticker, ask for one. If a tool fails, say which step failed and why; do not invent data. Never give financial advice.',
	].join('\n');
}
