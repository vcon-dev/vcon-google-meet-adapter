import { Vcon, Party, Dialog } from "vcon-js";
import type { ConferenceRecord, TranscriptTurn } from "./meet.js";

// Lawful basis per draft-howe-vcon-lawful-basis. Supplied by the deployment, never
// assumed: the adapter can't know why a given organization records its meetings.
export interface LawfulBasisConfig {
  basis: string;              // one of the six GDPR bases
  expiration: string | null;  // required unless basis is legitimate_interests
  purposes: string[];         // processing purposes granted (recording, transcription, ...)
  controller: string;
  statement: string;
  termsOfService?: string;
  // When each purpose was actually granted. Only known when the deployment tells us
  // (LAWFUL_BASIS_GRANTED_AT); the adapter has no way to observe consent itself, so
  // this is null rather than defaulted to the meeting start time. See conferenceToVcon.
  grantedAt: string | null;
}

const BASES = ["consent", "contract", "legal_obligation", "vital_interests", "public_task", "legitimate_interests"];

// RFC 3339 / ISO 8601 timestamp with an explicit timezone (Z or +/-HH:MM offset).
// A bare local timestamp with no offset is rejected: we never guess a timezone.
const ISO_8601_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseGrantedAt(env: NodeJS.ProcessEnv): string | null {
  const raw = env.LAWFUL_BASIS_GRANTED_AT?.trim();
  if (!raw) return null;
  if (!ISO_8601_WITH_TZ.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new Error("LAWFUL_BASIS_GRANTED_AT must be ISO 8601 with a timezone, e.g. 2025-01-02T12:15:30Z");
  }
  return raw;
}

// Reads LAWFUL_BASIS_* from the environment. Returns null when unset, so vCons go
// out without a basis and the caller can warn. Throws on an invalid config.
export function lawfulBasisFromEnv(env = process.env): LawfulBasisConfig | null {
  const basis = env.LAWFUL_BASIS?.trim();
  if (!basis) return null;
  if (!BASES.includes(basis)) throw new Error(`LAWFUL_BASIS must be one of ${BASES.join(", ")}`);
  const expiration = env.LAWFUL_BASIS_EXPIRATION?.trim() || null;
  if (basis !== "legitimate_interests" && !expiration) {
    throw new Error(`LAWFUL_BASIS=${basis} needs LAWFUL_BASIS_EXPIRATION (ISO 8601)`);
  }
  if (!env.LAWFUL_BASIS_CONTROLLER || !env.LAWFUL_BASIS_STATEMENT) {
    throw new Error("LAWFUL_BASIS needs LAWFUL_BASIS_CONTROLLER and LAWFUL_BASIS_STATEMENT");
  }
  return {
    basis,
    expiration,
    purposes: (env.LAWFUL_BASIS_PURPOSES || "recording,transcription").split(",").map((x) => x.trim()).filter(Boolean),
    controller: env.LAWFUL_BASIS_CONTROLLER,
    statement: env.LAWFUL_BASIS_STATEMENT,
    termsOfService: env.LAWFUL_BASIS_TOS_URL || undefined,
    grantedAt: parseGrantedAt(env),
  };
}

// `start` is the vCon-required attachment start time: the grant time when the
// deployment told us one (LAWFUL_BASIS_GRANTED_AT), otherwise the vCon's own
// created_at (a real timestamp we actually have), never the meeting start time,
// which would falsely assert consent happened at that moment.
function lawfulBasisAttachment(cfg: LawfulBasisConfig, start: string) {
  const grantedAt = cfg.grantedAt;
  const grant = (purpose: string) =>
    grantedAt ? { purpose, granted: true, granted_at: grantedAt } : { purpose, granted: true };
  const body = {
    lawful_basis: cfg.basis,
    expiration: cfg.expiration,
    purpose_grants: cfg.purposes.map(grant),
    proof_mechanisms: [{
      mechanism_type: "external_system",
      ...(grantedAt ? { timestamp: grantedAt } : {}),
      description: cfg.statement,
      proof_data: { system: "vcon-google-meet-adapter", controller: cfg.controller },
    }],
    ...(cfg.termsOfService ? { terms_of_service: cfg.termsOfService } : {}),
  };
  // -04 §2.3.2: with encoding="json" the body is the JSON value itself, not a
  // JSON.stringify'd string. See jsonBody() below for the matching reader.
  return { purpose: "lawful_basis", start, party: 0, dialog: 0, mediatype: "application/json", encoding: "json", body };
}

