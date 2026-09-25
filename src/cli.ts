#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { authorize, isConnected } from "./oauth.js";
import { listConferences, getTranscript } from "./meet.js";
import { conferenceToVcon, lawfulBasisFromEnv } from "./vcon.js";

try { process.loadEnvFile(); } catch { /* no .env, use the real environment */ }

// recordId -> vCon uuid. One vCon per conference record, so reruns only pick up new meetings.
// ponytail: flat JSON file, move to a database if several workers share one account.
const STATE_PATH = path.resolve(process.env.MEET_ADAPTER_STATE ?? ".meet-adapter-state.json");

function readState(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}

async function postToConserver(vcon: Record<string, any>): Promise<void> {
  const url = process.env.CONSERVER_URL?.replace(/\/+$/, "");
  if (!url) throw new Error("--post needs CONSERVER_URL");
  const list = process.env.CONSERVER_INGRESS_LIST || "default";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.CONSERVER_API_TOKEN) {
    headers[process.env.CONSERVER_HEADER_NAME || "x-conserver-api-token"] = process.env.CONSERVER_API_TOKEN;
  }
  const res = await fetch(`${url}/vcon?ingress_lists=${encodeURIComponent(list)}`, {
    method: "POST", headers, body: JSON.stringify(vcon), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`conserver ${res.status}: ${await res.text()}`);
}

async function sync(opts: { days: number; limit: number; out?: string; post: boolean }) {
  if (!opts.out && !opts.post) throw new Error("sync needs --out <dir>, --post, or both");
  if (!isConnected()) throw new Error("not connected, run `auth` first");

  const basis = lawfulBasisFromEnv();
  if (!basis) console.warn("warning: LAWFUL_BASIS not set, vCons will carry no lawful_basis attachment");
  if (opts.out) fs.mkdirSync(opts.out, { recursive: true });

  const state = readState();
  const recs = await listConferences({ days: opts.days, limit: opts.limit });
  let built = 0, skipped = 0, noTranscript = 0, failed = 0;

  for (const rec of recs) {
    if (state[rec.recordId]) { skipped++; continue; }
    if (!rec.hasTranscript) { noTranscript++; continue; }
    try {
      const turns = await getTranscript(rec.recordId);
      if (!turns.length) { noTranscript++; continue; }
      const vcon = conferenceToVcon(rec, turns, basis);
      if (opts.out) fs.writeFileSync(path.join(opts.out, `${vcon.uuid}.vcon.json`), JSON.stringify(vcon, null, 2));
      if (opts.post) await postToConserver(vcon);
      // Save after each vCon so a crash mid-run doesn't rebuild what already went out.
      state[rec.recordId] = vcon.uuid;
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      built++;
      console.log(`${vcon.uuid}  ${rec.calendarTitle ?? rec.meetingCode ?? rec.recordId}  (${turns.length} turns)`);
    } catch (err) {
      failed++;
      console.error(`${rec.recordId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`conferences ${recs.length}, built ${built}, already done ${skipped}, no transcript ${noTranscript}, failed ${failed}`);
  if (failed) process.exitCode = 1;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string", default: "30" },
    limit: { type: "string", default: "1000" },
    out: { type: "string" },
    post: { type: "boolean", default: false },
  },
});

const cmd = positionals[0];
try {
  if (cmd === "auth") {
    const email = await authorize();
    console.log(`Connected${email ? ` as ${email}` : ""}.`);
  } else if (cmd === "sync") {
    await sync({ days: Number(values.days), limit: Number(values.limit), out: values.out, post: values.post });
  } else {
    console.log("usage: vcon-google-meet auth | sync [--days 30] [--limit 1000] [--out dir] [--post]");
    process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
