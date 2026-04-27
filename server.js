const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret';
const LOCKDOWN_MODE = process.env.LOCKDOWN_MODE === 'true';
const REGISTRATION_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_DIR = path.join(__dirname, 'db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

initDatabase();

const registerRateLimit = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      return send(res, 204);
    }

    if (url.pathname === '/' && req.method === 'GET') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    }

    if (url.pathname.startsWith('/public/')) {
      return serveStaticAsset(res, url.pathname.replace('/public/', ''));
    }

    if (url.pathname === '/api/register' && req.method === 'POST') {
      return handleRegister(req, res);
    }

    if (url.pathname === '/api/enter' && req.method === 'POST') {
      return handleEnter(req, res);
    }

    if (url.pathname === '/api/problem-statements' && req.method === 'GET') {
      return handleProblemStatements(res);
    }

    if (url.pathname === '/api/select' && req.method === 'POST') {
      return handleSelect(req, res);
    }

    if (url.pathname.startsWith('/api/status/') && req.method === 'GET') {
      const teamId = Number(url.pathname.split('/').pop());
      return handleStatus(res, teamId);
    }

    if (url.pathname === '/api/admin/dashboard' && req.method === 'GET') {
      return handleAdminDashboard(req, res);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Hackathon portal running at http://${HOST}:${PORT}`);
});

