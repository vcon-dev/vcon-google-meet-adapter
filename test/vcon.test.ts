import { test } from "node:test";
import assert from "node:assert/strict";
import { conferenceToVcon, lawfulBasisFromEnv } from "../src/vcon.js";
import { codeFromHangout, type ConferenceRecord } from "../src/meet.js";

const rec: ConferenceRecord = {
  recordId: "abc123",
  meetingCode: "abc-defg-hij",
  startTime: "2026-09-01T14:00:00Z",
  endTime: "2026-09-01T14:30:00Z",
  participants: ["Alice", "Bob"],
  hasTranscript: true,
  recordingFiles: [],
  calendarEventId: "evt1",
  calendarTitle: "Weekly sync",
  attendees: ["Alice@Example.com", "bob@example.com"],
};
const turns = [
  { speaker: "Alice", text: "Hi", start: "2026-09-01T14:00:05Z" },
  { speaker: "Bob", text: "Hello", start: "2026-09-01T14:00:07Z" },
];
const env = {
  LAWFUL_BASIS: "legitimate_interests",
  LAWFUL_BASIS_CONTROLLER: "example-org",
  LAWFUL_BASIS_STATEMENT: "Internal meetings recorded under the org recording policy",
};

test("conference becomes a spec-shaped vCon", () => {
  const v = conferenceToVcon(rec, turns, lawfulBasisFromEnv(env));
  assert.equal(v.vcon, "0.4.0");
  assert.equal(v.subject, "Weekly sync");
  assert.deepEqual(v.parties.map((p: any) => p.name ?? p.mailto), ["Alice", "Bob", "alice@example.com", "bob@example.com"]);
  assert.equal(v.dialog[0].type, "recording");
  assert.equal(v.dialog[0].duration, 1800);
  assert.deepEqual(v.dialog[0].parties, [0, 1]);

  const [a] = v.analysis;
  assert.equal(a.vendor, "google");
  assert.equal(typeof a.body, "string");
  assert.deepEqual(JSON.parse(a.body), turns);

  const tags = v.attachments.find((x: any) => x.purpose === "tags");
  assert.equal(JSON.parse(tags.body).meeting_code, "abc-defg-hij");

  const lb = v.attachments.find((x: any) => x.purpose === "lawful_basis");
  assert.equal(typeof lb.body, "string");
  const body = JSON.parse(lb.body);
  assert.equal(body.lawful_basis, "legitimate_interests");
  assert.deepEqual(body.purpose_grants.map((g: any) => g.purpose), ["recording", "transcription"]);
  assert.equal(body.proof_mechanisms[0].mechanism_type, "external_system");
  assert.ok(v.extensions.includes("lawful_basis"));
});

test("no lawful basis configured means no attachment, not an invented one", () => {
  assert.equal(lawfulBasisFromEnv({}), null);
  const v = conferenceToVcon(rec, turns, null);
  assert.ok(!v.attachments.some((x: any) => x.purpose === "lawful_basis"));
});

test("bases other than legitimate_interests need an expiration", () => {
  assert.throws(() => lawfulBasisFromEnv({ ...env, LAWFUL_BASIS: "consent" }), /EXPIRATION/);
  assert.throws(() => lawfulBasisFromEnv({ ...env, LAWFUL_BASIS: "because" }), /must be one of/);
});

test("meeting code comes out of a hangout link", () => {
  assert.equal(codeFromHangout("https://meet.google.com/abc-defg-hij?authuser=0"), "abc-defg-hij");
  assert.equal(codeFromHangout(null), null);
});
