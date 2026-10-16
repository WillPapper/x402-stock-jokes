// Generates a fresh wallet for this app and appends it to .dev.vars.
// Never overwrites an existing key: delete the lines yourself if you mean it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const path = '.dev.vars';
if (existsSync(path) && /^EVM_BASE_PRIVATE_KEY=/m.test(readFileSync(path, 'utf8'))) {
	console.error(`${path} already has EVM_BASE_PRIVATE_KEY; refusing to overwrite.`);
	process.exit(1);
}
const key = generatePrivateKey();
const account = privateKeyToAccount(key);
appendFileSync(path, `\nEVM_BASE_ADDRESS=${account.address}\nEVM_BASE_PRIVATE_KEY=${key}\n`);
console.log(`Wallet ${account.address} written to ${path}.`);
console.log('Fund it on Base mainnet with a few USDC and about $0.25 of ETH (for the one-time Permit2 approval),');
console.log('then run: bun run approve && bun run doctor');
