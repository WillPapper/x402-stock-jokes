/**
 * The current run: POSTs the ticker, polls GET /joke/<id> until the run
 * settles, and paints the steps card (RunCard.astro). Status comes from D1 via
 * the Worker, never from the agent's Durable Object (reads there would lend the
 * reader's location to the payments). The form, the result card, the paywall
 * and the feed hear about the run through bus.ts.
 */
import { emit, on } from './bus.ts';
import { $, cleanFact, normTicker, params, plural, RUN_ID, runLinks, show } from './dom.ts';
import { fillHood, toggleHood } from './hood.ts';
import { isTurn, receiptChip, turnsChip } from './receipts.ts';
import { mmss } from './time.ts';
import type { HoodKey, Joke, Payment, RunStatus, StepName, ToolName } from './types.ts';

const run = $('#run'), bar = $('#bar'), stepsEl = $('#steps'), runnote = $('#runnote'), live = $('#live');
const summaryText = $('#summary-text'), summaryToggle = $<HTMLButtonElement>('#summary-toggle');
const dots = Object.fromEntries([...stepsEl.querySelectorAll<HTMLElement>('.dot')].map((d) => [d.dataset.step, d])) as Record<StepName, HTMLElement>;
const detailEl = (name: StepName) => dots[name].parentElement!.querySelector<HTMLElement>('.step-detail')!;
const receiptEl = (name: StepName) => dots[name].parentElement!.querySelector<HTMLElement>('.receipt')!;

const TOOLS: readonly ToolName[] = ['fetch_stocktwits_signals', 'search_stock_news', 'write_joke'];
const STEP_KEY: Record<ToolName | 'finished', HoodKey> = { fetch_stocktwits_signals: 'stocktwits', search_stock_news: 'ceramic', write_joke: 'joke', finished: 'turns' };
const STEP_LABEL: Record<ToolName, string> = { fetch_stocktwits_signals: '1 (StockTwits)', search_stock_news: '2 (Ceramic news)', write_joke: '3 (AI Gateway joke)' };
const isTool = (s: string | null | undefined): s is ToolName => (TOOLS as readonly string[]).includes(s ?? '');

type DotState = '' | 'running' | 'done' | 'error' | 'info' | 'skipped';
const STATE_WORD: Record<string, string> = { done: 'done', error: 'failed', running: 'in progress', info: 'not started', skipped: 'skipped' };
const STATE_MARK: Record<string, string> = { done: '✓', error: '!', info: '$', skipped: '–' };

function setStep(name: StepName, state: DotState, detail?: string, receiptHtml?: string): void {
	const dot = dots[name];
	const prev = dot.dataset.state || '';
	dot.dataset.state = state;
	if (state !== prev && (state === 'done' || state === 'error')) live.textContent = `${dot.parentElement!.querySelector('.step-title, .steptitle')!.textContent}: ${state === 'done' ? 'done' : 'failed'}${detail ? '. ' + detail : ''}`;
	dot.className = 'dot ' + state;
	dot.innerHTML = (STATE_MARK[state] || '') + `<span class="sr-only"> ${STATE_WORD[state] || 'pending'}</span>`;
	if (detail !== undefined) detailEl(name).textContent = detail;
	if (receiptHtml !== undefined) receiptEl(name).innerHTML = receiptHtml;
}

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let timer: ReturnType<typeof setInterval> | null = null, clock: ReturnType<typeof setInterval> | null = null;
let runOutputs: Partial<Record<ToolName, Loose>> = {}, runPayments: Payment[] = [];
let runId: string | null = null, runStarted = 0, runSym = '', runResumed = false;
const turnsSoFar = () => runPayments.filter((p) => isTurn(p) && p.ok);

const setRunParam = (id: string | null) => { try { history.replaceState(null, '', id ? `?run=${encodeURIComponent(id)}` : location.pathname); } catch {} };
function setRunNote(html: string, isError?: boolean): void { runnote.innerHTML = html || ''; runnote.classList.toggle('hidden', !html); runnote.classList.toggle('err', !!isError); }
const finishUi = () => { emit('run:busy', { busy: false }); if (clock) clearInterval(clock); };
function workingLine(turns: number): string {
	const elapsed = runStarted ? mmss(Date.now() - runStarted) : '0:00';
	return `Working… ${elapsed} · usually 1–2 min${turns ? ` · ${plural(turns, 'paid model turn')} so far` : ''}`;
}

