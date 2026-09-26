import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { conferenceToVcon, lawfulBasisFromEnv } from "../src/vcon.js";
import type { ConferenceRecord, TranscriptTurn } from "../src/meet.js";

// Vendored WG schema for the -04 appendix. See test/schema/SOURCE.md.
const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema", "vcon_json_schema.json");

function loadValidator() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

// A synthetic meeting: fake participant labels, no real names, example.com email.
const syntheticMeeting: ConferenceRecord = {
  recordId: "synthetic-conference-0001",
  meetingCode: "syn-thet-ic",
  startTime: "2026-06-01T10:00:00Z",
  endTime: "2026-06-01T10:45:00Z",
  participants: ["Participant A", "Participant B", "Participant C"],
  hasTranscript: true,
  recordingFiles: [],
  calendarEventId: "synthetic-event-0001",
  calendarTitle: "Synthetic planning sync",
  attendees: ["participant.a@example.com", "participant.b@example.com"],
};

const syntheticTurns: TranscriptTurn[] = [
  { speaker: "Participant A", text: "Let's get started.", start: "2026-06-01T10:00:05Z" },
  { speaker: "Participant B", text: "Sounds good.", start: "2026-06-01T10:00:09Z" },
  { speaker: "Participant C", text: "Agreed.", start: "2026-06-01T10:00:12Z" },
];

// Synthetic-data lawful basis pattern from the extension doc: legitimate_interests,
// no expiration, an external_system proof naming the generator, no granted_at
// (the doc's own synthetic example omits it too).
const syntheticBasis = lawfulBasisFromEnv({
  LAWFUL_BASIS: "legitimate_interests",
  LAWFUL_BASIS_CONTROLLER: "synthetic-test-fixture",
  LAWFUL_BASIS_STATEMENT: "Synthetic conversation generated for test fixtures; no real data subject",
});

test("a synthetic meeting converts to a vCon that validates against the vendored WG schema", () => {
  const validate = loadValidator();
  const vcon = conferenceToVcon(syntheticMeeting, syntheticTurns, syntheticBasis);

  const valid = validate(vcon);
  assert.ok(valid, JSON.stringify(validate.errors, null, 2));

  // Non-negotiables from the vault's vCon reference, re-checked directly (the WG
  // schema doesn't enforce all of these, e.g. it allows "type" as a synonym).
  assert.equal(vcon.vcon, "0.4.0");
  for (const a of vcon.attachments as any[]) {
    assert.notEqual(a.type, "type", "attachments must use purpose, not type, in core");
    assert.ok(a.purpose, "every attachment needs a purpose");
    assert.ok(a.start, "every attachment needs start");
    assert.equal(typeof a.party, "number");
    assert.equal(typeof a.dialog, "number");
    if (a.body !== undefined) {
      assert.ok(a.mediatype, `attachment ${a.purpose} has a body and needs mediatype`);
      assert.ok(a.encoding, `attachment ${a.purpose} has a body and needs encoding`);
    }
  }
  for (const an of vcon.analysis as any[]) {
    assert.notEqual(an.schema, undefined);
    assert.ok(an.vendor, "analysis requires vendor");
    assert.notEqual((an as any).schema_version, "string", "analysis field is schema, never schema_version");
  }

  const lb = (vcon.attachments as any[]).find((a) => a.purpose === "lawful_basis");
  assert.ok(lb, "synthetic meetings still need a lawful_basis attachment");
  assert.equal(lb.body.lawful_basis, "legitimate_interests");
  assert.equal(lb.body.expiration, null);
  assert.ok((vcon.extensions as string[]).includes("lawful_basis"));

  // No empty meta/metadata anywhere in the emitted vCon.
  assert.equal((vcon as any).meta, undefined);
  assert.equal((vcon as any).metadata, undefined);
});

test("a vCon missing required fields fails validation (sanity check on the validator itself)", () => {
  const validate = loadValidator();
  const broken = { vcon: "0.4.0" }; // no uuid, no created_at
  assert.equal(validate(broken), false);
});
