// Loads .dev.vars (Wrangler's local secrets file) into process.env for scripts.
// Values already present in the environment win.
import { existsSync, readFileSync } from 'node:fs';

export function loadDevVars(path = '.dev.vars'): void {
	if (!existsSync(path)) return;
	for (const raw of readFileSync(path, 'utf8').split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		if (!(key in process.env)) process.env[key] = value;
	}
}

/** Non-secret settings come from wrangler.jsonc `vars`, the same source the Worker uses. */
export function workerVars(path = 'wrangler.jsonc'): Record<string, string> {
	if (!existsSync(path)) return {};
	const jsonc = readFileSync(path, 'utf8');
	const json = jsonc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
	try {
		const vars = (JSON.parse(json) as { vars?: Record<string, unknown> }).vars ?? {};
		return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)]));
	} catch {
		return {};
	}
}

export function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`Missing ${name}. Add it to .dev.vars (see .dev.vars.example).`);
		process.exit(1);
	}
	return v;
}

export function privateKey(): `0x${string}` {
	const pk = requireEnv('EVM_BASE_PRIVATE_KEY');
	return (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
}