function reset(): void {
	runOutputs = {}; runPayments = [];
	stepsEl.querySelectorAll('.hood').forEach((h) => h.remove());
	stepsEl.querySelectorAll('.steptitle').forEach((b) => b.setAttribute('aria-expanded', 'false'));
	for (const k of Object.keys(dots) as StepName[]) setStep(k, '', '', '');
	setStep('started', 'running', 'Sending your request…');
	setStep('finished', '', 'Each model turn is its own x402 payment to AI Gateway.', '');
	run.classList.remove('collapsed', 'done');
	summaryToggle.setAttribute('aria-expanded', 'false'); summaryToggle.textContent = 'Show details';
	show(run, true); show(bar, true);
	setRunNote(''); setRunParam(null);
	emit('run:reset');
}

/** Paint one status poll; true once the run has settled. */
function render(st: RunStatus): boolean {
	const states: Partial<Record<ToolName, string>> = {};
	for (const name of TOOLS) {
		const sdef = st.steps[name]; if (!sdef) continue;
		states[name] = sdef.state;
		if (sdef.state === 'done') {
			const out: Loose = sdef.output || {}; runOutputs[name] = out;
			const pay = (out.payments || [])[0] as Payment | undefined;
			let d = '';
			if (name === 'fetch_stocktwits_signals') { const s = out.stats || out; d = `${out.title || out.symbol}: last ${out.latestPrice ? '$' + out.latestPrice : 'n/a'}, ${out.mood ? out.mood : `${s.bullish} bullish / ${s.bearish} bearish of ${s.messagesSampled} posts`}`; }
			else if (name === 'search_stock_news') d = ((out.results || []) as Loose[]).slice(0, 2).map((r) => r.title).join(' · ');
			else if (name === 'write_joke') d = `${out.model}`;
			setStep(name, 'done', d, receiptChip(pay));
		} else if (sdef.state === 'error') setStep(name, 'error', (sdef.detail || 'failed').slice(0, 200), '');
		else if (sdef.state === 'running') setStep(name, 'running', 'Paying and fetching…', '');
	}
	runPayments = st.payments || [];
	const turns = turnsSoFar();
	if (!st.done) {
		const next = TOOLS.find((n) => states[n] !== 'done');
		for (const n of TOOLS) {
			if (states[n] && states[n] !== 'pending') continue;
			if (n === next) setStep(n, 'running', `The agent is reading the data and deciding its next step${turns.length ? ` (model turn ${turns.length})` : ''}…`, '');
			else setStep(n, '', 'Not started.', '');
		}
		setStep('finished', 'running', workingLine(turns.length), turnsChip(turns));
		return false;
	}
	for (const n of TOOLS) if (!states[n] || states[n] === 'pending') setStep(n, 'skipped', 'Skipped: the run stopped before this step.', '');
	const failed = st.outcome !== 'completed' ? (st.error || st.outcome) : null;
	// A resumed run finished at its last event, not when this page noticed.
	const endedAt = runResumed && st.lastEventAt ? Date.parse(st.lastEventAt) : Date.now();
	const took = runStarted && endedAt > runStarted ? mmss(endedAt - runStarted) : null;
	setStep('finished', failed ? 'skipped' : 'done', failed ? `Stopped after ${plural(turns.length, 'paid model turn')}${took ? ` (${took})` : ''}.` : `${turns.length} paid model turns${took ? ` · finished in ${took}` : ''}`, turnsChip(turns));
	show(bar, false);
	showResult(st, failed, turns.length, took);
	return true;
}

function friendlyFailure(err: string, sym: string): string {
	if (/symbol not found|does not list the ticker|unknown ticker/i.test(err)) return `StockTwits does not list the ticker ${sym}. Check the symbol and try again.`;
	if (/rate limited/i.test(err)) return 'StockTwits is rate limiting us right now. Try again in a minute.';
	if (/payment rejected|402/i.test(err)) return `A payment was rejected: ${err}`;
	return `The run stopped: ${err}`;
}

/** Collapse the process to one line now that the joke is the point, and hand the joke to the result card. */
function showResult(st: RunStatus, failed: string | null, turnCount: number, took: string | null): void {
	const sym = st.ticker || runSym;
	const doneSteps = TOOLS.filter((n) => dots[n].classList.contains('done')).length;
	const errStep = TOOLS.find((n) => dots[n].dataset.state === 'error');
	const failedAt = (isTool(st.failedStep) && STEP_LABEL[st.failedStep]) || (errStep && STEP_LABEL[errStep]);
	summaryText.textContent = failed ? `Stopped at ${failedAt ? `step ${failedAt}` : `step ${doneSteps + 1}`}${took ? ` after ${took}` : ''}.` : `${doneSteps} paid steps · ${turnCount} model turns${took ? ` · ${took}` : ''}`;
	run.classList.add('collapsed', 'done');
	emit('run:result', {
		id: st.id || runId || '',
		sym,
		title: runOutputs.fetch_stocktwits_signals?.title ? ' · ' + runOutputs.fetch_stocktwits_signals.title : '',
		when: runResumed && st.lastEventAt ? st.lastEventAt : new Date().toISOString(),
		joke: st.joke,
		based: st.facts?.length ? 'Based on: ' + st.facts.slice(0, 3).map(cleanFact).join(' · ') : (st.basedOn ? 'Based on: ' + st.basedOn : ''),
		failed: failed ? friendlyFailure(failed, sym) : null,
	});
}

