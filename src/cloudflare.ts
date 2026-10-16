// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
// JokeRunner is an application-owned Durable Object in the `us` jurisdiction.
// It is the only thing that starts a Joke conversation, so the agent's own
// Durable Object is placed next to it, in the US, and every paid call the
// agent makes to AI Gateway leaves from a US colo. Without this, the agent runs
// wherever the submitter's request landed, and AI Gateway machine payments
// (US-only) answer 403 "disallowed visitor country" for submitters whose
// traffic reaches a non-US datacenter. See docs/ai-gateway-visitor-country.md.
import { dispatch } from '@flue/runtime';
import { DurableObject } from 'cloudflare:workers';
import { Joke } from './agents/joke.ts';
import { logEvent } from './lib/log.ts';

export interface SubmitRequest {
	id: string;
	body: string;
	by: 'password' | 'x402';
}

export class JokeRunner extends DurableObject {
	async submit(req: SubmitRequest): Promise<{ submissionId: string; runnerColo: string | null; runnerCountry: string | null }> {
		if (this.ctx.id.jurisdiction !== 'us') throw new Error(`JokeRunner must live in the us jurisdiction, got ${this.ctx.id.jurisdiction ?? 'none'}`);
		const where = await whereAmI();
		const receipt = await dispatch(Joke, { id: req.id, message: { kind: 'user', body: req.body } });
		logEvent('gate', true, { probe: 'runner', jurisdiction: this.ctx.id.jurisdiction, runnerColo: where.colo, runnerCountry: where.loc, by: req.by, submissionId: receipt.submissionId }, { conversationId: req.id, label: 'runner dispatch' });
		return { submissionId: receipt.submissionId, runnerColo: where.colo, runnerCountry: where.loc };
	}
}

/** Which Cloudflare colo and country this isolate's outbound requests appear to come from. */
export async function whereAmI(): Promise<{ colo: string | null; loc: string | null; ip: string | null }> {
	try {
		const t = Object.fromEntries((await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text()).trim().split('\n').map((l) => l.split('=') as [string, string]));
		return { colo: t.colo ?? null, loc: t.loc ?? null, ip: t.ip ?? null };
	} catch {
		return { colo: null, loc: null, ip: null };
	}
}
