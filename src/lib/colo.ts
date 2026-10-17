/** Which Cloudflare colo and country this isolate's outbound requests appear to come from. */
export async function whereAmI(): Promise<{ colo: string | null; loc: string | null; ip: string | null }> {
	try {
		const t = Object.fromEntries((await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text()).trim().split('\n').map((l) => l.split('=') as [string, string]));
		return { colo: t.colo ?? null, loc: t.loc ?? null, ip: t.ip ?? null };
	} catch {
		return { colo: null, loc: null, ip: null };
	}
}