summaryToggle.addEventListener('click', () => {
	const open = run.classList.toggle('collapsed') === false;
	summaryToggle.setAttribute('aria-expanded', String(open));
	summaryToggle.textContent = open ? 'Hide details' : 'Show details';
});
// Clicking the collapsed summary text also opens it.
summaryText.addEventListener('click', () => summaryToggle.click());

/** The settled cost arrives on the feed row a few seconds after the run: show it on the result and the turns row. */
async function showRunCost(sym: string): Promise<void> {
	try {
		const { joke } = (await (await fetch(`/api/jokes/latest?ticker=${encodeURIComponent(sym)}`)).json()) as { joke: Joke | null };
		if (!joke || !joke.paid || Date.now() - Date.parse(joke.createdAt) > 600000) return;
		emit('run:cost', { paid: joke.paid });
		receiptEl('finished').innerHTML = turnsChip(turnsSoFar(), joke.paid.aiUsdc);
		summaryText.textContent += ` · ${joke.paid.totalUsdc.toFixed(4)} USDC on-chain`;
	} catch {}
}

function showPaywall(cached: Joke | null | undefined, sym: string, pwError: string | null): void {
	show(run, false); show(bar, false);
	emit('run:paywall', { cached, sym, pwError });
}

async function submit(sym: string, pw: string): Promise<void> {
	if (timer) clearInterval(timer); if (clock) clearInterval(clock);
	reset(); emit('run:busy', { busy: true });
	// The server names the run (j-<ticker>-<time>-<rand>, see src/lib/ids.ts) so page and API runs share one shape.
	let id: string | null = null; runId = null; runSym = sym; runStarted = 0;
	const headers: Record<string, string> = {};
	if (pw) headers['x-joke-password'] = pw;
	const latest = async (): Promise<Joke | null> => { try { return ((await (await fetch(`/api/jokes/latest?ticker=${encodeURIComponent(sym)}`)).json()) as { joke: Joke | null }).joke; } catch { return null; } };
	try {
		const res = await fetch(`/joke/${encodeURIComponent(sym)}`, { method: 'POST', headers });
		if (res.status === 402 || res.status === 401) {
			let body: { cached?: Joke | null } = {}; try { body = await res.json(); } catch {}
			if (res.status === 401) emit('run:bad-coupon');
			showPaywall(body.cached ?? (await latest()), sym, res.status === 401 ? 'That coupon code is not valid. Check it and try again, or let your agent pay (see below).' : null);
			finishUi(); return;
		}
		if (res.status === 400) {
			let body: { error?: string; message?: string } = {}; try { body = await res.json(); } catch {}
			if (body.error === 'unknown_ticker' || body.error === 'bad_ticker') {
				// Bounced before the agent started: nothing was paid, so no run card.
				show(run, false);
				emit('run:bad-ticker', { message: body.message || `StockTwits does not list the ticker ${sym}.` });
				finishUi(); return;
			}
			throw new Error(`POST 400: ${body.message || body.error || 'bad request'}`);
		}
		if (!res.ok) throw new Error(`POST ${res.status}: ${(await res.text()).slice(0, 200)}`);
		id = ((await res.json()) as { id?: string }).id ?? null; runId = id;
		if (!id) throw new Error('the server did not return a run id');
	} catch (err) { setStep('started', 'error', String((err as Error).message || err)); show(bar, false); finishUi(); return; }
	emit('run:accepted', { pw });
	watchRun(id, sym, pw ? 'Accepted with coupon code.' : 'Accepted.');
}
on('run:submit', ({ sym, pw }) => submit(sym, pw));
on('form:clear', () => setRunParam(null));

