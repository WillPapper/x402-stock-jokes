import type { JsonValue } from '@flue/runtime';

/** Tool outputs must be JSON; our result types are, but carry no index signature. */
export function asJson(value: unknown): JsonValue {
	return value as JsonValue;
}
