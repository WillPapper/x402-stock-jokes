/**
 * USDC spend caps, in base units (6 decimals). A payment is reserved before it
 * is signed, then committed once the gateway confirms settlement or released
 * if the request failed. Both caps are checked at reserve time, so a payment
 * over budget is refused before any signature exists.
 */
export class BudgetExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BudgetExceededError';
	}
}

export const USDC_DECIMALS = 6;

export function usdToBaseUnits(usd: number | string): bigint {
	const [whole, frac = ''] = String(usd).split('.');
	return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt((frac + '000000').slice(0, USDC_DECIMALS));
}

export function formatUsdc(baseUnits: bigint): string {
	const s = baseUnits.toString().padStart(USDC_DECIMALS + 1, '0');
	return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`;
}

export class Budget {
	private committed = 0n;
	private reserved = 0n;

	constructor(
		/** Most a single payment may authorize. */
		readonly maxPerPayment: bigint,
		/** Most this budget may authorize in total (reserved + committed). */
		readonly maxTotal: bigint,
		alreadySpent = 0n,
	) {
		this.committed = alreadySpent;
	}

	get spent(): bigint {
		return this.committed;
	}

	get remaining(): bigint {
		return this.maxTotal - this.committed - this.reserved;
	}

	reserve(amount: bigint): void {
		if (amount > this.maxPerPayment) {
			throw new BudgetExceededError(
				`payment of ${formatUsdc(amount)} USDC exceeds the per-payment cap of ${formatUsdc(this.maxPerPayment)} USDC`,
			);
		}
		if (amount > this.remaining) {
			throw new BudgetExceededError(
				`payment of ${formatUsdc(amount)} USDC exceeds the remaining budget of ${formatUsdc(this.remaining)} USDC`,
			);
		}
		this.reserved += amount;
	}

	commit(amount: bigint): void {
		this.reserved -= amount;
		this.committed += amount;
	}

	release(amount: bigint): void {
		this.reserved -= amount;
	}
}
