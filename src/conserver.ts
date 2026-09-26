// POSTs a vCon to a conserver ingress, with bounded retry for transient failures.
// Split out of cli.ts so it can be imported by tests without running the CLI's
// top-level argv parsing.

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Base delay in ms before the exponential backoff and jitter are applied. Default 500. */
  baseDelayMs?: number;
  /** Injectable so tests don't actually sleep. Defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable source of randomness for jitter. Defaults to Math.random. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Marks a failure as safe to retry: a network/timeout error, a 5xx, or a 429.
// Any other 4xx is a client-side problem (bad payload, auth, etc.) that a retry
// won't fix, so it is not wrapped in this and propagates on the first attempt.
class RetryableError extends Error {}

async function postOnce(
  url: string,
  list: string,
  headers: Record<string, string>,
  vcon: Record<string, any>,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${url}/vcon?ingress_lists=${encodeURIComponent(list)}`, {
      method: "POST", headers, body: JSON.stringify(vcon), signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    // Network error or timeout: worth retrying.
    throw new RetryableError(err instanceof Error ? err.message : String(err));
  }
  if (res.ok) return;
  const message = `conserver ${res.status}: ${await res.text()}`;
  if (res.status === 429 || res.status >= 500) throw new RetryableError(message);
  throw new Error(message); // other 4xx: not retryable
}

export async function postToConserver(vcon: Record<string, any>, retry: RetryOptions = {}): Promise<void> {
  const url = process.env.CONSERVER_URL?.replace(/\/+$/, "");
  if (!url) throw new Error("--post needs CONSERVER_URL");
  const list = process.env.CONSERVER_INGRESS_LIST || "default";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.CONSERVER_API_TOKEN) {
    headers[process.env.CONSERVER_HEADER_NAME || "x-conserver-api-token"] = process.env.CONSERVER_API_TOKEN;
  }

  const attempts = retry.attempts ?? 3;
  const baseDelayMs = retry.baseDelayMs ?? 500;
  const sleep = retry.sleep ?? defaultSleep;
  const random = retry.random ?? Math.random;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await postOnce(url, list, headers, vcon);
      return;
    } catch (err) {
      const retryable = err instanceof RetryableError;
      if (!retryable || attempt === attempts) throw err;
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const jitterMs = Math.round(backoff * random());
      await sleep(backoff + jitterMs);
    }
  }
}
