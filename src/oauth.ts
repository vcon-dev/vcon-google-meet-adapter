import { google } from "googleapis";
import type { OAuth2Client, Credentials } from "google-auth-library";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// Single-account token store: one connected Google Workspace account, tokens in a
// gitignored file. Swap for a real secret store when going multi-account.
const TOKEN_PATH = path.resolve(process.env.GOOGLE_TOKEN_PATH ?? ".google-token.json");

// Read-only. Calendar gives the meeting title and attendee emails; Meet gives
// conference records, participants and transcripts.
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "openid",
  "email",
];

type StoredTokens = Credentials & { _email?: string };

function readTokens(): StoredTokens | null {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeTokens(tokens: StoredTokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function redirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3001/api/google/callback";
}

let cachedClient: OAuth2Client | null = null;

export function getOAuthClient(): OAuth2Client {
  if (cachedClient) return cachedClient;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");

  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri());
  const stored = readTokens();
  if (stored) client.setCredentials(stored);

  // Google only returns refresh_token on first consent, so merge to keep it.
  client.on("tokens", (tokens) => writeTokens({ ...(readTokens() ?? {}), ...tokens }));

  cachedClient = client;
  return client;
}

export function isConnected(): boolean {
  return !!readTokens()?.refresh_token;
}

// One-time consent: serve the redirect URI locally, print the consent URL, and
// store the tokens when Google calls back.
export async function authorize(): Promise<string | null> {
  const client = getOAuthClient();
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
  const redirect = new URL(redirectUri());

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirect);
      if (u.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }
      const c = u.searchParams.get("code");
      res.end(c ? "Connected. You can close this tab." : "No code in callback.");
      server.close();
      c ? resolve(c) : reject(new Error(u.searchParams.get("error") ?? "no code"));
    });
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      console.log(`Open this URL and approve access:\n\n${url}\n`);
    });
  });

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  let email: string | null = null;
  try {
    email = (await google.oauth2({ version: "v2", auth: client }).userinfo.get()).data.email ?? null;
  } catch { /* non-fatal */ }
  writeTokens({ ...tokens, _email: email ?? undefined });
  return email;
}
