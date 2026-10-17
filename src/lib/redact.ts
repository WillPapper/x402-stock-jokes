/**
 * Response redaction helpers. Pure: no runtime imports, so unit tests can load it.
 */
/** Cloudflare account ids as they appear in API URLs (/accounts/<32 hex>/). */
const ACCOUNT_ID_IN_URL = /\/accounts\/[0-9a-f]{32}\//g;

/**
 * Replace the Cloudflare account id in any URL inside a JSON-serialisable
 * value. The id is not a credential, but there is no reason to hand it to
 * every visitor; D1 and Workers Logs keep the full URL.
 */
export function redactAccountIds<T>(value: T): T {
	const text = JSON.stringify(value);
	if (text === undefined || !ACCOUNT_ID_IN_URL.test(text)) return value;
	ACCOUNT_ID_IN_URL.lastIndex = 0;
	return JSON.parse(text.replace(ACCOUNT_ID_IN_URL, '/accounts/<account>/')) as T;
}
