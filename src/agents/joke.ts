'use agent';
import { useAgentFinish, useAgentStart, useModel, useResponseFinish, useResponseStart, useTool } from '@flue/runtime';
import { X402_PROVIDER_ID } from '../lib/ai-gateway-provider.ts';
import { accessFor, completeJoke, insertJoke } from '../lib/db.ts';
import { handoff } from '../lib/drafts.ts';
import { config } from '../lib/env.ts';
import { ledger } from '../lib/ledger.ts';
import { conversationScope, logEvent } from '../lib/log.ts';
import { whereAmI } from '../cloudflare.ts';
import { searchStockNews } from '../tools/ceramic.ts';
import { writeJoke } from '../tools/joke.ts';
import { fetchStocktwitsSignals } from '../tools/stocktwits.ts';

// Joke is the agent's durable identity: it names the generated Durable Object
// class (FlueJokeAgent) and the migration entry in wrangler.jsonc.
export function Joke({ id }: { id: string }) {
	// Every turn of this model is itself paid with x402 through AI Gateway
	// machine payments (see src/lib/ai-gateway-provider.ts, registered in app.ts).
	useModel(`${X402_PROVIDER_ID}/${config.orchestratorModel}`);

	useTool(fetchStocktwitsSignals(id));
	useTool(searchStockNews(id));
	useTool(writeJoke(id));

	// Attach every payment made during this response to the reply's metadata,
	// and store the finished joke in D1 for the feed and the cache.
	useAgentStart(async () => {
		handoff.setMark(id, ledger.mark());
		conversationScope.set(id);
		const where = await whereAmI();
		logEvent('gate', where.loc === 'US', { probe: 'agent', agentColo: where.colo, agentCountry: where.loc }, { conversationId: id, label: 'agent colo' });
	});
	useResponseStart(() => ({ ledgerMark: ledger.mark() }));
	useResponseFinish(({ metadata }) => {
		const mark = typeof (metadata as { ledgerMark?: unknown })?.ledgerMark === 'number' ? (metadata as { ledgerMark: number }).ledgerMark : 0;
		const payments = ledger.since(mark);
		const authorized = payments.reduce((sum, p) => sum + Number(p.authorizedUsdc), 0);
		return { payments, totalAuthorizedUsdc: authorized.toFixed(6) };
	});
	useAgentFinish(async ({ log, response }) => {
		const failedTools = response.toolCalls.filter((t) => t.isError).map((t) => t.tool);
		if (failedTools.length) logEvent('error', false, { where: 'agent-finish', failedTools, toolCalls: response.toolCalls.length }, { conversationId: id, label: 'tool failures' });
		const draft = handoff.takeDraft(id);
		if (!draft) {
			logEvent('agent.done', false, { reason: failedTools.length ? `tool failures: ${failedTools.join(', ')}` : 'finished without a joke' }, { conversationId: id, label: 'agent done' });
			return;
		}
		const payments = ledger.since(handoff.takeMark(id));
		const total = payments.reduce((sum, p) => sum + Number(p.authorizedUsdc), 0).toFixed(6);
		try {
			// write_joke already stored the row; add the closing turn's payments and the full step archive.
			if (await completeJoke(id, { payments, totalAuthorizedUsdc: total, steps: handoff.takeSteps(id) })) {
				log.info(`completed joke for ${draft.symbol} (${payments.length} payments, ${total} USDC authorized)`);
				logEvent('agent.done', true, { ticker: draft.symbol, payments: payments.length }, { conversationId: id, label: 'agent done' });
				return;
			}
			const row = await insertJoke({
				conversationId: id,
				ticker: draft.symbol,
				title: handoff.title(draft.symbol),
				joke: draft.joke,
				facts: draft.facts,
				payments,
				totalAuthorizedUsdc: total,
				orchestratorModel: config.orchestratorModel,
				jokeModel: draft.model,
				paidBy: (await accessFor(id).catch(() => null))?.paidBy ?? null,
				steps: handoff.takeSteps(id),
			});
			log.info(`stored joke ${row.id} for ${row.ticker} (${payments.length} payments, ${total} USDC authorized)`);
			logEvent('agent.done', true, { jokeId: row.id, ticker: row.ticker, payments: payments.length }, { conversationId: id, label: 'agent done' });
		} catch (err) {
			log.error(`failed to store joke: ${(err as Error).message}`);
		}
	});

	return [
		'You are Joke, a tool-driven agent. You do NOT write jokes yourself: the only joke you may ever output is the exact text returned by the write_joke tool.',
		'Every data point you mention must come from a tool result, and every tool call is a USDC micro-payment (x402) that the user is happy to make.',
		'',
		'Whatever uppercase symbol the user gives IS the ticker: never ask which company they mean or for confirmation; just run the steps with it.',
		'When the user names a ticker, run these three steps in order, every time:',
		'1. fetch_stocktwits_signals with the ticker. Note the title, latestPrice and quotes.',
		'2. search_stock_news with the ticker and that title. It returns company news items, newest first, each with a date, title and source.',
		'3. write_joke immediately, without deliberating: news = the first 2 or 3 items as "<date>: <title>" (trim the title to the event itself, drop site names and tickers from it); chatter = one quote from step 1 only if it is obviously funny, otherwise none; price = latestPrice. Skip an item only if it is a buying recommendation or a listicle.',
		'Never pass or mention watchlist counts, bullish or bearish tallies, sentiment or volume changes: they do not make jokes. If step 2 finds no usable news, pass the chatter and price alone.',
		'Do not reply to the user until write_joke has returned a joke. Writing a joke without calling write_joke is a failure.',
		'',
		'Then reply in exactly this shape and nothing else:',
		'<the joke text from write_joke, verbatim>',
		'Based on: <2 or 3 of the news items you passed to write_joke, each with its source>',
		'Paid: <each payment from the tool results as "<label> <amount> USDC <basescan link if present>", then the total>',
		'',
		'If the user gives no ticker, ask for one. If a tool fails, say which step failed and why, and stop; never call the same tool more than twice in one reply; do not invent data. Never give financial advice.',
		'If fetch_stocktwits_signals says the symbol was not found, the ticker does not exist: do not retry and do not try other tools; reply that the ticker is unknown and stop.',
	].join('\n');
}
