// One-time on-chain approval so Permit2 can move this wallet's USDC on Base.
// Needed by Cloudflare AI Gateway's `upto` x402 scheme. Costs a little ETH once.
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, maxUint256 } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { PERMIT2, USDC_BASE } from '../src/lib/x402.ts';
import { loadDevVars, privateKey } from './_env.ts';

loadDevVars();
const rpc = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
const account = privateKeyToAccount(privateKey());
const pub = createPublicClient({ chain: base, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });

const allowance = await pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'allowance', args: [account.address, PERMIT2] });
if (allowance > 0n) {
	console.log(`Permit2 already approved for ${formatUnits(allowance, 6)} USDC. Nothing to do.`);
	process.exit(0);
}
const eth = await pub.getBalance({ address: account.address });
if (eth === 0n) {
	console.error(`Wallet ${account.address} has no ETH on Base; the approval transaction needs gas.`);
	process.exit(1);
}
console.log(`Approving Permit2 (${PERMIT2}) to spend USDC from ${account.address}…`);
const hash = await wallet.writeContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] });
console.log(`Sent https://basescan.org/tx/${hash}, waiting for confirmation…`);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`Status: ${receipt.status}. Gas used: ${receipt.gasUsed}.`);
