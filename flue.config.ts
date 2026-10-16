import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
	target: 'cloudflare',
	// The agent's model is the custom x402 AI Gateway provider registered in
	// src/app.ts; no built-in pi-ai providers are needed.
	providers: [],
});
