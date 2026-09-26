#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { authorize, isConnected } from "./oauth.js";
import { listConferences, getTranscript } from "./meet.js";
import { conferenceToVcon, lawfulBasisFromEnv } from "./vcon.js";
import { postToConserver } from "./conserver.js";
import type { ConferenceRecord, TranscriptTurn } from "./meet.js";

try { process.loadEnvFile(); } catch { /* no .env, use the real environment */ }

function readState(statePath: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; }
}

export interface SyncOptions {
  days: number;
  limit: number;
  out?: string;
  post: boolean;
  // recordId -> vCon uuid. One vCon per conference record, so reruns only pick up
  // new meetings. ponytail: flat JSON file, move to a database if several workers
  // share one account. Defaults to MEET_ADAPTER_STATE or .meet-adapter-state.json,
  // resolved at call time (not import time) so tests can point it at a temp file.
  statePath?: string;
}

// Dependency injection seam for tests: real Google/network calls stay out of
// unit tests, which pass synthetic implementations instead.
export interface SyncDeps {
  isConnected?: typeof isConnected;
  listConferences?: typeof listConferences;
  getTranscript?: typeof getTranscript;
  postToConserver?: typeof postToConserver;
}

export interface SyncResult {
  total: number;
  built: number;
  skipped: number;
  noTranscript: number;
  failed: number;
}

export async function sync(opts: SyncOptions, deps: SyncDeps = {}): Promise<SyncResult> {
  const _isConnected = deps.isConnected ?? isConnected;
  const _listConferences = deps.listConferences ?? listConferences;
  const _getTranscript = deps.getTranscript ?? getTranscript;
  const _postToConserver = deps.postToConserver ?? postToConserver;
  const statePath = path.resolve(opts.statePath ?? process.env.MEET_ADAPTER_STATE ?? ".meet-adapter-state.json");

  if (!opts.out && !opts.post) throw new Error("sync needs --out <dir>, --post, or both");
  if (!_isConnected()) throw new Error("not connected, run `auth` first");

  const basis = lawfulBasisFromEnv();
  if (!basis) console.warn("warning: LAWFUL_BASIS not set, vCons will carry no lawful_basis attachment");
  if (opts.out) fs.mkdirSync(opts.out, { recursive: true });

  const state = readState(statePath);
  const recs: ConferenceRecord[] = await _listConferences({ days: opts.days, limit: opts.limit });
  let built = 0, skipped = 0, noTranscript = 0, failed = 0;

  for (const rec of recs) {
    if (state[rec.recordId]) { skipped++; continue; }
    if (!rec.hasTranscript) { noTranscript++; continue; }
    try {
      const turns: TranscriptTurn[] = await _getTranscript(rec.recordId);
      if (!turns.length) { noTranscript++; continue; }
      const vcon = conferenceToVcon(rec, turns, basis);
      if (opts.out) fs.writeFileSync(path.join(opts.out, `${vcon.uuid}.vcon.json`), JSON.stringify(vcon, null, 2));
      if (opts.post) await _postToConserver(vcon);
      // Save after each vCon so a crash mid-run doesn't rebuild what already went
      // out. A post that fails (even after retries) throws before this line, so
      // the record is left out of state and gets retried on the next sync.
      state[rec.recordId] = vcon.uuid;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      built++;
      console.log(`${vcon.uuid}  ${rec.calendarTitle ?? rec.meetingCode ?? rec.recordId}  (${turns.length} turns)`);
    } catch (err) {
      failed++;
      console.error(`${rec.recordId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`conferences ${recs.length}, built ${built}, already done ${skipped}, no transcript ${noTranscript}, failed ${failed}`);
  if (failed) process.exitCode = 1;
  return { total: recs.length, built, skipped, noTranscript, failed };
}

// Only run the CLI dispatch when this file is the program entry point, not when
// it's imported (e.g. by tests importing `sync` directly).
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
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
}
