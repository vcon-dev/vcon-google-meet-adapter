import { test } from "node:test";
import assert from "node:assert/strict";
import { conferenceToVcon, lawfulBasisFromEnv, jsonBody } from "../src/vcon.js";
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

  // -04 §2.3.2: encoding="json" means body is the raw JSON value, not a
  // JSON.stringify'd string.
  const [a] = v.analysis;
  assert.equal(a.vendor, "google");
  assert.equal(a.schema, "google-meet-transcript-v1");
  assert.equal(a.mediatype, "application/json");
  assert.equal(a.encoding, "json");
  assert.equal(typeof a.body, "object");
  assert.deepEqual(a.body, turns);
  assert.deepEqual(jsonBody(a), turns);

  // vcon-js's own addTag() still stringifies (a legacy -02 shape); this adapter
  // doesn't author that attachment directly, so it stays whatever the library
  // emits, and jsonBody() reads it back either way.
  const tags = v.attachments.find((x: any) => x.purpose === "tags");
  assert.deepEqual((jsonBody(tags) as any).meeting_code, "abc-defg-hij");

  const lb = v.attachments.find((x: any) => x.purpose === "lawful_basis");
  assert.equal(lb.mediatype, "application/json");
  assert.equal(lb.encoding, "json");
  assert.equal(typeof lb.body, "object");
  assert.deepEqual(jsonBody(lb), lb.body);
  const body = lb.body;
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

// --- LAWFUL_BASIS_GRANTED_AT: the adapter never knows when consent was actually
// granted (it only knows the meeting happened), so granted_at must come from
// config, and the attachment falls back to a real timestamp, not the meeting
// start, when no grant time is configured. ---

test("granted_at from config lands on the attachment and every purpose grant", () => {
  const cfg = lawfulBasisFromEnv({ ...env, LAWFUL_BASIS_GRANTED_AT: "2026-08-15T09:00:00Z" });
  assert.equal(cfg?.grantedAt, "2026-08-15T09:00:00Z");

  const v = conferenceToVcon(rec, turns, cfg);
  const lb = v.attachments.find((x: any) => x.purpose === "lawful_basis");
  assert.equal(lb.start, "2026-08-15T09:00:00Z");
  for (const grant of lb.body.purpose_grants) {
    assert.equal(grant.granted_at, "2026-08-15T09:00:00Z");
  }
  assert.equal(lb.body.proof_mechanisms[0].timestamp, "2026-08-15T09:00:00Z");
});

test("granted_at absent means the attachment omits it and falls back to created_at, never the meeting start", () => {
  const cfg = lawfulBasisFromEnv(env);
  assert.equal(cfg?.grantedAt, null);

  const v = conferenceToVcon(rec, turns, cfg);
  const lb = v.attachments.find((x: any) => x.purpose === "lawful_basis");
  // Falls back to the vCon's own created_at, a timestamp the adapter actually has.
  assert.equal(lb.start, v.created_at);
  assert.notEqual(lb.start, rec.startTime);
  for (const grant of lb.body.purpose_grants) {
    assert.ok(!("granted_at" in grant), "granted_at must not be invented");
  }
  assert.ok(!("timestamp" in lb.body.proof_mechanisms[0]));
});

test("LAWFUL_BASIS_GRANTED_AT must be ISO 8601 with a timezone", () => {
  assert.throws(
    () => lawfulBasisFromEnv({ ...env, LAWFUL_BASIS_GRANTED_AT: "2026-08-15T09:00:00" }),
    /timezone/,
  );
  assert.throws(
    () => lawfulBasisFromEnv({ ...env, LAWFUL_BASIS_GRANTED_AT: "not-a-date" }),
    /timezone/,
  );
  assert.equal(
    lawfulBasisFromEnv({ ...env, LAWFUL_BASIS_GRANTED_AT: "2026-08-15T09:00:00+02:00" })?.grantedAt,
    "2026-08-15T09:00:00+02:00",
  );
});

test("jsonBody rejects non-json encoding and accepts both raw and stringified json bodies", () => {
  assert.throws(() => jsonBody({ body: "x", encoding: "none" }), /encoding/);
  assert.deepEqual(jsonBody({ body: { a: 1 }, encoding: "json" }), { a: 1 });
  assert.deepEqual(jsonBody({ body: JSON.stringify({ a: 1 }), encoding: "json" }), { a: 1 });
});
