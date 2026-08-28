/**
 * Safely reduces an unknown caught value to a JSON-serializable message.
 *
 * Every controller's catch block used to do `res.json({ message: 'Server
 * error', error })`, passing the raw caught value straight into the
 * response. That's fine for a plain Error most of the time, but some errors
 * — notably Node's TLS certificate errors (e.g. from a misconfigured SMTP
 * connection) — carry an `issuerCertificate` field that references itself,
 * and `JSON.stringify` throws "Converting circular structure to JSON" on
 * those. When that throw happens inside an async Express handler with
 * nothing to catch it, the response is never sent at all, so the client
 * just sees a hung request instead of the actual error. This always
 * produces a plain, serializable string instead.
 */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	try {
		return JSON.stringify(error);
	} catch {
		return 'Unknown error';
	}
}