// Reads back an inline body per -04 §2.3.2: encoding="json" means body is already
// the JSON value. Older vCons (and vcon-js's addAnalysis(), which still serializes
// per the superseded -02 rule) carry it as a JSON string; accept both.
export function jsonBody(obj: { body?: unknown; encoding?: string }): unknown {
  if (obj.encoding !== "json") throw new Error('jsonBody: encoding is not "json"');
  return typeof obj.body === "string" ? JSON.parse(obj.body) : obj.body;
}

function durationSec(rec: ConferenceRecord): number | undefined {
  if (!rec.startTime || !rec.endTime) return undefined;
  return Math.max(0, Math.round((Date.parse(rec.endTime) - Date.parse(rec.startTime)) / 1000));
}

export function conferenceToVcon(
  rec: ConferenceRecord,
  turns: TranscriptTurn[],
  basis: LawfulBasisConfig | null,
): Record<string, any> {
  const v = Vcon.buildNew();

  // Parties: Meet display names first, then calendar attendee emails. Meet gives
  // no emails, so the two can't be merged; attendees are appended as mailto-only
  // parties so downstream classification can resolve the external account.
  const names = rec.participants.length ? rec.participants : [...new Set(turns.map((t) => t.speaker))];
  names.forEach((n) => v.addParty(new Party({ name: n })));
  rec.attendees.forEach((e) => v.addParty(new Party({ mailto: e.toLowerCase() })));
  const speakers = names.map((_, i) => i);

  // Recording dialog as metadata only. No url+content_hash because the Drive media
  // isn't copied or hashed (the spec needs both or neither).
  const duration = durationSec(rec);
  const start = rec.startTime ?? new Date(0).toISOString();
  v.addDialog(new Dialog({
    type: "recording",
    start,
    parties: speakers.length ? speakers : [0],
    ...(duration != null ? { duration } : {}),
    mediatype: "video/mp4",
  } as any));

  if (rec.calendarTitle) v.subject = rec.calendarTitle;

  v.addTag("source", "google-meet");
  v.addTag("conference_record", rec.recordId);
  if (rec.meetingCode) v.addTag("meeting_code", rec.meetingCode);
  if (rec.calendarEventId) v.addTag("calendar_event_id", rec.calendarEventId);

  const dict = v.toDict() as Record<string, any>;

  if (turns.length) {
    // Built directly on the dict rather than through v.addAnalysis(), which still
    // JSON.stringifies non-string bodies per the superseded -02 rule (vcon-js
    // 0.5.2). Under -04 §2.3.2, encoding="json" means body is the raw JSON value.
    // schema is a free-form token/label per -04 §4.5.8, not required to be a URI,
    // so "google-meet-transcript-v1" is a valid value as-is.
    dict.analysis = [...(dict.analysis ?? []), {
      type: "transcript",
      dialog: 0,
      vendor: "google",
      product: "google-meet",
      schema: "google-meet-transcript-v1",
      mediatype: "application/json",
      body: turns,
      encoding: "json",
    }];
  }

  if (basis) {
    dict.attachments = [...(dict.attachments ?? []), lawfulBasisAttachment(basis, basis.grantedAt ?? dict.created_at)];
    dict.extensions = [...new Set([...(dict.extensions ?? []), "lawful_basis"])];
  }
  return dict;
}
