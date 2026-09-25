import { google, type meet_v2 } from "googleapis";
import { getOAuthClient } from "./oauth.js";

// One conference record = one Meet conversation that actually happened.
export interface ConferenceRecord {
  recordId: string;          // conferenceRecords/{id} -> {id}
  meetingCode: string | null;
  startTime: string | null;
  endTime: string | null;
  participants: string[];    // display names (Meet gives names, not emails)
  hasTranscript: boolean;
  recordingFiles: string[];  // Drive file ids
  // From the matching calendar event, when the meeting code lines up.
  calendarEventId: string | null;
  calendarTitle: string | null;
  attendees: string[];       // attendee emails
}

export interface TranscriptTurn {
  speaker: string;
  text: string;
  start: string | null;
}

interface CalendarMatch { id: string; title: string; attendees: string[] }

function meetClient() {
  return google.meet({ version: "v2", auth: getOAuthClient() });
}

// hangoutLink looks like https://meet.google.com/abc-defg-hij ; the code is the path.
export function codeFromHangout(link: string | null | undefined): string | null {
  const m = link?.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/i);
  return m ? m[1] : null;
}

// Meeting code -> calendar event, for every Meet-linked event in the window.
async function calendarByCode(since: string): Promise<Record<string, CalendarMatch>> {
  const calendar = google.calendar({ version: "v3", auth: getOAuthClient() });
  const map: Record<string, CalendarMatch> = {};
  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId: "primary", timeMin: since, timeMax: new Date().toISOString(),
      singleEvents: true, maxResults: 250, pageToken,
    });
    for (const ev of res.data.items ?? []) {
      const code = codeFromHangout(ev.hangoutLink);
      if (!code || ev.status === "cancelled") continue;
      map[code] = {
        id: ev.id ?? "",
        title: ev.summary ?? "(no title)",
        attendees: (ev.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
      };
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return map;
}

export async function listConferences(opts: { days: number; limit: number }): Promise<ConferenceRecord[]> {
  const meet = meetClient();
  const since = new Date(Date.now() - opts.days * 864e5).toISOString();
  const byCode = await calendarByCode(since);

  const records: meet_v2.Schema$ConferenceRecord[] = [];
  let pageToken: string | undefined;
  do {
    const res = await meet.conferenceRecords.list({ pageSize: 100, filter: `start_time >= "${since}"`, pageToken });
    records.push(...(res.data.conferenceRecords ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && records.length < opts.limit);

  const out: ConferenceRecord[] = [];
  for (const rec of records.slice(0, opts.limit)) {
    const name = rec.name ?? "";

    let meetingCode: string | null = null;
    if (rec.space) {
      try {
        meetingCode = (await meet.spaces.get({ name: rec.space })).data.meetingCode ?? null;
      } catch { /* space may be inaccessible */ }
    }

    const participants: string[] = [];
    try {
      const pr = await meet.conferenceRecords.participants.list({ parent: name, pageSize: 50 });
      for (const p of pr.data.participants ?? []) {
        const nm = p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName;
        if (nm) participants.push(nm);
      }
    } catch { /* best effort */ }

    let hasTranscript = false;
    try {
      const tr = await meet.conferenceRecords.transcripts.list({ parent: name, pageSize: 1 });
      hasTranscript = (tr.data.transcripts ?? []).length > 0;
    } catch { /* best effort */ }

    const recordingFiles: string[] = [];
    try {
      const rr = await meet.conferenceRecords.recordings.list({ parent: name, pageSize: 10 });
      for (const r of rr.data.recordings ?? []) if (r.driveDestination?.file) recordingFiles.push(r.driveDestination.file);
    } catch { /* best effort */ }

    const cal = meetingCode ? byCode[meetingCode] : undefined;
    out.push({
      recordId: name.split("/").pop() ?? name,
      meetingCode,
      startTime: rec.startTime ?? null,
      endTime: rec.endTime ?? null,
      participants,
      hasTranscript,
      recordingFiles,
      calendarEventId: cal?.id ?? null,
      calendarTitle: cal?.title ?? null,
      attendees: cal?.attendees ?? [],
    });
  }
  return out;
}

// Speaker turns for one conference record, speaker names resolved from participants.
export async function getTranscript(recordId: string): Promise<TranscriptTurn[]> {
  const meet = meetClient();
  const tlist = await meet.conferenceRecords.transcripts.list({ parent: `conferenceRecords/${recordId}`, pageSize: 5 });

  const names: Record<string, string> = {};
  async function nameFor(participant: string | null | undefined): Promise<string> {
    if (!participant) return "Unknown";
    if (names[participant]) return names[participant];
    try {
      // conferenceRecords/{c}/participants/{p}[/participantSessions/{s}]
      const p = await meet.conferenceRecords.participants.get({ name: participant.split("/participantSessions/")[0] });
      names[participant] = p.data.signedinUser?.displayName ?? p.data.anonymousUser?.displayName ?? "Speaker";
    } catch {
      names[participant] = "Speaker";
    }
    return names[participant];
  }

  const turns: TranscriptTurn[] = [];
  for (const t of tlist.data.transcripts ?? []) {
    if (!t.name) continue;
    let pageToken: string | undefined;
    do {
      const er = await meet.conferenceRecords.transcripts.entries.list({ parent: t.name, pageSize: 100, pageToken });
      for (const e of er.data.transcriptEntries ?? []) {
        turns.push({ speaker: await nameFor(e.participant), text: e.text ?? "", start: e.startTime ?? null });
      }
      pageToken = er.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  return turns;
}
