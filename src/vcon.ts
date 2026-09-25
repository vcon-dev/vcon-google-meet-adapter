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
}

const BASES = ["consent", "contract", "legal_obligation", "vital_interests", "public_task", "legitimate_interests"];

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
  };
}

function lawfulBasisAttachment(cfg: LawfulBasisConfig, grantedAt: string) {
  const grant = (purpose: string) => ({ purpose, granted: true, granted_at: grantedAt });
  const body = {
    lawful_basis: cfg.basis,
    expiration: cfg.expiration,
    purpose_grants: cfg.purposes.map(grant),
    proof_mechanisms: [{
      mechanism_type: "external_system",
      timestamp: grantedAt,
      description: cfg.statement,
      proof_data: { system: "vcon-google-meet-adapter", controller: cfg.controller },
    }],
    ...(cfg.termsOfService ? { terms_of_service: cfg.termsOfService } : {}),
  };
  return { purpose: "lawful_basis", start: grantedAt, party: 0, dialog: 0, encoding: "json", body: JSON.stringify(body) };
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

  if (turns.length) {
    v.addAnalysis({
      type: "transcript",
      dialog: 0,
      vendor: "google",
      product: "google-meet",
      schema: "google-meet-transcript-v1",
      body: JSON.stringify(turns),
      encoding: "json",
    });
  }

  v.addTag("source", "google-meet");
  v.addTag("conference_record", rec.recordId);
  if (rec.meetingCode) v.addTag("meeting_code", rec.meetingCode);
  if (rec.calendarEventId) v.addTag("calendar_event_id", rec.calendarEventId);

  const dict = v.toDict() as Record<string, any>;
  if (basis) {
    dict.attachments = [...(dict.attachments ?? []), lawfulBasisAttachment(basis, start)];
    dict.extensions = [...new Set([...(dict.extensions ?? []), "lawful_basis"])];
  }
  return dict;
}
