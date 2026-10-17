// Runs Ceramic query variants for one company and prints how fresh each
// variant's results are, so query changes in src/lib/news.ts can be tested
// against the real index before they ship. Each query costs 0.001 USDC.
// Usage: bun scripts/ceramic-probe.ts "Tesla" TSLA ['query one' 'query two' ...]
import { Budget, usdToBaseUnits } from '../src/lib/budget.ts';
import { buildNewsQueries, detectDate, rankNews, type RawNews } from '../src/lib/news.ts';
import { createPaidFetch } from '../src/lib/x402.ts';
import { loadDevVars, privateKey } from './_env.ts';

loadDevVars();
const company = process.argv[2] ?? 'Tesla';
const symbol = (process.argv[3] ?? 'TSLA').toUpperCase();
const queries = process.argv.length > 4 ? process.argv.slice(4) : buildNewsQueries(company, symbol);
const paid = createPaidFetch({ privateKey: privateKey(), budget: new Budget(usdToBaseUnits('0.01'), usdToBaseUnits('0.05')), maxUsdPerPayment: '$0.01' });
const now = new Date();

const all: RawNews[] = [];
for (const query of queries) {
	const res = await paid('https://api.ceramic.ai/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, maxResults: 20, maxDescriptionLength: 1000 }) });
	if (!res.ok) {
		console.log(`✗ "${query}": HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
		continue;
	}
	const body = (await res.json()) as { result?: { results?: RawNews[] }; results?: RawNews[] };
	const results = body.result?.results ?? body.results ?? [];
	all.push(...results);
	const dates = results.map((r) => detectDate(r.url ?? '', `${r.title ?? ''} ${r.description ?? ''}`, now, r.title ?? '')).filter((d): d is string => d !== null && d.length === 10).sort();
	const kept = rankNews(results, { company, symbol, now, limit: 6 });
	console.log(`\n"${query}": ${results.length} results, ${dates.length} fully dated, newest ${dates.at(-1) ?? '-'}, median ${dates[Math.floor(dates.length / 2)] ?? '-'}, kept ${kept.items.length}`);
	for (const r of kept.items) console.log(`   ${r.date ?? 'undated'} | ${r.title.slice(0, 90)} | ${r.source}`);
}
const merged = rankNews(all, { company, symbol, now, limit: 6 });
console.log(`\nMERGED (${all.length} raw): newest ${merged.newest ?? '-'}, dropped ${JSON.stringify(merged.dropped)}`);
for (const r of merged.items) console.log(`   ${r.date ?? 'undated'} | ${r.title.slice(0, 90)} | ${r.source}`);
