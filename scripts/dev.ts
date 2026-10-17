/**
 * Development: the Worker (`vite dev`, http://localhost:5173, the API and the
 * agent) and the page (`astro dev`, http://localhost:4321, which proxies the
 * API routes to the Worker) side by side; Ctrl-C stops both.
 *
 * `bun run dev:worker` or `bun run dev:web` runs either alone;
 * `API_ORIGIN=https://jokes.papper.me bun run dev:web` points the page at
 * production to work on it with real data.
 */
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const run = (script: string) => spawn('bun', ['run', script], { cwd: root, stdio: 'inherit' });
const procs = [run('dev:worker'), run('dev:web')];

const stop = () => { for (const p of procs) if (p.exitCode === null) p.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const code = await Promise.race(procs.map((p) => new Promise<number>((resolve) => p.on('exit', (c) => resolve(c ?? 1)))));
stop();
process.exit(code);