function initDatabase() {
  const schemaSql = fs.readFileSync(path.join(DB_DIR, 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const existingCount = db.prepare('SELECT COUNT(*) AS count FROM problem_statements').get().count;
  if (existingCount === 0) {
    const seedSql = fs.readFileSync(path.join(DB_DIR, 'seed.sql'), 'utf8');
    db.exec(seedSql);
  }
}

async function handleRegister(req, res) {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return sendJson(res, 429, { error: 'Too many registration attempts. Please wait a minute.' });
  }

  const body = await parseJsonBody(req, res);
  if (!body) {
    return;
  }

  const teamName = sanitizeTeamName(body.team_name);
  if (!teamName) {
    return sendJson(res, 400, { error: 'Team name is required.' });
  }

  if (teamName.length > 100) {
    return sendJson(res, 400, { error: 'Team name must be 100 characters or fewer.' });
  }

  const token = crypto.randomUUID();
  try {
    const result = db.prepare(`
      INSERT INTO teams (team_name, session_token)
      VALUES (?, ?)
    `).run(teamName, token);

    const team = db.prepare(`
      SELECT id, team_name, session_token, selected_ps, selected_at, created_at
      FROM teams
      WHERE id = ?
    `).get(Number(result.lastInsertRowid));

    return sendJson(res, 201, {
      team_id: team.id,
      session_token: team.session_token,
      team_name: team.team_name,
      created_at: team.created_at,
      expires_at: new Date(parseSqliteTimestamp(team.created_at) + REGISTRATION_WINDOW_MS).toISOString()
    });
  } catch (error) {
    const message = String(error.message);
    if (
      message.includes('UNIQUE constraint failed: teams.team_name') ||
      message.includes("UNIQUE constraint failed: index 'teams_team_name_unique_nocase'")
    ) {
      return sendJson(res, 409, { error: 'Team name already exists.' });
    }
    throw error;
  }
}

async function handleEnter(req, res) {
  const body = await parseJsonBody(req, res);
  if (!body) {
    return;
  }

  const teamName = sanitizeTeamName(body.team_name);
  if (!teamName) {
    return sendJson(res, 400, { error: 'Team name is required.' });
  }

  const team = db.prepare(`
    SELECT id, team_name, session_token, selected_ps, selected_at, created_at
    FROM teams
    WHERE lower(team_name) = lower(?)
  `).get(teamName);

  if (!team) {
    return sendJson(res, 404, { error: 'Team name not found. Register first to continue.' });
  }

  return sendJson(res, 200, {
    team_id: team.id,
    session_token: team.session_token,
    team_name: team.team_name,
    selected_ps: team.selected_ps,
    selected_at: team.selected_at,
    created_at: team.created_at,
    expires_at: new Date(parseSqliteTimestamp(team.created_at) + REGISTRATION_WINDOW_MS).toISOString()
  });
}

function handleProblemStatements(res) {
  const statements = db.prepare(`
    SELECT
      ps.id,
      ps.title,
      ps.description,
      ps.max_slots,
      COALESCE(c.filled_slots, 0) AS filled_slots,
      ps.max_slots - COALESCE(c.filled_slots, 0) AS remaining_slots
    FROM problem_statements ps
    LEFT JOIN ps_slot_counts c ON c.ps_id = ps.id
    ORDER BY ps.id ASC
  `).all();

  return sendJson(res, 200, { problem_statements: statements, lockdown_mode: LOCKDOWN_MODE });
}

async function handleSelect(req, res) {
  if (LOCKDOWN_MODE) {
    return sendJson(res, 423, { error: 'Selections are currently locked by admin.' });
  }

  const body = await parseJsonBody(req, res);
  if (!body) {
    return;
  }

  const teamId = Number(body.team_id);
  const psId = Number(body.ps_id);

  if (!Number.isInteger(teamId) || !Number.isInteger(psId)) {
    return sendJson(res, 400, { error: 'Valid team_id and ps_id are required.' });
  }

  try {
    db.exec('BEGIN IMMEDIATE TRANSACTION');

    const team = db.prepare(`
      SELECT id, team_name, selected_ps, selected_at, created_at
      FROM teams
      WHERE id = ?
    `).get(teamId);

    if (!team) {
      db.exec('ROLLBACK');
      return sendJson(res, 404, { error: 'Team not found.' });
    }

    if (team.selected_ps !== null) {
      db.exec('ROLLBACK');
      return sendJson(res, 403, { error: 'Selection is already locked.' });
    }

    const createdAtMs = parseSqliteTimestamp(team.created_at);
    if (Number.isNaN(createdAtMs) || Date.now() - createdAtMs > REGISTRATION_WINDOW_MS) {
      db.exec('ROLLBACK');
      return sendJson(res, 403, { error: 'Selection window has expired.' });
    }

    const statement = db.prepare(`
      SELECT id, title, description, max_slots
      FROM problem_statements
      WHERE id = ?
    `).get(psId);

    if (!statement) {
      db.exec('ROLLBACK');
      return sendJson(res, 404, { error: 'Problem statement not found.' });
    }

    const countRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM teams
      WHERE selected_ps = ?
    `).get(psId);

    if (countRow.count >= statement.max_slots) {
      db.exec('ROLLBACK');
      return sendJson(res, 409, { error: 'This problem statement is full.' });
    }

    const updateResult = db.prepare(`
      UPDATE teams
      SET selected_ps = ?, selected_at = CURRENT_TIMESTAMP
      WHERE id = ? AND selected_ps IS NULL
    `).run(psId, teamId);

    if (updateResult.changes !== 1) {
      db.exec('ROLLBACK');
      return sendJson(res, 409, { error: 'Selection could not be completed.' });
    }

    const confirmation = db.prepare(`
      SELECT
        t.id AS team_id,
        t.team_name,
        t.selected_at,
        ps.id AS ps_id,
        ps.title AS ps_title
      FROM teams t
      JOIN problem_statements ps ON ps.id = t.selected_ps
      WHERE t.id = ?
    `).get(teamId);

    db.exec('COMMIT');

    return sendJson(res, 200, {
      success: true,
      confirmation
    });
  } catch (error) {
    safeRollback();
    if (String(error.message).includes('Selection is immutable')) {
      return sendJson(res, 403, { error: 'Selection is already locked.' });
    }
    throw error;
  }
}

function handleStatus(res, teamId) {
  if (!Number.isInteger(teamId)) {
    return sendJson(res, 400, { error: 'Invalid team id.' });
  }

  const row = db.prepare(`
    SELECT
      t.id AS team_id,
      t.team_name,
      t.selected_ps,
      t.selected_at,
      t.created_at,
      ps.title AS selected_ps_title
    FROM teams t
    LEFT JOIN problem_statements ps ON ps.id = t.selected_ps
    WHERE t.id = ?
  `).get(teamId);

  if (!row) {
    return sendJson(res, 404, { error: 'Team not found.' });
  }

  return sendJson(res, 200, {
    ...row,
    selection_open: row.selected_ps === null && Date.now() - parseSqliteTimestamp(row.created_at) <= REGISTRATION_WINDOW_MS && !LOCKDOWN_MODE,
    expires_at: new Date(parseSqliteTimestamp(row.created_at) + REGISTRATION_WINDOW_MS).toISOString(),
    lockdown_mode: LOCKDOWN_MODE
  });
}

function handleAdminDashboard(req, res) {
  const providedKey = req.headers['x-admin-key'];
  if (!providedKey || providedKey !== ADMIN_KEY) {
    return sendJson(res, 401, { error: 'Unauthorized.' });
  }

  const summary = db.prepare(`
    SELECT
      ps.id,
      ps.title,
      ps.description,
      ps.max_slots,
      COALESCE(c.filled_slots, 0) AS filled_slots,
      ps.max_slots - COALESCE(c.filled_slots, 0) AS remaining_slots
    FROM problem_statements ps
    LEFT JOIN ps_slot_counts c ON c.ps_id = ps.id
    ORDER BY ps.id ASC
  `).all();

  const teams = db.prepare(`
    SELECT
      t.id,
      t.team_name,
      t.selected_ps,
      t.selected_at,
      t.created_at,
      ps.title AS selected_ps_title
    FROM teams t
    LEFT JOIN problem_statements ps ON ps.id = t.selected_ps
    ORDER BY t.created_at ASC, t.id ASC
  `).all();

  const byPs = summary.map((ps) => ({
    ...ps,
    teams: teams.filter((team) => team.selected_ps === ps.id)
  }));

  return sendJson(res, 200, {
    lockdown_mode: LOCKDOWN_MODE,
    registration_window_minutes: 10,
    problem_statements: byPs,
    unselected_teams: teams.filter((team) => team.selected_ps === null)
  });
}

async function parseJsonBody(req, res) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) {
      sendJson(res, 413, { error: 'Payload too large.' });
      return null;
    }
  }

  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return null;
  }
}

function sanitizeTeamName(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (registerRateLimit.get(ip) || []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  registerRateLimit.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX_REQUESTS;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function serveStaticAsset(res, assetPath) {
  const normalized = path.normalize(assetPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'application/octet-stream';

  return serveFile(res, filePath, contentType);
}

function serveFile(res, filePath, contentType) {
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      return sendJson(res, 404, { error: 'File not found' });
    }
    send(res, 200, data, { 'Content-Type': contentType });
  });
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8'
  });
}

function send(res, statusCode, body = '', headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...headers
  });
  res.end(body);
}

function safeRollback() {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Ignore rollback errors when no transaction is active.
  }
}

function parseSqliteTimestamp(value) {
  const parsed = Date.parse(String(value).replace(' ', 'T') + 'Z');
  return parsed;
}
