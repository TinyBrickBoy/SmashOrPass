import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  // no .env file present, fall back to real environment variables
}

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const SECURE_COOKIE = BASE_URL.startsWith('https://');
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const LOGIN_TTL_MS = 1000 * 60 * 10; // anonymous sessions only live for the OAuth round trip
const MAX_SESSIONS = 50_000;
// repo: read private repos + archive, delete_repo: delete repos
const OAUTH_SCOPE = 'repo delete_repo read:user';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are missing. See .env.example');
  process.exit(1);
}

/** @type {Map<string, {token?: string, user?: object, state?: string, expires: number}>} */
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
}, 60_000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req, res, create = false) {
  const id = parseCookies(req).sop_sid;
  const existing = id && sessions.get(id);
  if (existing && existing.expires > Date.now()) {
    if (existing.token) existing.expires = Date.now() + SESSION_TTL_MS;
    return existing;
  }
  if (!create) return null;
  if (sessions.size >= MAX_SESSIONS) return null;
  const newId = randomBytes(32).toString('hex');
  const session = { expires: Date.now() + LOGIN_TTL_MS };
  sessions.set(newId, session);
  res.setHeader('Set-Cookie', cookie('sop_sid', newId, SESSION_TTL_MS / 1000));
  return session;
}

// New session id after login so a pre-set cookie can never be reused (session fixation)
function rotateSession(req, res, session) {
  const oldId = parseCookies(req).sop_sid;
  if (oldId) sessions.delete(oldId);
  const newId = randomBytes(32).toString('hex');
  session.expires = Date.now() + SESSION_TTL_MS;
  sessions.set(newId, session);
  res.setHeader('Set-Cookie', cookie('sop_sid', newId, SESSION_TTL_MS / 1000));
}

function cookie(name, value, maxAge) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAge)}`,
    SECURE_COOKIE ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function destroySession(req, res) {
  const id = parseCookies(req).sop_sid;
  if (id) sessions.delete(id);
  res.setHeader('Set-Cookie', cookie('sop_sid', '', 0));
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  ...(SECURE_COOKIE ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

function sendJson(res, status, data) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

async function github(token, path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    // Never follow redirects: a moved or transferred repo must not be changed at its new location
    redirect: 'manual',
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'smash-or-pass',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return r;
}

// Revoke the OAuth token on GitHub on sign out, so it is useless even if it leaked
async function revokeToken(token) {
  try {
    await fetch(`https://api.github.com/applications/${CLIENT_ID}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'User-Agent': 'smash-or-pass',
      },
      body: JSON.stringify({ access_token: token }),
    });
  } catch (err) {
    console.warn('Token revocation failed:', err.message);
  }
}

async function fetchAllRepos(token) {
  const repos = [];
  for (let page = 1; page <= 30; page++) {
    const r = await github(token, `/user/repos?affiliation=owner&per_page=100&page=${page}&sort=pushed&direction=asc`);
    if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}`), { status: r.status });
    const batch = await r.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: repo.owner.login,
    description: repo.description,
    html_url: repo.html_url,
    language: repo.language,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    open_issues: repo.open_issues_count,
    size_kb: repo.size,
    private: repo.private,
    fork: repo.fork,
    archived: repo.archived,
    topics: repo.topics || [],
    created_at: repo.created_at,
    pushed_at: repo.pushed_at,
    updated_at: repo.updated_at,
  }));
}

// CSRF protection: mutating requests need a custom header and a same origin
function isTrustedMutation(req) {
  if (req.headers['x-requested-with'] !== 'smash-or-pass') return false;
  const origin = req.headers.origin;
  return !origin || origin === BASE_URL;
}

async function sendGithubError(res, r, fallback) {
  if (r.status >= 300 && r.status < 400) {
    return sendJson(res, 409, { error: 'Repo was renamed or transferred, reload your repos' });
  }
  const body = await r.json().catch(() => ({}));
  return sendJson(res, r.status >= 400 ? r.status : 502, { error: body.message || fallback });
}

const REPO_PATH = /^\/api\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(\/archive)?$/;

async function handleApi(req, res, url) {
  const session = getSession(req, res);

  if (url.pathname === '/api/me') {
    if (!session?.token) return sendJson(res, 401, { error: 'not_authenticated' });
    return sendJson(res, 200, session.user);
  }

  if (!session?.token) return sendJson(res, 401, { error: 'not_authenticated' });

  if (url.pathname === '/api/repos' && req.method === 'GET') {
    try {
      return sendJson(res, 200, await fetchAllRepos(session.token));
    } catch (err) {
      return sendJson(res, err.status === 401 ? 401 : 502, { error: err.message });
    }
  }

  const m = url.pathname.match(REPO_PATH);
  if (m) {
    if (!isTrustedMutation(req)) return sendJson(res, 403, { error: 'forbidden' });
    const [, owner, repo, archive] = m;
    if (/^\.+$/.test(repo)) return sendJson(res, 400, { error: 'invalid repo name' });
    if (owner.toLowerCase() !== session.user.login.toLowerCase()) {
      return sendJson(res, 403, { error: 'Only your own repos are allowed' });
    }
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    if (archive && req.method === 'POST') {
      const r = await github(session.token, path, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
      if (!r.ok) return sendGithubError(res, r, 'Archiving failed');
      return sendJson(res, 200, { ok: true });
    }
    if (!archive && req.method === 'DELETE') {
      const r = await github(session.token, path, { method: 'DELETE' });
      if (r.status !== 204) return sendGithubError(res, r, 'Deleting failed');
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: 'not_found' });
}

async function handleAuth(req, res, url) {
  if (url.pathname === '/auth/login') {
    const session = getSession(req, res, true);
    if (!session) return sendJson(res, 503, { error: 'Too many sessions, try again later' });
    session.state = randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: `${BASE_URL}/auth/callback`,
      scope: OAUTH_SCOPE,
      state: session.state,
      allow_signup: 'false',
    });
    return redirect(res, `https://github.com/login/oauth/authorize?${params}`);
  }

  if (url.pathname === '/auth/callback') {
    const session = getSession(req, res);
    const { code, state } = Object.fromEntries(url.searchParams);
    if (!session || !code || !state || state !== session.state) return redirect(res, '/?error=state');
    delete session.state;

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/auth/callback`,
      }),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenData.access_token) return redirect(res, '/?error=token');

    const userRes = await github(tokenData.access_token, '/user');
    if (!userRes.ok) return redirect(res, '/?error=user');
    const user = await userRes.json();

    session.token = tokenData.access_token;
    session.user = { login: user.login, name: user.name, avatar_url: user.avatar_url, html_url: user.html_url };
    rotateSession(req, res, session);
    return redirect(res, '/');
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    if (!isTrustedMutation(req)) return sendJson(res, 403, { error: 'forbidden' });
    const session = getSession(req, res);
    if (session?.token) await revokeToken(session.token);
    destroySession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

async function serveStatic(req, res, url) {
  let rel;
  try {
    rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  } catch {
    return sendJson(res, 400, { error: 'bad_request' });
  }
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/auth/')) return await handleAuth(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
  }
});

server.listen(PORT, () => {
  console.log(`Smash or Pass running on ${BASE_URL}`);
});
