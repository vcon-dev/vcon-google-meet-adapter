import { test } from "node:test";
import assert from "node:assert/strict";
import { postToConserver } from "../src/conserver.js";

const NOOP_RETRY = { sleep: async () => {}, random: () => 0 };

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function installFetch(fn: typeof fetch): () => void {
  const prev = globalThis.fetch;
  globalThis.fetch = fn as any;
  return () => { globalThis.fetch = prev; };
}

test("succeeds on the first attempt with no retries", async () => {
  let calls = 0;
  const restore = installFetch(async () => {
    calls++;
    return new Response("ok", { status: 200 });
  });
  try {
    await withEnv({ CONSERVER_URL: "https://conserver.example.test" }, () =>
      postToConserver({ uuid: "x" }, NOOP_RETRY));
  } finally {
    restore();
  }
  assert.equal(calls, 1);
});

test("retries on a transient network error and eventually succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const restore = installFetch(async () => {
    calls++;
    if (calls < 3) throw new Error("ECONNRESET");
    return new Response("ok", { status: 200 });
  });
  try {
    await withEnv({ CONSERVER_URL: "https://conserver.example.test" }, () =>
      postToConserver({ uuid: "x" }, {
        sleep: async (ms) => { sleeps.push(ms); },
        random: () => 0,
      }));
  } finally {
    restore();
  }
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2); // one sleep between each retry, none after success
});

test("retries on 500 and 429, not on other 4xx", async () => {
  for (const status of [500, 502, 429]) {
    let calls = 0;
    const restore = installFetch(async () => {
      calls++;
      if (calls < 2) return new Response("boom", { status });
      return new Response("ok", { status: 200 });
    });
    try {
      await withEnv({ CONSERVER_URL: "https://conserver.example.test" }, () =>
        postToConserver({ uuid: "x" }, NOOP_RETRY));
    } finally {
      restore();
    }
    assert.equal(calls, 2, `status ${status} should be retried`);
  }

  let calls = 0;
  const restore = installFetch(async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  });
  try {
    await assert.rejects(
      withEnv({ CONSERVER_URL: "https://conserver.example.test" }, () =>
        postToConserver({ uuid: "x" }, NOOP_RETRY)),
      /conserver 400/,
    );
  } finally {
    restore();
  }
  assert.equal(calls, 1, "a non-retryable 4xx must not be retried");
});

test("exhausted retries reject with the last error", async () => {
  let calls = 0;
  const restore = installFetch(async () => {
    calls++;
    return new Response("still down", { status: 503 });
  });
  try {
    await assert.rejects(
      withEnv({ CONSERVER_URL: "https://conserver.example.test" }, () =>
        postToConserver({ uuid: "x" }, { ...NOOP_RETRY, attempts: 3 })),
      /conserver 503/,
    );
  } finally {
    restore();
  }
  assert.equal(calls, 3);
});

test("backoff grows exponentially with the configured base delay", async () => {
  const sleeps: number[] = [];
  const restore = installFetch(async () => new Response("down", { status: 500 }));
  try {
    await assert.rejects(
      withEnv({ CONSERVER_URL: "https://conserver.example.test" }, () =>
        postToConserver({ uuid: "x" }, {
          attempts: 4,
          baseDelayMs: 100,
          random: () => 0, // no jitter, so we can assert exact backoff values
          sleep: async (ms) => { sleeps.push(ms); },
        })),
    );
  } finally {
    restore();
  }
  assert.deepEqual(sleeps, [100, 200, 400]);
});
