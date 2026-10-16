// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
// JokeRunner is an application-owned Durable Object in the `us` jurisdiction
// that starts every Joke conversation FROM ITS ALARM HANDLER. Two things
// matter here, both measured (see docs/ai-gateway-visitor-country.md):
//
//   1. Cloudflare carries the original visitor's identity (country) down the
//      whole synchronous request chain: Worker → this DO → the agent's DO, no
//      matter where those objects run. Monetization Gateway and AI Gateway
//      machine payments are US-only and read that identity, so a non-US
//      visitor made every paid call fail with 403 "disallowed visitor country"
//      even from a US-pinned object.
//   2. An alarm has no originating request, so work started from it carries
//      no visitor identity and is attributed to this object's own location,
//      which the `us` jurisdiction guarantees is in the US.
//
// So `submit()` only queues the message and sets an alarm; `alarm()` dispatches.
import { dispatch } from '@flue/runtime';
import { DurableObject } from 'cloudflare:workers';
import { Joke } from './agents/joke.ts';
import { logEvent } from './lib/log.ts';

export interface SubmitRequest {
	id: string;
	body: string;
	by: 'password' | 'x402';
}

interface Pending extends SubmitRequest {
	queuedAt: number;
	attempts: number;
}

const MAX_ATTEMPTS = 3;

export class JokeRunner extends DurableObject {
	async submit(req: SubmitRequest): Promise<{ queued: true; jurisdiction: string | undefined }> {
		if (this.ctx.id.jurisdiction !== 'us') throw new Error(`JokeRunner must live in the us jurisdiction, got ${this.ctx.id.jurisdiction ?? 'none'}`);
		await this.ctx.storage.put<Pending>(`pending:${req.id}`, { ...req, queuedAt: Date.now(), attempts: 0 });
		// Detach from the visitor's request chain: the alarm runs with no visitor
		// identity. Give the entry request a few seconds to fully finish first, so
		// the alarm never overlaps an invocation that still carries the visitor.
		const current = await this.ctx.storage.getAlarm();
		if (current === null) await this.ctx.storage.setAlarm(Date.now() + 3000);
		logEvent('gate', true, { probe: 'runner-queued', jurisdiction: this.ctx.id.jurisdiction, by: req.by }, { conversationId: req.id, label: 'runner queued' });
		return { queued: true, jurisdiction: this.ctx.id.jurisdiction };
	}

	async alarm(): Promise<void> {
		const where = await whereAmI();
		const pending = await this.ctx.storage.list<Pending>({ prefix: 'pending:' });
		for (const [key, req] of pending) {
			try {
				const receipt = await dispatch(Joke, { id: req.id, message: { kind: 'user', body: req.body } });
				await this.ctx.storage.delete(key);
				logEvent('gate', true, { probe: 'runner', from: 'alarm', jurisdiction: this.ctx.id.jurisdiction, runnerColo: where.colo, runnerCountry: where.loc, by: req.by, submissionId: receipt.submissionId, queuedMs: Date.now() - req.queuedAt }, { conversationId: req.id, label: 'runner dispatch' });
			} catch (err) {
				const attempts = req.attempts + 1;
				logEvent('error', false, { where: 'runner-alarm', attempts, error: (err as Error).message.slice(0, 300) }, { conversationId: req.id, label: 'runner dispatch failed' });
				if (attempts >= MAX_ATTEMPTS) await this.ctx.storage.delete(key);
				else await this.ctx.storage.put<Pending>(key, { ...req, attempts });
			}
		}
		const left = await this.ctx.storage.list<Pending>({ prefix: 'pending:' });
		if (left.size > 0) await this.ctx.storage.setAlarm(Date.now() + 5000);
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
