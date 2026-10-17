import { defineConfig } from 'astro/config';

// The page is a static Astro site. `astro build` writes it into dist/client,
// the directory the Worker serves as assets (wrangler.jsonc), after `vite build`
// has produced the Worker itself (package.json "build").
//
// In development `astro dev` serves the page on :4321 and proxies the Worker's
// routes to `vite dev` on :5173. API_ORIGIN points the proxy elsewhere, e.g. at
// the production site to work on the page with real data:
//   API_ORIGIN=https://jokes.papper.me bun run dev:web
const api = process.env.API_ORIGIN ?? 'http://localhost:5173';

export default defineConfig({
	site: 'https://jokes.papper.me',
	srcDir: './src',
	publicDir: '../public',
	outDir: '../dist/client',
	vite: {
		server: { proxy: { '^/(api|joke|agents|j)(/|$)': { target: api, changeOrigin: true } } },
	},
});
