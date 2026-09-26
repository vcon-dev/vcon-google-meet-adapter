import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sync } from "../src/cli.js";
import type { ConferenceRecord, TranscriptTurn } from "../src/meet.js";

const rec: ConferenceRecord = {
  recordId: "rec-1",
  meetingCode: "abc-defg-hij",
  startTime: "2026-09-01T14:00:00Z",
  endTime: "2026-09-01T14:30:00Z",
  participants: ["Participant A", "Participant B"],
  hasTranscript: true,
  recordingFiles: [],
  calendarEventId: null,
  calendarTitle: "Synthetic sync",
  attendees: ["participant.a@example.com"],
};
const turns: TranscriptTurn[] = [{ speaker: "Participant A", text: "hi", start: null }];

function tempStatePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "meet-adapter-test-")), "state.json");
}

function baseDeps(overrides: Partial<Parameters<typeof sync>[1]> = {}) {
  return {
    isConnected: () => true,
    listConferences: async () => [rec],
    getTranscript: async () => turns,
    ...overrides,
  };
}

test("a failed --post leaves the meeting unsynced in the state file", async () => {
  const statePath = tempStatePath();
  fs.writeFileSync(statePath, JSON.stringify({})); // pre-seed so we can prove it's untouched
  // sync() sets process.exitCode = 1 when a record fails, which is correct CLI
  // behavior but would otherwise leak into this test file's own exit status.
  const prevExitCode = process.exitCode;
  try {
    const result = await sync(
      { days: 1, limit: 10, post: true, statePath },
      baseDeps({ postToConserver: async () => { throw new Error("conserver 503: down"); } }),
    );
    assert.equal(result.failed, 1);
    assert.equal(result.built, 0);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(state, {}, "the record must not be marked synced when the post failed");
  } finally {
    process.exitCode = prevExitCode;
  }
});

test("a post that resolves (retry succeeded, or no failure at all) marks the meeting synced", async () => {
  const statePath = tempStatePath();
  const result = await sync(
    { days: 1, limit: 10, post: true, statePath },
    baseDeps({ postToConserver: async () => {} }),
  );
  assert.equal(result.built, 1);
  assert.equal(result.failed, 0);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(state[rec.recordId], "the record should be marked synced");
});

test("a rerun skips a meeting already recorded in the state file", async () => {
  const statePath = tempStatePath();
  fs.writeFileSync(statePath, JSON.stringify({ [rec.recordId]: "already-done" }));
  const result = await sync({ days: 1, limit: 10, post: true, statePath }, baseDeps());
  assert.equal(result.skipped, 1);
  assert.equal(result.built, 0);
});