// Poll /joke/<id> until the run settles. The id goes into the URL so a reload
// (or a "watch live" link from the permalink page) resumes watching instead of
// losing a run that is still spending. Polling slows after 5 minutes and stops
// after 15, with a note either way; the server itself gives up at 10 idle minutes.
const SLOW_AFTER_MS = 300000, STOP_AFTER_MS = 900000;
function watchRun(id: string, sym: string, startedDetail: string, resumed = false): void {
	runId = id; runSym = sym; runResumed = resumed; runStarted = resumed ? 0 : Date.now();
	setRunParam(id);
	setStep('started', 'done', startedDetail);
	setStep('fetch_stocktwits_signals', 'running', 'The agent is reading the data and deciding its next step…');
	setStep('search_stock_news', '', 'Not started.'); setStep('write_joke', '', 'Not started.');
	setStep('finished', 'running', workingLine(0));
	clock = setInterval(() => { if (dots.finished.classList.contains('running')) detailEl('finished').textContent = workingLine(turnsSoFar().length); }, 1000);
	const links = `<a href="/joke/${encodeURIComponent(id)}" target="_blank" rel="noopener">run status (JSON)</a> · <a href="/j/${encodeURIComponent(id)}" target="_blank" rel="noopener">permalink</a>`;
	let polls = 0, failures = 0, slow = false;
	const stop = () => { if (timer) clearInterval(timer); timer = null; finishUi(); };
	const poll = async () => {
		let st: RunStatus;
		try { st = (await (await fetch(`/joke/${encodeURIComponent(id)}`)).json()) as RunStatus; }
		catch { if (++failures >= 3) setRunNote('Cannot reach the server right now. Retrying…', true); return; }
		failures = 0; polls++;
		if (!runStarted) runStarted = st.startedAt ? Date.parse(st.startedAt) : Date.now();
		if (resumed && st.outcome === 'unknown' && polls >= 3) { stop(); show(bar, false); setStep('started', 'error', 'No run with this id was found.'); setRunNote(`Nothing has been recorded for this run id. ${links}`, true); setRunParam(null); return; }
		const finished = render(st);
		refreshStepHood();
		if (finished) { stop(); setRunNote(''); emit('run:finished'); setTimeout(() => showRunCost(sym), 4000); return; }
		const age = Date.now() - runStarted;
		if (age > STOP_AFTER_MS) { stop(); show(bar, false); setRunNote(`This page stopped checking after 15 minutes. The run may still finish; reload to check, or open the ${links}.`, true); return; }
		if (age > SLOW_AFTER_MS) {
			if (!slow) { slow = true; if (timer) clearInterval(timer); timer = setInterval(poll, 5000); }
			setRunNote(`Still working after 5 minutes, which is unusual. The server gives up after 10 minutes without progress. ${links}`);
		} else setRunNote('');
	};
	timer = setInterval(poll, 1500);
	poll();
}

function stepHoodData(name: ToolName | 'finished', key: HoodKey): { data: unknown; links: string } {
	let data: unknown = key === 'turns' ? runPayments.filter(isTurn) : runOutputs[name as ToolName];
	if (!data || (Array.isArray(data) && !data.length)) {
		const state = dots[name]?.dataset.state || '';
		data = { note: key === 'turns' ? (state === 'running' ? 'No model turn has settled yet. This list fills in as the agent works.' : 'Model turns are tallied when the agent finishes.')
			: state === 'running' ? 'This step is running. Its result appears here as soon as it returns.' : state === 'error' ? `This step failed: ${detailEl(name).textContent}` : state === 'skipped' ? 'The run stopped before this step.' : 'This step has not started yet.' };
	}
	return { data, links: runId ? runLinks(runId) : '' };
}

/** Called after every status poll: an open step panel follows the run live. */
function refreshStepHood(): void {
	const panel = stepsEl.querySelector<HTMLElement>('.hood'); if (!panel) return;
	const key = panel.dataset.k as HoodKey;
	const name = (Object.keys(STEP_KEY) as (ToolName | 'finished')[]).find((n) => STEP_KEY[n] === key); if (!name) return;
	const { data, links } = stepHoodData(name, key);
	fillHood(panel, key, data, links);
}

// Each paid step row opens its own panel (the title button, or anywhere on the row).
stepsEl.querySelectorAll<HTMLLIElement>(':scope > li').forEach((li) => {
	const name = li.querySelector<HTMLElement>('.dot')!.dataset.step as StepName;
	if (name === 'started') return;
	const key = STEP_KEY[name];
	const btn = li.querySelector<HTMLButtonElement>('.steptitle')!;
	btn.classList.add('clickable'); btn.title = 'See what this step returned';
	const open = () => { const { data, links } = stepHoodData(name, key); toggleHood(stepsEl, key, data, links, btn, li); };
	btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
	li.addEventListener('click', (e) => { if ((e.target as Element).closest('a, button, .hood')) return; open(); });
});

// ?run=<id> resumes watching a run. The other components' listeners must be in
// place first (run:reset, run:busy), so this waits for the document to be ready.
const runParam = params.get('run');
if (runParam && RUN_ID.test(runParam)) {
	const resume = () => { reset(); emit('run:busy', { busy: true }); watchRun(runParam, normTicker(runParam.split('-')[1] || ''), 'Resumed watching this run.', true); };
	if (document.readyState === 'complete') queueMicrotask(resume);
	else document.addEventListener('DOMContentLoaded', resume, { once: true });
}
