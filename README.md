# vcon-google-meet-adapter

Turns Google Meet meetings into vCons. For each conference record with a Meet transcript, it builds one vCon (draft-ietf-vcon-vcon-core-04, syntax `0.4.0`) and writes it to disk, posts it to a conserver, or both.

What a vCon carries:

- **parties**: Meet participant display names, then the calendar event's attendee emails as `mailto` parties. Meet exposes names but not emails, so the two lists aren't merged.
- **dialog[0]**: a `recording` entry with start, duration and parties. It holds metadata only: the Drive recording isn't copied or hashed, so there's no `url` or `content_hash`.
- **analysis[0]**: the transcript as speaker turns, `vendor: google`, `schema: google-meet-transcript-v1` (a free-form label per -04 §4.5.8, not a URI), a raw JSON body (`encoding: "json"`).
- **subject**: the calendar event title, when the meeting code matches an event.
- **tags**: `source`, `conference_record`, `meeting_code`, `calendar_event_id`.
- **lawful_basis**: an attachment per draft-howe-vcon-lawful-basis, only when you configure one (see below).

## Setup

Requires Node 21.7 or later and a Google Workspace account. Meet transcripts and the Meet REST API aren't available on consumer accounts.

1. In Google Cloud, enable the Google Meet REST API and the Google Calendar API. Create an OAuth client of type Web application and register the redirect URI `http://localhost:3001/api/google/callback`, or set your own in `GOOGLE_REDIRECT_URI`.
2. Copy `.env.example` to `.env` and fill in the client id and secret.
3. Install dependencies, then connect the account once:

```bash
npm install
npm run auth
```

The adapter asks for read-only scopes: `calendar.readonly` and `meetings.space.readonly`. It stores tokens in `.google-token.json`, which is gitignored and written with mode 600.

## Run

```bash
npm run sync -- --out out --days 30
npm run sync -- --post
```

`--out` writes `<uuid>.vcon.json` files. `--post` sends each vCon to `POST $CONSERVER_URL/vcon?ingress_lists=$CONSERVER_INGRESS_LIST`, adding the `CONSERVER_API_TOKEN` header when that variable is set.

Reruns are idempotent. `.meet-adapter-state.json` maps each conference record id to the uuid of the vCon built for it, so a later run only picks up new meetings. Delete an entry to rebuild that one meeting.

A `--post` that fails is retried up to 3 attempts total, with exponential backoff (500ms, 1s, 2s) plus jitter, on network errors, `5xx`, and `429`. Any other `4xx` (bad payload, auth, etc.) is not retried, since retrying won't fix it. If every attempt fails, the meeting is left out of `.meet-adapter-state.json` so the next run retries it from scratch.

## Lawful basis

The adapter doesn't assume why an organization records its meetings. Set `LAWFUL_BASIS` to one of the six GDPR bases, plus `LAWFUL_BASIS_CONTROLLER` and `LAWFUL_BASIS_STATEMENT`. Every basis except `legitimate_interests` also needs `LAWFUL_BASIS_EXPIRATION`. `LAWFUL_BASIS_PURPOSES` sets which purposes are granted and defaults to `recording,transcription`. When `LAWFUL_BASIS` is unset, vCons go out without the attachment and each run prints a warning.

`LAWFUL_BASIS_GRANTED_AT` (optional) is the ISO 8601 timestamp, with an explicit timezone, at which consent/basis was actually granted (e.g. `2025-01-02T12:15:30Z`). The adapter has no way to observe this itself — it only knows a meeting happened, not when whoever authorized recording actually granted it — so it is never inferred from the meeting's start time. When set, it becomes `granted_at` on every purpose grant and the lawful_basis attachment's `start`. When unset, the purpose grants omit `granted_at` (matching the extension doc's own synthetic-data pattern) and the attachment's `start` falls back to the vCon's `created_at`, the only real timestamp the adapter has for that record.

## Limits

- Only meetings with a Meet transcript are converted. Meetings captured only by Gemini notes ("Take notes for me") have no transcript in the Meet API and are counted as `no transcript`.
- Calendar correlation reads the connected account's primary calendar, matching on meeting code.
- One account per deployment.

## Test

```bash
npm test
npm run typecheck
```

Tests use only synthetic fixtures (fake participant labels, `example.com` emails) — no real Google API calls or real meeting data. `test/schema.test.ts` validates a synthetic meeting against the WG's vendored JSON Schema for the unsigned vCon form (`test/schema/vcon_json_schema.json`, see `test/schema/SOURCE.md`) with `ajv`. CI runs `npm ci`, `npm run build`, and `npm test` on Node 20 for every PR and push to `main` (`.github/workflows/test.yml`).

## Origin

Extracted from the Meet capture module of a vCon revenue-intelligence prototype, without its Redis store, enrichment pipeline and database.
