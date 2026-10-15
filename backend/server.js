import express from 'express';
import { calculateLicenseFinanceMetrics } from './finance-metrics.js';
import pg from 'pg';
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const app = express();
const port = Number(process.env.PORT || 3001);
const root = dirname(fileURLToPath(import.meta.url));
const pool = new Pool({
  host: process.env.DB_HOST || 'database',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});
const SESSION_COOKIE = 'cm_session';
const SESSION_HOURS = 12;
const loginAttempts = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

function parseId(value) {
  if (!/^[1-9]\d{0,17}$/.test(String(value || ''))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function cleanString(value, maxLength = 2000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  if (cleaned.length > maxLength) return undefined;
  return cleaned || null;
}

function fail(res, status, error) {
  return res.status(status).json({ error });
}

function cookieValue(req, name) {
  const cookieHeader = req.headers.cookie || '';
  for (const item of cookieHeader.split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) return item.slice(index + 1).trim();
  }
  return null;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function sessionCookie(token, maxAge) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure;
}

function clearSessionCookie() {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure;
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + Buffer.from(derived).toString('hex');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const derived = Buffer.from(await scrypt(password, Buffer.from(parts[1], 'hex'), 64));
    const expected = Buffer.from(parts[2], 'hex');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

async function runMigrations() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const files = (await readdir(join(root, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (exists.rowCount) continue;
    const sql = await readFile(join(root, 'migrations', file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('Applied migration:', file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function bootstrapAdmin() {
  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || !password) {
    console.warn('Bootstrap admin not configured; login is disabled until ADMIN_USERNAME and ADMIN_PASSWORD are set.');
    return;
  }
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rowCount) return;
  const passwordHash = await hashPassword(password);
  await pool.query(
    'INSERT INTO users(username, display_name, password_hash, role) VALUES ($1, $2, $3, $4)',
    [username, username, passwordHash, 'admin']
  );
  console.log('Bootstrap administrator created:', username);
}

async function authenticate(req, res, next) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return fail(res, 401, 'Accesso richiesto.');
  }
  try {
    const result = await pool.query(
      'SELECT u.id, u.username, u.display_name, u.role, u.theme FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE',
      [tokenHash(token)]
    );
    if (!result.rowCount) return fail(res, 401, 'Sessione scaduta. Accedi di nuovo.');
    req.user = result.rows[0];
    req.sessionToken = token;
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return fail(res, 403, 'Permessi insufficienti.');
    next();
  };
}

function queryBranch(req) {
  if (!req.query.branchId || req.query.branchId === 'all') return { id: null, error: null };
  const id = parseId(req.query.branchId);
  return { id, error: id ? null : 'Filtro filiale non valido.' };
}

const clientFields = ['company_name', 'contact_name', 'email', 'phone', 'vat_number', 'notes'];
const clientLimits = { company_name: 200, contact_name: 200, email: 320, phone: 50, vat_number: 50, notes: 10000 };

function validateClient(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Il corpo della richiesta deve essere un oggetto JSON.';
  const allowed = new Set(clientFields);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return 'Campo non consentito: ' + key;
    if (typeof body[key] !== 'string' && body[key] !== null) return 'Il campo ' + key + ' deve essere una stringa.';
    if (typeof body[key] === 'string' && body[key].length > clientLimits[key]) return 'Il campo ' + key + ' è troppo lungo.';
  }
  if (!partial && !String(body.company_name || '').trim()) return 'company_name è obbligatorio.';
  if (partial && Object.keys(body).length === 0) return 'Specificare almeno un campo da modificare.';
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return 'Indirizzo email non valido.';
  return null;
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', service: 'client-management-api', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'error', service: 'client-management-api', database: 'unavailable' });
  }
});

app.post('/auth/login', async (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && record.resetAt > now && record.count >= 10) return fail(res, 429, 'Troppi tentativi. Riprova tra 15 minuti.');
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
    return fail(res, 503, 'Accesso non configurato. Impostare le variabili di autenticazione sul server.');
  }
  const username = cleanString(req.body?.username, 120);
  const password = req.body?.password;
  if (!username || typeof password !== 'string' || password.length > 1024) return fail(res, 400, 'Username e password sono obbligatori.');
  try {
    const result = await pool.query('SELECT id, username, display_name, password_hash, role, theme FROM users WHERE username = $1 AND is_active = TRUE', [username]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      const current = loginAttempts.get(ip);
      if (!current || current.resetAt <= now) loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
      else current.count += 1;
      return fail(res, 401, 'Credenziali non valide.');
    }
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
    await pool.query('INSERT INTO user_sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), user.id, expiresAt]);
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_HOURS * 60 * 60));
    res.json({ user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, theme: user.theme } });
  } catch (error) {
    next(error);
  }
});

app.post('/auth/logout', async (req, res, next) => {
  const token = cookieValue(req, SESSION_COOKIE);
  try {
    if (token && /^[a-f0-9]{64}$/.test(token)) await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash(token)]);
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use(authenticate);

app.get('/auth/me', (req, res) => res.json({ user: req.user }));

app.put('/auth/preferences', async (req, res, next) => {
  const theme = req.body?.theme;
  if (!['light', 'dark'].includes(theme)) return fail(res, 400, 'Tema non valido.');
  try {
    const result = await pool.query('UPDATE users SET theme = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, display_name, role, theme', [theme, req.user.id]);
    req.user = result.rows[0];
    res.json({ user: req.user });
  } catch (error) { next(error); }
});

app.get('/dashboard', async (req, res, next) => {
  const filter = queryBranch(req);
  if (filter.error) return fail(res, 400, filter.error);
  try {
    const [branches, devices, faults, monthly, stock, globalMonthly] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM branches WHERE ($1::bigint IS NULL OR id = $1)', [filter.id]),
      pool.query("SELECT COUNT(*)::int AS count FROM devices WHERE ($1::bigint IS NULL OR branch_id = $1)", [filter.id]),
      pool.query("SELECT COUNT(*)::int AS count FROM devices WHERE status = 'fault' AND ($1::bigint IS NULL OR branch_id = $1)", [filter.id]),
      pool.query("SELECT COALESCE(SUM(monthly_fee), 0)::numeric AS amount FROM devices WHERE ownership_type = 'rental' AND status <> 'decommissioned' AND ($1::bigint IS NULL OR branch_id = $1)", [filter.id]),
      pool.query("SELECT COUNT(*)::int AS count FROM devices WHERE status = 'in_stock' AND ($1::bigint IS NULL OR branch_id = $1)", [filter.id]),
      pool.query(`
        WITH current_branches AS (
          SELECT b.id,
            COALESCE(
              (SELECT h.is_active FROM branch_active_history h
               WHERE h.branch_id = b.id
                 AND h.active_since <= date_trunc('month', CURRENT_DATE)::date
               ORDER BY h.active_since DESC, h.recorded_at DESC, h.id DESC LIMIT 1),
              (b.is_active AND b.active_since <= date_trunc('month', CURRENT_DATE)::date),
              FALSE
            ) AS is_active
          FROM branches b
          WHERE ($1::bigint IS NULL OR b.id = $1)
        )
        SELECT COALESCE(SUM(
          g.monthly_amount * CASE
            WHEN $1::bigint IS NOT NULL THEN
              CASE WHEN EXISTS (
                SELECT 1 FROM current_branches cb
                WHERE cb.id = $1 AND cb.is_active
                  AND (g.apply_to_all OR EXISTS (
                    SELECT 1 FROM global_monthly_charge_branches gb
                    WHERE gb.charge_id = g.id AND gb.branch_id = cb.id
                  ))
              ) THEN 1 ELSE 0 END
            WHEN g.apply_to_all THEN (SELECT COUNT(*) FROM current_branches cb WHERE cb.is_active)
            ELSE (
              SELECT COUNT(*) FROM global_monthly_charge_branches gb
              JOIN current_branches cb ON cb.id = gb.branch_id AND cb.is_active
              WHERE gb.charge_id = g.id
            )
          END
        ), 0)::numeric AS amount
        FROM global_monthly_charges g
        WHERE g.starts_on <= date_trunc('month', CURRENT_DATE)::date
          AND date_trunc('month', CURRENT_DATE)::date <
            date_trunc('month', g.starts_on)::date + (g.duration_months * INTERVAL '1 month')
      `, [filter.id])
    ]);
    const monthlyFees = Number(monthly.rows[0].amount || 0) + Number(globalMonthly.rows[0].amount || 0);
    res.json({ data: { branches: branches.rows[0].count, devices: devices.rows[0].count, faults: faults.rows[0].count, monthlyFees, stock: stock.rows[0].count } });
  } catch (error) { next(error); }
});

app.get('/companies', async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT c.*, parent.legal_name AS parent_company_name,
        COUNT(DISTINCT b.id)::int AS branch_count,
        COUNT(DISTINCT child.id)::int AS child_company_count
      FROM companies c
      LEFT JOIN companies parent ON parent.id = c.parent_company_id
      LEFT JOIN branches b ON b.company_id = c.id
      LEFT JOIN companies child ON child.parent_company_id = c.id
      GROUP BY c.id, parent.legal_name
      ORDER BY c.legal_name
    `);
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/companies', requireRole('admin'), async (req, res, next) => {
  const legalName = cleanString(req.body?.legal_name, 200);
  const taxCode = cleanString(req.body?.tax_code, 50);
  const rawParentId = req.body?.parent_company_id;
  const parentCompanyId = rawParentId === '' || rawParentId === null || rawParentId === undefined ? null : parseId(rawParentId);
  if (legalName === undefined || taxCode === undefined) return fail(res, 400, 'Verificare i campi inseriti.');
  if (!legalName) return fail(res, 400, 'La ragione sociale è obbligatoria.');
  if (rawParentId !== '' && rawParentId !== null && rawParentId !== undefined && !parentCompanyId) return fail(res, 400, 'Ragione sociale madre non valida.');
  try {
    const result = await pool.query(
      'INSERT INTO companies(legal_name, tax_code, parent_company_id) VALUES ($1, $2, $3) RETURNING *',
      [legalName, taxCode, parentCompanyId]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'Ragione sociale già presente.');
    if (error.code === '23503') return fail(res, 400, 'La ragione sociale madre selezionata non esiste.');
    next(error);
  }
});

app.put('/companies/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  const legalName = cleanString(req.body?.legal_name, 200);
  const taxCode = cleanString(req.body?.tax_code, 50);
  const hasParent = Object.hasOwn(req.body || {}, 'parent_company_id');
  const rawParentId = req.body?.parent_company_id;
  const parsedParentId = rawParentId === '' || rawParentId === null || rawParentId === undefined ? null : parseId(rawParentId);
  const hasChildren = Object.hasOwn(req.body || {}, 'child_company_ids');
  const rawChildIds = req.body?.child_company_ids;
  if (!id) return fail(res, 400, 'ID non valido.');
  if (legalName === undefined || taxCode === undefined || !legalName) return fail(res, 400, 'Ragione sociale non valida.');
  if (hasParent && rawParentId !== '' && rawParentId !== null && rawParentId !== undefined && !parsedParentId) return fail(res, 400, 'Ragione sociale madre non valida.');
  if (hasChildren && !Array.isArray(rawChildIds)) return fail(res, 400, 'Elenco delle ragioni sociali figlie non valido.');
  const childIds = hasChildren ? rawChildIds.map(parseId) : [];
  if (hasChildren && (childIds.some((childId) => !childId) || new Set(childIds).size !== childIds.length || childIds.includes(id))) {
    return fail(res, 400, 'Una o più ragioni sociali figlie non sono valide.');
  }
  if (hasParent && parsedParentId === id) return fail(res, 409, 'Una ragione sociale non può essere madre di sé stessa.');
  if (hasParent && parsedParentId && hasChildren && childIds.includes(parsedParentId)) {
    return fail(res, 409, 'La ragione sociale madre non può essere anche una figlia.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id, parent_company_id FROM companies WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Ragione sociale non trovata.'); }
    const parentCompanyId = hasParent ? parsedParentId : current.rows[0].parent_company_id;

    if (parentCompanyId) {
      const cycle = await client.query(`
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM companies WHERE parent_company_id = $1
          UNION
          SELECT c.id FROM companies c JOIN descendants d ON c.parent_company_id = d.id
        )
        SELECT 1 FROM descendants WHERE id = $2 LIMIT 1
      `, [id, parentCompanyId]);
      if (cycle.rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'La società madre selezionata creerebbe un ciclo nella gerarchia.'); }
    }

    if (hasChildren && childIds.length) {
      const ancestors = await client.query(`
        WITH RECURSIVE ancestors(id) AS (
          SELECT parent_company_id FROM companies WHERE id = $1 AND parent_company_id IS NOT NULL
          UNION
          SELECT c.parent_company_id FROM companies c JOIN ancestors a ON c.id = a.id WHERE c.parent_company_id IS NOT NULL
        )
        SELECT id FROM ancestors
      `, [id]);
      const ancestorIds = new Set(ancestors.rows.map((row) => String(row.id)));
      if (childIds.some((childId) => ancestorIds.has(String(childId)))) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'Una società madre non può essere impostata anche come figlia.');
      }
      const existingChildren = await client.query('SELECT id FROM companies WHERE id = ANY($1::bigint[])', [childIds]);
      if (existingChildren.rowCount !== childIds.length) {
        await client.query('ROLLBACK');
        return fail(res, 400, 'Una o più ragioni sociali figlie non esistono.');
      }
    }

    await client.query(
      'UPDATE companies SET legal_name = $1, tax_code = $2, parent_company_id = $3, updated_at = NOW() WHERE id = $4',
      [legalName, taxCode, parentCompanyId, id]
    );
    if (hasChildren) {
      await client.query(
        'UPDATE companies SET parent_company_id = NULL, updated_at = NOW() WHERE parent_company_id = $1 AND NOT (id = ANY($2::bigint[]))',
        [id, childIds]
      );
      for (const childId of childIds) {
        await client.query('UPDATE companies SET parent_company_id = $1, updated_at = NOW() WHERE id = $2', [id, childId]);
      }
    }
    const result = await client.query('SELECT * FROM companies WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return fail(res, 409, 'Ragione sociale già presente.');
    if (error.code === '23503') return fail(res, 400, 'La ragione sociale madre o una figlia selezionata non esiste.');
    next(error);
  } finally { client.release(); }
});

app.delete('/companies/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  try {
    const usage = await pool.query('SELECT 1 FROM branches WHERE company_id = $1 LIMIT 1', [id]);
    if (usage.rowCount) return fail(res, 409, 'La ragione sociale è associata a una o più filiali. Riassegna o elimina prima le filiali.');
    const children = await pool.query('SELECT 1 FROM companies WHERE parent_company_id = $1 LIMIT 1', [id]);
    if (children.rowCount) return fail(res, 409, 'La ragione sociale ha società figlie. Riassegna o rimuovi prima la relazione con le figlie.');
    const result = await pool.query('DELETE FROM companies WHERE id = $1 RETURNING id', [id]);
    if (!result.rowCount) return fail(res, 404, 'Ragione sociale non trovata.');
    res.status(204).end();
  } catch (error) {
    if (error.code === '23503') return fail(res, 409, 'La ragione sociale è collegata ad altri dati e non può essere eliminata.');
    next(error);
  }
});

app.get('/branches', async (_req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT b.*, c.legal_name AS company_name FROM branches b JOIN companies c ON c.id = b.company_id ORDER BY c.legal_name, b.country, b.street'
    );
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/branches', requireRole('admin', 'technician'), async (req, res, next) => {
  const companyId = parseId(req.body?.company_id);
  const country = cleanString(req.body?.country, 100);
  const street = cleanString(req.body?.street, 300);
  const nomenclature = cleanString(req.body?.nomenclature, 100);
  const previous = cleanString(req.body?.previous_nomenclature, 100);
  const network = cleanString(req.body?.network, 100);
  const prefix = cleanString(req.body?.phone_prefix, 30);
  const wlc = cleanString(req.body?.wlc, 200);
  const isActive = req.body?.is_active;
  const activeSince = req.body?.active_since;
  if (typeof isActive !== 'boolean' || !activeSince) return fail(res, 400, 'Stato filiale e data di decorrenza sono obbligatori.');
  if (!companyId || [country, street, nomenclature, previous, network, prefix, wlc].includes(undefined)) return fail(res, 400, 'Verificare i campi della filiale.');
  if (!country || !street) return fail(res, 400, 'Paese e via sono obbligatori.');
  try {
    const result = await pool.query(
      'INSERT INTO branches(company_id, country, street, nomenclature, previous_nomenclature, network, phone_prefix, wlc, is_active, active_since) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [companyId, country, street, nomenclature, previous, network, prefix, wlc, isActive, activeSince]
    );
    await pool.query('INSERT INTO branch_active_history(branch_id, is_active, active_since) VALUES ($1,$2,$3)', [result.rows[0].id, isActive, activeSince]);
    res.status(201).json({ data: result.rows[0] });
  } catch (error) { if (error.code === '23503') return fail(res, 400, 'Ragione sociale inesistente.'); next(error); }
});

app.delete('/branches/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID filiale non valido.');
  try {
    const exists = await pool.query('SELECT id FROM branches WHERE id = $1', [id]);
    if (!exists.rowCount) return fail(res, 404, 'Filiale non trovata.');
    const devices = await pool.query('SELECT 1 FROM devices WHERE branch_id = $1 LIMIT 1', [id]);
    if (devices.rowCount) return fail(res, 409, 'La filiale ha dispositivi assegnati. Riassegna o disattiva i dispositivi prima di eliminarla.');
    const result = await pool.query('DELETE FROM branches WHERE id = $1 RETURNING id', [id]);
    if (!result.rowCount) return fail(res, 404, 'Filiale non trovata.');
    res.status(204).end();
  } catch (error) {
    if (error.code === '23503') return fail(res, 409, 'La filiale è collegata ad altri dati storici o amministrativi e non può essere eliminata.');
    next(error);
  }
});

app.get('/branches/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  try {
    const result = await pool.query('SELECT b.*, c.legal_name AS company_name FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.id = $1', [id]);
    if (!result.rowCount) return fail(res, 404, 'Filiale non trovata.');
    res.json({ data: result.rows[0] });
  } catch (error) { next(error); }
});

app.put('/branches/:id', requireRole('admin', 'technician'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  const fields = ['company_id', 'country', 'street', 'nomenclature', 'previous_nomenclature', 'network', 'phone_prefix', 'wlc', 'status', 'is_active', 'active_since'];
  const limits = { country: 100, street: 300, nomenclature: 100, previous_nomenclature: 100, network: 100, phone_prefix: 30, wlc: 200, status: 30, active_since: 10 };
  const updates = [];
  const values = [];
  for (const field of fields) {
    if (!Object.hasOwn(req.body || {}, field)) continue;
    let value = req.body[field];
    if (field === 'company_id') value = parseId(value);
    else if (field === 'is_active') { if (typeof value !== 'boolean') return fail(res, 400, 'Stato filiale non valido.'); }
    else value = cleanString(value, limits[field] || 100);
    if (value === undefined || (field === 'company_id' && !value)) return fail(res, 400, 'Campo non valido: ' + field);
    values.push(value);
    updates.push(field + ' = $' + values.length);
  }
  if (!updates.length) return fail(res, 400, 'Specificare almeno un campo.');
  values.push(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT b.company_id, b.is_active, b.active_since, c.legal_name AS company_name FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.id = $1 FOR UPDATE OF b', [id]);
    if (!before.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Filiale non trovata.'); }
    const oldCompanyId = String(before.rows[0].company_id);
    const oldCompanyName = before.rows[0].company_name;
    const result = await client.query('UPDATE branches SET ' + updates.join(', ') + ', updated_at = NOW() WHERE id = $' + values.length + ' RETURNING *', values);
    if (!result.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Filiale non trovata.'); }
    const newCompanyId = String(result.rows[0].company_id);
    if (before.rows[0].is_active !== result.rows[0].is_active || String(before.rows[0].active_since).slice(0,10) !== String(result.rows[0].active_since).slice(0,10)) {
      await client.query('INSERT INTO branch_active_history(branch_id, is_active, active_since) VALUES ($1,$2,$3)', [id, result.rows[0].is_active, result.rows[0].active_since]);
    }
    if (oldCompanyId !== newCompanyId) {
      const after = await client.query('SELECT legal_name FROM companies WHERE id = $1', [newCompanyId]);
      if (!after.rowCount) { await client.query('ROLLBACK'); return fail(res, 400, 'Ragione sociale inesistente.'); }
      await client.query('INSERT INTO branch_company_history(branch_id, from_company_id, from_company_name, to_company_id, to_company_name, changed_by) VALUES ($1,$2,$3,$4,$5,$6)', [id, oldCompanyId, oldCompanyName, newCompanyId, after.rows[0].legal_name, req.user.display_name || req.user.username]);
    }
    await client.query('COMMIT');
    const enriched = await pool.query('SELECT b.*, c.legal_name AS company_name FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.id = $1', [id]);
    res.json({ data: enriched.rows[0] });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.get('/branches/:id/company-history', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  try {
    const result = await pool.query('SELECT id, branch_id, from_company_name, to_company_name, changed_by, changed_at FROM branch_company_history WHERE branch_id = $1 ORDER BY changed_at DESC, id DESC', [id]);
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.delete('/branches/:id/company-history/:historyId', requireRole('admin', 'technician'), async (req, res, next) => {
  const branchId = parseId(req.params.id);
  const historyId = parseId(req.params.historyId);
  if (!branchId || !historyId) return fail(res, 400, 'ID non valido.');
  try {
    const result = await pool.query(
      'DELETE FROM branch_company_history WHERE id = $1 AND branch_id = $2 RETURNING id',
      [historyId, branchId]
    );
    if (!result.rowCount) return fail(res, 404, 'Voce dello storico non trovata.');
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/device-models', async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM device_models ORDER BY manufacturer, model_name');
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/device-models', requireRole('admin'), async (req, res, next) => {
 const manufacturer=cleanString(req.body?.manufacturer,120), modelName=cleanString(req.body?.model_name,160), category=cleanString(req.body?.category,100), sku=cleanString(req.body?.sku,100);
 const ownership=req.body?.ownership_type||'sale', cost=req.body?.default_purchase_cost===''?null:(req.body?.default_purchase_cost??null), fee=req.body?.default_monthly_fee===''?null:(req.body?.default_monthly_fee??null), notes=cleanString(req.body?.notes,10000);
 if(!manufacturer||!modelName||!category||[manufacturer,modelName,category,sku,notes].includes(undefined))return fail(res,400,'Produttore, modello e categoria sono obbligatori.');
 if(!['sale','rental'].includes(ownership))return fail(res,400,'Tipologia economica non valida.');
 if((cost!==null&&(!Number.isFinite(Number(cost))||Number(cost)<0))||(fee!==null&&(!Number.isFinite(Number(fee))||Number(fee)<0)))return fail(res,400,'Importi non validi.');
 try{const result=await pool.query('INSERT INTO device_models(manufacturer,model_name,category,sku,ownership_type,default_purchase_cost,default_monthly_fee,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[manufacturer,modelName,category,sku||null,ownership,cost,fee,notes]);res.status(201).json({data:result.rows[0]});}
 catch(error){if(error.code==='23505')return fail(res,409,'Modello o SKU già presente.');next(error);}
});

app.put('/device-models/:id', requireRole('admin'), async (req,res,next)=>{
 const id=parseId(req.params.id), manufacturer=cleanString(req.body?.manufacturer,120), modelName=cleanString(req.body?.model_name,160), category=cleanString(req.body?.category,100), sku=cleanString(req.body?.sku,100);
 const ownership=req.body?.ownership_type||'sale', cost=req.body?.default_purchase_cost===''?null:(req.body?.default_purchase_cost??null), fee=req.body?.default_monthly_fee===''?null:(req.body?.default_monthly_fee??null), notes=cleanString(req.body?.notes,10000);
 if(!id)return fail(res,400,'ID modello non valido.');
 if(!manufacturer||!modelName||!category||[manufacturer,modelName,category,sku,notes].includes(undefined))return fail(res,400,'Produttore, modello e categoria sono obbligatori.');
 if(!['sale','rental'].includes(ownership)||(cost!==null&&(!Number.isFinite(Number(cost))||Number(cost)<0))||(fee!==null&&(!Number.isFinite(Number(fee))||Number(fee)<0)))return fail(res,400,'Valori del modello non validi.');
 try{const result=await pool.query('UPDATE device_models SET manufacturer=$1,model_name=$2,category=$3,sku=$4,ownership_type=$5,default_purchase_cost=$6,default_monthly_fee=$7,notes=$8,updated_at=NOW() WHERE id=$9 RETURNING *',[manufacturer,modelName,category,sku||null,ownership,cost,fee,notes,id]);if(!result.rowCount)return fail(res,404,'Modello non trovato.');res.json({data:result.rows[0]});}
 catch(error){if(error.code==='23505')return fail(res,409,'Modello o SKU già presente.');next(error);}
});
app.get('/purchase-profiles', async (_req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT p.*, m.manufacturer, m.model_name FROM purchase_profiles p JOIN device_models m ON m.id = p.device_model_id ORDER BY p.purchased_on DESC NULLS LAST, p.created_at DESC'
    );
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/purchase-profiles', requireRole('admin'), async (req,res,next)=>{
 const modelId=parseId(req.body?.device_model_id), supplier=cleanString(req.body?.supplier,200), reference=cleanString(req.body?.reference,200), purchasedOn=req.body?.purchased_on||null;
 const unitCost=req.body?.unit_cost===''||req.body?.unit_cost===undefined?null:Number(req.body.unit_cost), monthlyFee=req.body?.monthly_fee===''||req.body?.monthly_fee===undefined?null:Number(req.body.monthly_fee);
 const quantity=Number(req.body?.quantity??1), stockLocationId=req.body?.stock_location_id?parseId(req.body.stock_location_id):null, notes=cleanString(req.body?.notes,10000);
 if(!modelId||[supplier,reference,notes].includes(undefined)||!Number.isInteger(quantity)||quantity<1||quantity>100000)return fail(res,400,'Modello, quantità o campi non validi.');
 if((unitCost!==null&&(!Number.isFinite(unitCost)||unitCost<0))||(monthlyFee!==null&&(!Number.isFinite(monthlyFee)||monthlyFee<0)))return fail(res,400,'Valori economici non validi.');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const result=await client.query('INSERT INTO purchase_profiles(device_model_id,supplier,reference,purchased_on,unit_cost,monthly_fee,quantity,stock_location_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[modelId,supplier,reference,purchasedOn,unitCost,monthlyFee,quantity,stockLocationId,notes]);
  if(stockLocationId){
   await client.query('INSERT INTO product_stock(device_model_id,stock_location_id,quantity) VALUES($1,$2,$3) ON CONFLICT(device_model_id,stock_location_id) DO UPDATE SET quantity=product_stock.quantity+EXCLUDED.quantity,updated_at=NOW()',[modelId,stockLocationId,quantity]);
   await client.query("INSERT INTO product_stock_movements(device_model_id,stock_location_id,quantity_delta,movement_type,purchase_profile_id,notes,moved_by) VALUES($1,$2,$3,'order',$4,$5,$6)",[modelId,stockLocationId,quantity,result.rows[0].id,'Carico ordine '+(reference||result.rows[0].id),req.user.id]);
  }
  await client.query('COMMIT');res.status(201).json({data:result.rows[0]});
 }catch(error){await client.query('ROLLBACK');if(error.code==='23503')return fail(res,400,'Modello o magazzino inesistente.');next(error);}finally{client.release();}
});
app.put('/purchase-profiles/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  const supplier = cleanString(req.body?.supplier, 200);
  const reference = cleanString(req.body?.reference, 200);
  const purchasedOn = req.body?.purchased_on || null;
  const unitCost = req.body?.unit_cost === '' || req.body?.unit_cost === undefined ? null : Number(req.body.unit_cost);
  const quantity = Number(req.body?.quantity);
  const notes = cleanString(req.body?.notes, 10000);
  const stockLocationId = req.body?.stock_location_id === null || req.body?.stock_location_id === '' ? null : parseId(req.body?.stock_location_id);
  if (!id || [supplier, reference, notes].includes(undefined) || (req.body?.stock_location_id && !stockLocationId) || !Number.isInteger(quantity) || quantity < 0 || quantity > 100000) return fail(res, 400, 'Ordine, quantità o campi non validi.');
  if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) return fail(res, 400, 'Il costo unitario deve essere un importo valido e non negativo.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM purchase_profiles WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Ordine non trovato.'); }
    const order = found.rows[0];
    const oldQuantity = Number(order.quantity || 0);
    const reduction = oldQuantity - quantity;

    const linked = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE branch_id IS NOT NULL OR status NOT IN ('in_stock','to_activate') OR stock_consumed = TRUE)::int AS used_count,
         COUNT(*) FILTER (WHERE branch_id IS NULL AND status IN ('in_stock','to_activate') AND stock_consumed IS NOT TRUE
           AND (stock_location_id = $2 OR stock_location_id IS NULL))::int AS available_count
       FROM devices WHERE purchase_profile_id = $1`,
      [id, order.stock_location_id]
    );
    const usedCount = Number(linked.rows[0].used_count || 0);
    const availableCount = Number(linked.rows[0].available_count || 0);

    if (quantity < usedCount) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'La quantità non può essere inferiore ai device già assegnati o utilizzati (' + usedCount + ').');
    }
    if (availableCount > oldQuantity) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Ordine non modificato: i device fisici associati superano la quantità registrata. Verificare prima la coerenza del magazzino.');
    }
    if (quantity === 0 && usedCount > 0) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Impossibile azzerare l’ordine: ci sono device associati già assegnati o utilizzati.');
    }

    const newLocationId = stockLocationId;
    const locationChanged = String(order.stock_location_id || '') !== String(newLocationId || '');
    if (locationChanged) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Per sicurezza, modifica prima la quantità dell’ordine; lo spostamento di magazzino va eseguito separatamente.');
    }

    if (reduction > 0 && order.stock_location_id) {
      const stock = await client.query(
        'SELECT quantity FROM product_stock WHERE device_model_id = $1 AND stock_location_id = $2 FOR UPDATE',
        [order.device_model_id, order.stock_location_id]
      );
      const stockQuantity = Number(stock.rows[0]?.quantity || 0);
      if (stockQuantity < reduction) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'Impossibile ridurre la quantità: la giacenza disponibile nel magazzino non è sufficiente. Nessuna modifica eseguita.');
      }

      const devicesToRemove = quantity === 0 ? availableCount : Math.min(reduction, availableCount);
      if (devicesToRemove > 0) {
        await client.query(
          `DELETE FROM devices WHERE id IN (
             SELECT id FROM devices
             WHERE purchase_profile_id = $1 AND branch_id IS NULL
               AND status IN ('in_stock','to_activate') AND stock_consumed IS NOT TRUE
               AND (stock_location_id = $2 OR stock_location_id IS NULL)
             ORDER BY id DESC LIMIT $3 FOR UPDATE
           )`,
          [id, order.stock_location_id, devicesToRemove]
        );
      }
      await client.query(
        'UPDATE product_stock SET quantity = quantity - $1, updated_at = NOW() WHERE device_model_id = $2 AND stock_location_id = $3',
        [reduction, order.device_model_id, order.stock_location_id]
      );
      await client.query(
        "INSERT INTO product_stock_movements(device_model_id, stock_location_id, quantity_delta, movement_type, purchase_profile_id, notes, moved_by) VALUES ($1,$2,$3,'adjustment',$4,$5,$6)",
        [order.device_model_id, order.stock_location_id, -reduction, 'Riduzione quantità ordine ' + (reference || order.reference || id), req.user.id]
      );
    } else if (reduction > 0 && !order.stock_location_id) {
      if (quantity === 0 && availableCount > 0) {
        await client.query(
          `DELETE FROM devices WHERE id IN (
             SELECT id FROM devices WHERE purchase_profile_id = $1 AND branch_id IS NULL
               AND status IN ('in_stock','to_activate') AND stock_consumed IS NOT TRUE
             ORDER BY id DESC LIMIT $2 FOR UPDATE
           )`,
          [id, availableCount]
        );
      }
    } else if (quantity > oldQuantity && order.stock_location_id) {
      const increase = quantity - oldQuantity;
      await client.query(
        'INSERT INTO product_stock(device_model_id, stock_location_id, quantity) VALUES ($1,$2,$3) ON CONFLICT(device_model_id, stock_location_id) DO UPDATE SET quantity = product_stock.quantity + EXCLUDED.quantity, updated_at = NOW()',
        [order.device_model_id, order.stock_location_id, increase]
      );
      await client.query(
        "INSERT INTO product_stock_movements(device_model_id, stock_location_id, quantity_delta, movement_type, purchase_profile_id, notes, moved_by) VALUES ($1,$2,$3,'adjustment',$4,$5,$6)",
        [order.device_model_id, order.stock_location_id, increase, id, 'Aumento quantità ordine ' + (reference || order.reference || id), req.user.id]
      );
    }

    if (quantity === 0) {
      await client.query(
        "UPDATE product_stock_movements SET purchase_profile_id = NULL, notes = CONCAT(COALESCE(notes, ''), $1) WHERE purchase_profile_id = $2",
        [' [ordine azzerato ed eliminato #' + id + (reference || order.reference ? ' · ' + (reference || order.reference) : '') + ']', id]
      );
      await client.query('DELETE FROM purchase_profiles WHERE id = $1', [id]);
      await client.query('COMMIT');
      return res.status(204).end();
    }

    const result = await client.query(
      'UPDATE purchase_profiles SET supplier = $1, reference = $2, purchased_on = $3, unit_cost = $4, quantity = $5, stock_location_id = $6, notes = $7 WHERE id = $8 RETURNING *',
      [supplier, reference, purchasedOn, unitCost, quantity, newLocationId, notes, id]
    );
    await client.query('COMMIT');
    res.json({ data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23503') return fail(res, 409, 'Operazione non consentita: il device o l’ordine è ancora collegato ad altri dati.');
    console.error('Failed to update hardware purchase order', { orderId: id, code: error.code, message: error.message });
    return fail(res, 500, 'Errore durante la modifica dell’ordine hardware. L’operazione è stata annullata.');
  } finally { client.release(); }
});

app.delete('/purchase-profiles/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID ordine non valido.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM purchase_profiles WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Ordine non trovato.');
    }
    const order = found.rows[0];
    const linkedDevices = await client.query(
      "SELECT COUNT(*) FILTER (WHERE branch_id IS NOT NULL OR status NOT IN ('in_stock','to_activate'))::int AS used_count, COUNT(*) FILTER (WHERE branch_id IS NULL AND status IN ('in_stock','to_activate') AND (stock_location_id = $2 OR stock_location_id IS NULL))::int AS warehouse_count FROM devices WHERE purchase_profile_id = $1",
      [id, order.stock_location_id]
    );
    if (linkedDevices.rows[0].used_count > 0) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Impossibile eliminare l’ordine: almeno un device collegato è assegnato a una filiale o non è più disponibile a magazzino.');
    }
    const warehouseDeviceCount = Number(linkedDevices.rows[0].warehouse_count || 0);
    await client.query('UPDATE devices SET purchase_profile_id = NULL WHERE purchase_profile_id = $1', [id]);
    if (order.stock_location_id && Number(order.quantity || 0) > 0) {
      const currentStock = await client.query(
        'SELECT quantity FROM product_stock WHERE device_model_id = $1 AND stock_location_id = $2 FOR UPDATE',
        [order.device_model_id, order.stock_location_id]
      );
      // Keep the stock quantity needed to represent the physical devices that remain
      // in this warehouse; reverse only the untracked remainder of the order.
      const untrackedOrderQuantity = Math.max(0, Number(order.quantity) - warehouseDeviceCount);
      const availableToReverse = Math.min(untrackedOrderQuantity, Number(currentStock.rows[0]?.quantity || 0));
      if (availableToReverse > 0) {
        await client.query(
          'UPDATE product_stock SET quantity = quantity - $1, updated_at = NOW() WHERE device_model_id = $2 AND stock_location_id = $3',
          [availableToReverse, order.device_model_id, order.stock_location_id]
        );
        await client.query(
          "INSERT INTO product_stock_movements(device_model_id, stock_location_id, quantity_delta, movement_type, notes, moved_by) VALUES ($1,$2,$3,'adjustment',$4,$5)",
          [order.device_model_id, order.stock_location_id, -availableToReverse, 'Storno giacenza residua ordine eliminato #' + id + (order.reference ? ' · ' + order.reference : ''), req.user.id]
        );
      }
      await client.query(
        "UPDATE product_stock_movements SET purchase_profile_id = NULL, notes = CONCAT(COALESCE(notes, ''), $1) WHERE purchase_profile_id = $2",
        [' [ordine eliminato #' + id + (order.reference ? ' · ' + order.reference : '') + ']', id]
      );
    } else {
      await client.query(
        "UPDATE product_stock_movements SET purchase_profile_id = NULL, notes = CONCAT(COALESCE(notes, ''), $1) WHERE purchase_profile_id = $2",
        [' [ordine eliminato #' + id + (order.reference ? ' · ' + order.reference : '') + ']', id]
      );
    }
    await client.query('DELETE FROM purchase_profiles WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23503') return fail(res, 409, 'Impossibile eliminare l’ordine perché è ancora collegato ad altri dati. Verifica che non ci siano device o movimenti che lo utilizzano.');
    console.error('Failed to delete hardware purchase order', { orderId: id, code: error.code, message: error.message });
    return fail(res, 500, 'Errore durante l’eliminazione dell’ordine hardware. L’operazione è stata annullata e nessun dato è stato eliminato.');
  } finally {
    client.release();
  }
});

app.get('/devices/:id/fault-events', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID dispositivo non valido.');
  try {
    const result = await pool.query(
      `SELECT f.*, b.nomenclature AS branch_nomenclature, c.legal_name AS company_name,
        rd.serial_number AS replacement_serial, rm.model_name AS replacement_model
       FROM device_fault_events f
       LEFT JOIN branches b ON b.id = f.branch_id
       LEFT JOIN companies c ON c.id = b.company_id
       LEFT JOIN devices rd ON rd.id = f.replacement_device_id
       LEFT JOIN device_models rm ON rm.id = rd.model_id
       WHERE f.device_id = $1 ORDER BY f.fault_date DESC, f.id DESC`, [id]);
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/devices/:id/fault-events', requireRole('admin', 'technician', 'warehouse'), async (req, res, next) => {
  const deviceId = parseId(req.params.id);
  const faultDate = req.body?.fault_date || new Date().toISOString().slice(0, 10);
  const description = cleanString(req.body?.description, 10000);
  const outcome = req.body?.outcome || 'pending';
  const rmaNumber = cleanString(req.body?.rma_number, 120);
  const rmaStatus = cleanString(req.body?.rma_status, 40);
  let replacementId = req.body?.replacement_device_id ? parseId(req.body.replacement_device_id) : null;
  const replacementStockModelId = req.body?.replacement_stock_model_id ? parseId(req.body.replacement_stock_model_id) : null;
  const replacementLocationId = req.body?.replacement_stock_location_id ? parseId(req.body.replacement_stock_location_id) : null;
  const additionalCost = Number(req.body?.additional_cost || 0);
  const costDescription = cleanString(req.body?.cost_description, 300);
  const notes = cleanString(req.body?.notes, 10000);
  if (!deviceId || !/^\d{4}-\d{2}-\d{2}$/.test(faultDate) || !description || [rmaNumber, rmaStatus, costDescription, notes].includes(undefined)) return fail(res, 400, 'Data, descrizione o campi non validi.');
  if (!['pending','rma','sci','resolved'].includes(outcome) || !Number.isFinite(additionalCost) || additionalCost < 0) return fail(res, 400, 'Esito o costo aggiuntivo non valido.');
  if (req.body?.replacement_device_id && !replacementId) return fail(res, 400, 'Device sostitutivo non valido.');
  if (req.body?.replacement_stock_model_id && !replacementStockModelId) return fail(res, 400, 'Modello di magazzino non valido.');
  if (replacementStockModelId && (!replacementLocationId || outcome === 'sci')) return fail(res, 400, 'Per prelevare un sostitutivo seleziona un magazzino e un esito diverso da SCI.');
  if (req.body?.replacement_stock_location_id && !replacementLocationId) return fail(res, 400, 'Magazzino sostitutivo non valido.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const original = await client.query('SELECT d.*, m.default_purchase_cost, m.default_monthly_fee FROM devices d JOIN device_models m ON m.id=d.model_id WHERE d.id=$1 FOR UPDATE OF d', [deviceId]);
    if (!original.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Dispositivo non trovato.'); }
    let replacementHardwareCost = 0;
    if (replacementStockModelId) {
      if (original.rows[0].ownership_type !== 'rental') { await client.query('ROLLBACK'); return fail(res, 400, 'Il prelievo da giacenza per il costo hardware è previsto per device NOL.'); }
      if (String(replacementStockModelId) !== String(original.rows[0].model_id)) { await client.query('ROLLBACK'); return fail(res, 409, 'Il materiale sostitutivo deve essere dello stesso modello del device guasto.'); }
    }
    if (replacementStockModelId) {
      const stock = await client.query('SELECT ps.quantity, COALESCE((SELECT SUM(COALESCE(pp.unit_cost,0)*pp.quantity)/NULLIF(SUM(pp.quantity),0) FROM purchase_profiles pp WHERE pp.device_model_id=ps.device_model_id AND pp.stock_location_id=ps.stock_location_id), dm.default_purchase_cost, 0)::numeric AS unit_cost FROM product_stock ps JOIN device_models dm ON dm.id=ps.device_model_id WHERE ps.device_model_id=$1 AND ps.stock_location_id=$2 FOR UPDATE OF ps', [replacementStockModelId, replacementLocationId]);
      if (!stock.rowCount || Number(stock.rows[0].quantity) < 1) { await client.query('ROLLBACK'); return fail(res, 409, 'Nessuna giacenza disponibile nel magazzino selezionato.'); }
      replacementHardwareCost = Number(stock.rows[0].unit_cost || 0);
      await client.query('UPDATE product_stock SET quantity=quantity-1, updated_at=NOW() WHERE device_model_id=$1 AND stock_location_id=$2', [replacementStockModelId, replacementLocationId]);
      await client.query("INSERT INTO product_stock_movements(device_model_id,stock_location_id,quantity_delta,movement_type,notes,moved_by) VALUES($1,$2,-1,'activation',$3,$4)", [replacementStockModelId, replacementLocationId, 'Sostituzione device guasto #' + deviceId, req.user.id]);
      const replacement = await client.query("INSERT INTO devices(model_id,branch_id,stock_location_id,status,ownership_type,purchase_cost,monthly_fee,stock_consumed,notes) VALUES($1,$2,$3,'to_activate','rental',$4,$5,TRUE,$6) RETURNING id", [replacementStockModelId, original.rows[0].branch_id, replacementLocationId, replacementHardwareCost, original.rows[0].monthly_fee ?? original.rows[0].default_monthly_fee ?? null, 'Sostitutivo da magazzino per guasto device #' + deviceId]);
      replacementId = replacement.rows[0].id;
    }
    if (replacementId && !replacementStockModelId) {
      const replacement = await client.query(
        'SELECT d.*, dm.default_purchase_cost, pp.unit_cost AS profile_unit_cost FROM devices d JOIN device_models dm ON dm.id=d.model_id LEFT JOIN purchase_profiles pp ON pp.id=d.purchase_profile_id WHERE d.id=$1 FOR UPDATE OF d',
        [replacementId]
      );
      if (!replacement.rowCount || !['in_stock', 'to_activate'].includes(replacement.rows[0].status) || replacement.rows[0].branch_id || replacement.rows[0].stock_consumed === true) {
        await client.query('ROLLBACK'); return fail(res, 409, 'Il sostitutivo selezionato non è più disponibile a magazzino.');
      }
      if (!replacementLocationId || String(replacement.rows[0].stock_location_id || '') !== String(replacementLocationId)) {
        await client.query('ROLLBACK'); return fail(res, 409, 'Il sostitutivo non appartiene al magazzino selezionato.');
      }
      replacementHardwareCost = Number(replacement.rows[0].purchase_cost || replacement.rows[0].profile_unit_cost || replacement.rows[0].default_purchase_cost || 0);
      const stock = await client.query(
        'UPDATE product_stock SET quantity=quantity-1, updated_at=NOW() WHERE device_model_id=$1 AND stock_location_id=$2 AND quantity > 0 RETURNING quantity',
        [replacement.rows[0].model_id, replacementLocationId]
      );
      if (!stock.rowCount) {
        await client.query('ROLLBACK'); return fail(res, 409, 'La giacenza del modello selezionato è esaurita o non è sincronizzata con i device censiti.');
      }
      await client.query(
        "INSERT INTO product_stock_movements(device_model_id,stock_location_id,quantity_delta,movement_type,device_id,notes,moved_by) VALUES($1,$2,-1,'activation',$3,$4,$5)",
        [replacement.rows[0].model_id, replacementLocationId, replacementId, 'Sostituzione device guasto #' + deviceId, req.user.id]
      );
      await client.query(
        "UPDATE devices SET branch_id=$1, status='to_activate', stock_consumed=TRUE, updated_at=NOW() WHERE id=$2",
        [original.rows[0].branch_id, replacementId]
      );
    }
    const inserted = await client.query(
      `INSERT INTO device_fault_events(device_id,branch_id,fault_date,description,outcome,rma_number,rma_status,replacement_device_id,replacement_stock_location_id,additional_cost,cost_description,notes,created_by,status,closed_at,replacement_hardware_cost)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CASE WHEN $14='closed' THEN NOW() ELSE NULL END,$15) RETURNING *`,
      [deviceId, original.rows[0].branch_id, faultDate, description, outcome, rmaNumber, rmaStatus, replacementId, replacementLocationId, additionalCost, costDescription, notes, req.user.id, (outcome === 'resolved' || outcome === 'sci') ? 'closed' : 'open', replacementHardwareCost]);
    await client.query("UPDATE devices SET status=$1, updated_at=NOW() WHERE id=$2", [outcome === 'sci' ? 'decommissioned' : (outcome === 'resolved' ? 'operational' : 'fault'), deviceId]);
    await client.query('COMMIT');
    res.status(201).json({ data: inserted.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23503') return fail(res, 400, 'Filiale, device o magazzino non valido.');
    next(error);
  } finally { client.release(); }
});

app.put('/device-fault-events/:id', requireRole('admin', 'technician', 'warehouse'), async (req, res, next) => {
  const id = parseId(req.params.id);
  const faultDate = req.body?.fault_date;
  const description = cleanString(req.body?.description, 10000);
  const outcome = req.body?.outcome;
  const rmaNumber = cleanString(req.body?.rma_number, 120);
  const rmaStatus = cleanString(req.body?.rma_status, 40);
  const replacementId = req.body?.replacement_device_id ? parseId(req.body.replacement_device_id) : null;
  const replacementLocationId = req.body?.replacement_stock_location_id ? parseId(req.body.replacement_stock_location_id) : null;
  const additionalCost = Number(req.body?.additional_cost || 0);
  const costDescription = cleanString(req.body?.cost_description, 300);
  const notes = cleanString(req.body?.notes, 10000);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(String(faultDate || '')) || !description || [rmaNumber,rmaStatus,costDescription,notes].includes(undefined)) return fail(res, 400, 'Data, descrizione o campi non validi.');
  if (!['pending','rma','sci','resolved'].includes(outcome) || !Number.isFinite(additionalCost) || additionalCost < 0) return fail(res, 400, 'Esito o costo aggiuntivo non valido.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM device_fault_events WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Evento guasto non trovato.'); }
    const event = found.rows[0];
    if (replacementId) {
      const replacement = await client.query('SELECT * FROM devices WHERE id=$1 FOR UPDATE', [replacementId]);
      if (!replacement.rowCount || String(replacement.rows[0].model_id) !== String((await client.query('SELECT model_id FROM devices WHERE id=$1',[event.device_id])).rows[0].model_id)) {
        await client.query('ROLLBACK'); return fail(res, 409, 'Il sostitutivo deve essere dello stesso modello.');
      }
      if (String(event.replacement_device_id || '') !== String(replacementId) && replacement.rows[0].status !== 'in_stock') {
        await client.query('ROLLBACK'); return fail(res, 409, 'Il nuovo sostitutivo deve essere a magazzino.');
      }
      await client.query("UPDATE devices SET branch_id=$1, status='to_activate', updated_at=NOW() WHERE id=$2", [event.branch_id, replacementId]);
    }
    const result = await client.query(
      `UPDATE device_fault_events SET fault_date=$1,description=$2,outcome=$3,rma_number=$4,rma_status=$5,replacement_device_id=$6,replacement_stock_location_id=$7,additional_cost=$8,cost_description=$9,notes=$10,status=$11,closed_at=CASE WHEN $11='closed' THEN COALESCE(closed_at,NOW()) ELSE NULL END,updated_at=NOW() WHERE id=$12 RETURNING *`,
      [faultDate,description,outcome,rmaNumber,rmaStatus,replacementId,replacementLocationId,additionalCost,costDescription,notes,outcome === 'resolved' || outcome === 'sci' ? 'closed' : 'open',id]);
    await client.query("UPDATE devices SET status=$1, updated_at=NOW() WHERE id=$2", [outcome === 'sci' ? 'decommissioned' : (outcome === 'resolved' ? 'operational' : 'fault'), event.device_id]);
    await client.query('COMMIT');
    res.json({ data: result.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); if (error.code === '23503') return fail(res, 400, 'Riferimento device o magazzino non valido.'); next(error); }
  finally { client.release(); }
});

app.get('/devices', async (req, res, next) => {
  const filter = queryBranch(req);
  if (filter.error) return fail(res, 400, filter.error);
  try {
    const result = await pool.query(
      'SELECT d.*, m.manufacturer, m.model_name, m.category, m.sku, b.nomenclature AS branch_nomenclature, c.legal_name AS company_name, sl.name AS stock_location FROM devices d JOIN device_models m ON m.id = d.model_id LEFT JOIN branches b ON b.id = d.branch_id LEFT JOIN companies c ON c.id = b.company_id LEFT JOIN stock_locations sl ON sl.id = d.stock_location_id WHERE ($1::bigint IS NULL OR d.branch_id = $1) ORDER BY m.manufacturer, m.model_name, d.id DESC',
      [filter.id]
    );
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

// Reconcile available stock once when a warehouse-sourced device becomes operational at a branch.
async function consumeDeviceStock(client, device, branchId, status, userId) {
  if (!branchId || status !== 'operational' || !device.stock_location_id || device.stock_consumed) return false;
  const stock = await client.query(
    'UPDATE product_stock SET quantity = quantity - 1, updated_at = NOW() WHERE device_model_id = $1 AND stock_location_id = $2 AND quantity > 0 RETURNING quantity',
    [device.model_id, device.stock_location_id]
  );
  if (!stock.rowCount) {
    const error = new Error('Quantità disponibile insufficiente nel magazzino selezionato.');
    error.code = 'STOCK_UNAVAILABLE';
    throw error;
  }
  await client.query(
    "INSERT INTO product_stock_movements(device_model_id,stock_location_id,quantity_delta,movement_type,device_id,notes,moved_by) VALUES($1,$2,-1,'activation',$3,$4,$5)",
    [device.model_id, device.stock_location_id, device.id, 'Attivazione presso filiale ' + branchId, userId]
  );
  await client.query('UPDATE devices SET stock_consumed = TRUE WHERE id = $1', [device.id]);
  return true;
}

app.post('/devices', requireRole('admin', 'technician', 'warehouse'), async (req, res, next) => {
  const modelId = parseId(req.body?.model_id);
  const branchId = req.body?.branch_id ? parseId(req.body.branch_id) : null;
  const stockLocationId = req.body?.stock_location_id ? parseId(req.body.stock_location_id) : null;
  const purchaseProfileId = req.body?.purchase_profile_id ? parseId(req.body.purchase_profile_id) : null;
  const assetTag = cleanString(req.body?.asset_tag, 100);
  const serial = cleanString(req.body?.serial_number, 200);
  const status = req.body?.status || 'to_activate';
  const ownership = req.body?.ownership_type || 'sale';
  const cost = req.body?.purchase_cost ?? null;
  const fee = req.body?.monthly_fee ?? null;
  const purchased = req.body?.purchased_on || null;
  const installed = req.body?.installed_on || req.body?.activated_on || null;
  const activated = req.body?.activated_on || installed;
  const notes = cleanString(req.body?.notes, 10000);
  if (!modelId || [assetTag, serial, notes].includes(undefined)) return fail(res, 400, 'Modello o campi non validi.');
  if (!['to_activate', 'operational', 'fault', 'decommissioned', 'in_stock'].includes(status)) return fail(res, 400, 'Stato dispositivo non valido.');
  if (!['sale', 'rental'].includes(ownership)) return fail(res, 400, 'Tipologia economica non valida.');
  if ((cost !== null && (!Number.isFinite(Number(cost)) || Number(cost) < 0)) || (fee !== null && (!Number.isFinite(Number(fee)) || Number(fee) < 0))) return fail(res, 400, 'Importi non validi.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'INSERT INTO devices(model_id, branch_id, stock_location_id, purchase_profile_id, asset_tag, serial_number, status, ownership_type, purchase_cost, monthly_fee, purchased_on, activated_on, installed_on, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4::bigint IS NOT NULL THEN (SELECT unit_cost FROM purchase_profiles WHERE id=$4) ELSE $9 END,$10,$11,$12,$13,$14) RETURNING *',
      [modelId, branchId, stockLocationId, purchaseProfileId, assetTag, serial, status, ownership, cost, fee, purchased, activated, installed, notes]
    );
    await consumeDeviceStock(client, result.rows[0], branchId, status, req.user.id);
    // A manually censused physical device is not part of an order's aggregate
    // quantity. Add it to the stock ledger so warehouse quantities and fault
    // replacement availability stay in sync. Order-linked devices are already
    // represented by the quantity loaded when the purchase order was recorded.
    if (!purchaseProfileId && !branchId && ['in_stock', 'to_activate'].includes(status) && stockLocationId) {
      await client.query(
        'INSERT INTO product_stock(device_model_id, stock_location_id, quantity) VALUES ($1,$2,1) ON CONFLICT(device_model_id, stock_location_id) DO UPDATE SET quantity = product_stock.quantity + 1, updated_at = NOW()',
        [modelId, stockLocationId]
      );
      await client.query(
        "INSERT INTO product_stock_movements(device_model_id, stock_location_id, quantity_delta, movement_type, device_id, notes, moved_by) VALUES ($1,$2,1,'adjustment',$3,$4,$5)",
        [modelId, stockLocationId, result.rows[0].id, 'Carico device censito manualmente #' + result.rows[0].id, req.user.id]
      );
    }
    const saved = await client.query('SELECT * FROM devices WHERE id = $1', [result.rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({ data: saved.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return fail(res, 409, 'Asset tag già presente.');
    if (error.code === '23503') return fail(res, 400, 'Modello, filiale o magazzino non valido.');
    if (error.code === 'STOCK_UNAVAILABLE') return fail(res, 409, error.message);
    next(error);
  } finally { client.release(); }
});

app.post('/devices/bulk-status', requireRole('admin', 'technician', 'warehouse'), async (req, res, next) => {
  const status = req.body?.status;
  const rawBranchIds = Array.isArray(req.body?.branch_ids) ? req.body.branch_ids : [];
  const branchIds = [...new Set(rawBranchIds.map(parseId))];
  if (status !== 'to_activate') return fail(res, 400, 'Stato massivo non consentito.');
  if (branchIds.some((id) => !id)) return fail(res, 400, 'Una o più filiali selezionate non sono valide.');
  try {
    const result = branchIds.length
      ? await pool.query(
        "UPDATE devices SET status = 'to_activate', updated_at = NOW() WHERE status = 'operational' AND branch_id = ANY($1::bigint[]) RETURNING id",
        [branchIds]
      )
      : await pool.query(
        "UPDATE devices SET status = 'to_activate', updated_at = NOW() WHERE status = 'operational' AND branch_id IS NOT NULL RETURNING id"
      );
    res.json({ updated_count: result.rowCount });
  } catch (error) { next(error); }
});

app.post('/devices/bulk-update', requireRole('admin', 'technician', 'warehouse'), async (req, res, next) => {
  const field = req.body?.field;
  const rawValue = req.body?.value;
  const rawBranchIds = Array.isArray(req.body?.branch_ids) ? req.body.branch_ids : [];
  const branchIds = [...new Set(rawBranchIds.map(parseId))];
  const allowedFields = ['activated_on', 'status', 'purchase_profile_id', 'stock_location_id'];
  if (!allowedFields.includes(field)) return fail(res, 400, 'Campo non consentito per la modifica massiva.');
  if (branchIds.some((id) => !id)) return fail(res, 400, 'Una o più filiali selezionate non sono valide.');

  let value = rawValue;
  if (field === 'activated_on') {
    if (value === '' || value === null || value === undefined) value = null;
    else if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      return fail(res, 400, 'La data di attivazione non è valida.');
    }
  } else if (field === 'status') {
    if (!['in_stock', 'to_activate', 'operational', 'fault', 'decommissioned'].includes(value)) return fail(res, 400, 'Stato dispositivo non valido.');
  } else {
    value = value === '' || value === null || value === undefined ? null : parseId(value);
    if (rawValue !== '' && rawValue !== null && rawValue !== undefined && !value) return fail(res, 400, 'Ordine o magazzino non valido.');
  }

  const assignments = field === 'activated_on'
    ? 'activated_on = $1, installed_on = $1'
    : field + ' = $1';
  const values = [value, branchIds.length ? branchIds : null];
  const where = 'branch_id IS NOT NULL AND ($2::bigint[] IS NULL OR branch_id = ANY($2::bigint[]))';
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const selected = await client.query('SELECT * FROM devices WHERE branch_id IS NOT NULL AND ($1::bigint[] IS NULL OR branch_id = ANY($1::bigint[])) FOR UPDATE', [branchIds.length ? branchIds : null]);
    const result = await client.query('UPDATE devices SET ' + assignments + ', updated_at = NOW() WHERE ' + where + ' RETURNING id', values);
    if (field === 'status' && value === 'operational') {
      for (const device of selected.rows) {
        await consumeDeviceStock(client, { ...device, status: 'operational' }, device.branch_id, 'operational', req.user.id);
      }
    }
    await client.query('COMMIT');
    res.json({ updated_count: result.rowCount });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23503') return fail(res, 400, 'Ordine di provenienza o magazzino non valido.');
    if (error.code === 'STOCK_UNAVAILABLE') return fail(res, 409, error.message);
    next(error);
  } finally { client.release(); }
});

app.put('/devices/:id', requireRole('admin', 'technician', 'warehouse'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  const allowed = ['model_id', 'branch_id', 'stock_location_id', 'purchase_profile_id', 'asset_tag', 'serial_number', 'status', 'ownership_type', 'purchase_cost', 'monthly_fee', 'purchased_on', 'activated_on', 'installed_on', 'notes'];
  const limits = { asset_tag: 100, serial_number: 200, status: 30, ownership_type: 20, notes: 10000 };
  const values = [];
  const assignments = [];
  for (const field of allowed) {
    if (!Object.hasOwn(req.body || {}, field)) continue;
    let value = req.body[field];
    if (['model_id', 'branch_id', 'stock_location_id', 'purchase_profile_id'].includes(field)) value = value === null || value === '' ? null : parseId(value);
    else if (['purchase_cost', 'monthly_fee'].includes(field)) value = value === null || value === '' ? null : Number(value);
    else if (['purchased_on', 'activated_on', 'installed_on'].includes(field)) value = value || null;
    else value = cleanString(value, limits[field] || 200);
    if (value === undefined || (['purchase_cost', 'monthly_fee'].includes(field) && value !== null && (!Number.isFinite(value) || value < 0))) return fail(res, 400, 'Campo non valido: ' + field);
    values.push(value);
    assignments.push(field + ' = $' + values.length);
  }
  if (!assignments.length) return fail(res, 400, 'Specificare almeno un campo.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM devices WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Dispositivo non trovato.'); }
    values.push(id);
    await client.query('UPDATE devices SET ' + assignments.join(', ') + ', updated_at = NOW() WHERE id = $' + values.length, values);
    const current = await client.query('SELECT * FROM devices WHERE id = $1', [id]);
    await consumeDeviceStock(client, current.rows[0], current.rows[0].branch_id, current.rows[0].status, req.user.id);
    const saved = await client.query('SELECT * FROM devices WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ data: saved.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return fail(res, 409, 'Asset tag già presente.');
    if (error.code === 'STOCK_UNAVAILABLE') return fail(res, 409, error.message);
    next(error);
  } finally { client.release(); }
});

app.delete('/devices/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID dispositivo non valido.');
  try {
    const result = await pool.query('DELETE FROM devices WHERE id = $1 RETURNING id', [id]);
    if (!result.rowCount) return fail(res, 404, 'Dispositivo non trovato.');
    res.status(204).end();
  } catch (error) {
    if (error.code === '23503') return fail(res, 409, 'Il dispositivo è collegato a registrazioni che ne impediscono l’eliminazione. Rimuovi o correggi prima i riferimenti collegati.');
    next(error);
  }
});

app.get('/stock/locations', async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT sl.*, COUNT(d.id)::int AS device_count FROM stock_locations sl LEFT JOIN devices d ON d.stock_location_id = sl.id GROUP BY sl.id ORDER BY sl.name');
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/stock/locations', requireRole('admin', 'warehouse'), async (req, res, next) => {
  const name = cleanString(req.body?.name, 160);
  const address = cleanString(req.body?.address, 300);
  if (!name || address === undefined) return fail(res, 400, 'Il nome del magazzino è obbligatorio.');
  try {
    const result = await pool.query('INSERT INTO stock_locations(name, address) VALUES ($1,$2) RETURNING *', [name, address]);
    res.status(201).json({ data: result.rows[0] });
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Magazzino già presente.'); next(error); }
});

app.put('/stock/locations/:id', requireRole('admin', 'warehouse'), async (req, res, next) => {
  const id = parseId(req.params.id);
  const name = cleanString(req.body?.name, 160);
  const address = cleanString(req.body?.address, 300);
  if (!id) return fail(res, 400, 'ID magazzino non valido.');
  if (!name || address === undefined) return fail(res, 400, 'Il nome del magazzino è obbligatorio.');
  try {
    const result = await pool.query('UPDATE stock_locations SET name = $1, address = $2 WHERE id = $3 RETURNING *', [name, address, id]);
    if (!result.rowCount) return fail(res, 404, 'Magazzino non trovato.');
    res.json({ data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'Esiste già un magazzino con questo nome.');
    next(error);
  }
});

async function syncLicenseOrderCharge(db, order) {
  const startsOn = order.ea_starts_on || '2026-10-01';
  const start = new Date(String(startsOn).slice(0, 10) + 'T00:00:00Z');
  const end = order.renewal_on ? new Date(String(order.renewal_on).slice(0, 10) + 'T00:00:00Z') : null;
  const durationMonths = end && end >= start
    ? Math.max(1, (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth())
    : 60;
  // The linked global charge is the single source of truth for the EA canone.
  // On edits, preserve the amount/cost configured by the user in "Canoni globali".
  await db.query(`INSERT INTO global_monthly_charges
    (description, monthly_amount, starts_on, duration_months, apply_to_all, license_order_id, monthly_cost)
    VALUES ($1, 0, $2, $3, TRUE, $4, 0)
    ON CONFLICT (license_order_id) WHERE license_order_id IS NOT NULL
    DO UPDATE SET description = EXCLUDED.description, apply_to_all = TRUE`,
    ['EA · ' + order.license_name, startsOn, durationMonths, order.id]);
}

app.get('/license-purchase-orders', requireRole('admin'), async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM license_purchase_orders ORDER BY purchased_on DESC NULLS LAST, created_at DESC');
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/license-purchase-orders', requireRole('admin'), async (req, res, next) => {
  const licenseName = cleanString(req.body?.license_name, 200);
  const supplier = cleanString(req.body?.supplier, 200);
  const reference = cleanString(req.body?.reference, 200);
  const purchasedOn = req.body?.purchased_on || null;
  const renewalOn = req.body?.renewal_on || null;
  const eaMonthlyRevenue = Number(req.body?.ea_monthly_revenue ?? 0);
  const eaMonthlyCost = Number(req.body?.ea_monthly_cost ?? 0);
  const eaStartsOn = req.body?.ea_starts_on || '2026-10-01';
  const quantity = Number(req.body?.quantity ?? 1);
  const unitCost = req.body?.unit_cost === '' || req.body?.unit_cost === undefined ? null : Number(req.body.unit_cost);
  const notes = cleanString(req.body?.notes, 10000);
  if (!licenseName || !Number.isFinite(eaMonthlyRevenue) || eaMonthlyRevenue < 0 || !Number.isFinite(eaMonthlyCost) || eaMonthlyCost < 0 || [licenseName, supplier, reference, notes].includes(undefined) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return fail(res, 400, 'Licenza, quantità o campi non validi.');
  if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) return fail(res, 400, 'Il costo unitario deve essere valido e non negativo.');
  try {
    const result = await pool.query(
      'INSERT INTO license_purchase_orders(license_name, supplier, reference, purchased_on, quantity, unit_cost, renewal_on, notes, ea_monthly_revenue, ea_monthly_cost, ea_starts_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [licenseName, supplier, reference, purchasedOn, quantity, unitCost, renewalOn, notes, eaMonthlyRevenue, eaMonthlyCost, eaStartsOn]
    );
    await syncLicenseOrderCharge(pool, result.rows[0]);
    res.status(201).json({ data: result.rows[0] });
  } catch (error) { next(error); }
});

app.put('/license-purchase-orders/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  const licenseName = cleanString(req.body?.license_name, 200);
  const supplier = cleanString(req.body?.supplier, 200);
  const reference = cleanString(req.body?.reference, 200);
  const purchasedOn = req.body?.purchased_on || null;
  const renewalOn = req.body?.renewal_on || null;
  const eaMonthlyRevenue = Number(req.body?.ea_monthly_revenue ?? 0);
  const eaMonthlyCost = Number(req.body?.ea_monthly_cost ?? 0);
  const eaStartsOn = req.body?.ea_starts_on || '2026-10-01';
  const quantity = Number(req.body?.quantity);
  const unitCost = req.body?.unit_cost === '' || req.body?.unit_cost === undefined ? null : Number(req.body.unit_cost);
  const notes = cleanString(req.body?.notes, 10000);
  if (!id || !licenseName || [licenseName, supplier, reference, notes].includes(undefined) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return fail(res, 400, 'Licenza, quantità o campi non validi.');
  if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) return fail(res, 400, 'Il costo unitario deve essere valido e non negativo.');
  try {
    const result = await pool.query(
      'UPDATE license_purchase_orders SET license_name=$1, supplier=$2, reference=$3, purchased_on=$4, quantity=$5, unit_cost=$6, renewal_on=$7, notes=$8, ea_monthly_revenue=$9, ea_monthly_cost=$10, ea_starts_on=$11, updated_at=NOW() WHERE id=$12 RETURNING *',
      [licenseName, supplier, reference, purchasedOn, quantity, unitCost, renewalOn, notes, eaMonthlyRevenue, eaMonthlyCost, eaStartsOn, id]
    );
    if (!result.rowCount) return fail(res, 404, 'Ordine licenze non trovato.');
    await syncLicenseOrderCharge(pool, result.rows[0]);
    res.json({ data: result.rows[0] });
  } catch (error) { next(error); }
});

app.delete('/license-purchase-orders/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID ordine licenze non valido.');
  try {
    const result = await pool.query('DELETE FROM license_purchase_orders WHERE id=$1 RETURNING id', [id]);
    if (!result.rowCount) return fail(res, 404, 'Ordine licenze non trovato.');
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/product-stock',async(_req,res,next)=>{
 try{
  const result=await pool.query(`
   SELECT ps.*,m.sku,m.manufacturer,m.model_name,sl.name AS stock_location_name,
    COALESCE((SELECT SUM(COALESCE(pp.unit_cost,0)*pp.quantity)/NULLIF(SUM(pp.quantity),0) FROM purchase_profiles pp WHERE pp.device_model_id=ps.device_model_id AND pp.stock_location_id=ps.stock_location_id),m.default_purchase_cost,0)::numeric AS average_unit_cost,
    GREATEST(0,ps.quantity-COALESCE(untracked.quantity,0))::int AS available_quantity,
    (ps.quantity+COALESCE(consumed.quantity,0))::int AS total_quantity
   FROM product_stock ps
   JOIN device_models m ON m.id=ps.device_model_id
   JOIN stock_locations sl ON sl.id=ps.stock_location_id
   LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS quantity FROM devices d
    WHERE d.model_id=ps.device_model_id AND d.stock_location_id=ps.stock_location_id
     AND d.branch_id IS NOT NULL AND d.status IN ('operational','fault','decommissioned')
     AND COALESCE(d.stock_consumed,FALSE)=FALSE
   ) untracked ON TRUE
   LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS quantity FROM devices d
    WHERE d.model_id=ps.device_model_id AND d.stock_location_id=ps.stock_location_id
     AND COALESCE(d.stock_consumed,FALSE)=TRUE
   ) consumed ON TRUE
   ORDER BY m.manufacturer,m.model_name,sl.name
  `);
  res.json({data:result.rows});
 }catch(error){next(error);}
});

app.post('/devices/:id/activate',requireRole('admin','technician','warehouse'),async(req,res,next)=>{
 const id=parseId(req.params.id),branchId=parseId(req.body?.branch_id),ownership=req.body?.ownership_type;
 const salePrice=req.body?.sale_price===''||req.body?.sale_price===undefined?null:Number(req.body.sale_price),activatedOn=req.body?.activated_on||new Date().toISOString().slice(0,10);
 if(!id||!branchId||!['sale','rental'].includes(ownership))return fail(res,400,'Device, filiale e formula DDE/NOL sono obbligatori.');
 if(ownership==='sale'&&(salePrice===null||!Number.isFinite(salePrice)||salePrice<0))return fail(res,400,'Per DDE è obbligatorio il prezzo di vendita.');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const found=await client.query('SELECT d.*,m.default_monthly_fee FROM devices d JOIN device_models m ON m.id=d.model_id WHERE d.id=$1 FOR UPDATE',[id]);
  if(!found.rowCount){await client.query('ROLLBACK');return fail(res,404,'Device non trovato.');}
  const device=found.rows[0],fee=req.body?.monthly_fee===''||req.body?.monthly_fee===undefined?(device.monthly_fee??device.default_monthly_fee):Number(req.body.monthly_fee);
  if(ownership==='rental'&&(fee===null||!Number.isFinite(Number(fee))||Number(fee)<0)){await client.query('ROLLBACK');return fail(res,400,'Per NOL è obbligatorio un canone mensile valido.');}
  if(device.stock_location_id&&!device.stock_consumed){
   const stock=await client.query('UPDATE product_stock SET quantity=quantity-1,updated_at=NOW() WHERE device_model_id=$1 AND stock_location_id=$2 AND quantity>0 RETURNING quantity',[device.model_id,device.stock_location_id]);
   if(!stock.rowCount){await client.query('ROLLBACK');return fail(res,409,'Quantità disponibile insufficiente nel magazzino selezionato.');}
   await client.query("INSERT INTO product_stock_movements(device_model_id,stock_location_id,quantity_delta,movement_type,device_id,notes,moved_by) VALUES($1,$2,-1,'activation',$3,$4,$5)",[device.model_id,device.stock_location_id,id,'Attivazione presso filiale '+branchId,req.user.id]);
  }
  await client.query("UPDATE devices SET branch_id=$1,status='operational',ownership_type=$2,sale_price=$3,monthly_fee=$4,activated_on=$5,deactivated_on=NULL,installed_on=$5,stock_consumed=TRUE,updated_at=NOW() WHERE id=$6",[branchId,ownership,ownership==='sale'?salePrice:null,ownership==='rental'?fee:null,activatedOn,id]);
  if(ownership==='rental')await client.query('INSERT INTO device_nol_history(device_id,branch_id,activated_on,monthly_fee,purchase_cost) VALUES($1,$2,$3,$4,$5)',[id,branchId,activatedOn,fee,device.purchase_cost??0]);
  await client.query('COMMIT');res.json({data:{id,branch_id:branchId,ownership_type:ownership,sale_price:ownership==='sale'?salePrice:null,monthly_fee:ownership==='rental'?fee:null,activated_on:activatedOn}});
 }catch(error){await client.query('ROLLBACK');if(error.code==='23503')return fail(res,400,'Filiale o device non valido.');next(error);}finally{client.release();}
});

app.post('/devices/:id/deactivate',requireRole('admin','technician','warehouse'),async(req,res,next)=>{
 const id=parseId(req.params.id),deactivatedOn=req.body?.deactivated_on||new Date().toISOString().slice(0,10);if(!id)return fail(res,400,'ID device non valido.');
 const client=await pool.connect();
 try{await client.query('BEGIN');const found=await client.query('SELECT * FROM devices WHERE id=$1 FOR UPDATE',[id]);if(!found.rowCount){await client.query('ROLLBACK');return fail(res,404,'Device non trovato.');}
 const device=found.rows[0];if(device.ownership_type==='rental')await client.query('UPDATE device_nol_history SET deactivated_on=$1 WHERE device_id=$2 AND deactivated_on IS NULL',[deactivatedOn,id]);
 if(device.stock_consumed&&device.stock_location_id){
  await client.query('UPDATE product_stock SET quantity=quantity+1,updated_at=NOW() WHERE device_model_id=$1 AND stock_location_id=$2',[device.model_id,device.stock_location_id]);
  await client.query("INSERT INTO product_stock_movements(device_model_id,stock_location_id,quantity_delta,movement_type,device_id,notes,moved_by) VALUES($1,$2,1,'deactivation',$3,$4,$5)",[device.model_id,device.stock_location_id,id,'Rientro a magazzino del device '+id,req.user.id]);
 }
 await client.query("UPDATE devices SET deactivated_on=$1,status='in_stock',branch_id=NULL,stock_consumed=FALSE,updated_at=NOW() WHERE id=$2",[deactivatedOn,id]);await client.query('COMMIT');res.status(204).end();
 }catch(error){await client.query('ROLLBACK');next(error);}finally{client.release();}
});

app.get('/stock/movements', async (_req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT sm.*, d.asset_tag, m.manufacturer, m.model_name, fl.name AS from_location_name, tl.name AS to_location_name, b.nomenclature AS branch_nomenclature FROM stock_movements sm JOIN devices d ON d.id = sm.device_id JOIN device_models m ON m.id = d.model_id LEFT JOIN stock_locations fl ON fl.id = sm.from_location_id LEFT JOIN stock_locations tl ON tl.id = sm.to_location_id LEFT JOIN branches b ON b.id = sm.branch_id ORDER BY sm.moved_at DESC LIMIT 100'
    );
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/stock/movements', requireRole('admin', 'warehouse', 'technician'), async (req, res, next) => {
  const deviceId = parseId(req.body?.device_id);
  const fromId = req.body?.from_location_id ? parseId(req.body.from_location_id) : null;
  const toId = req.body?.to_location_id ? parseId(req.body.to_location_id) : null;
  const branchId = req.body?.branch_id ? parseId(req.body.branch_id) : null;
  const type = cleanString(req.body?.movement_type, 40);
  const notes = cleanString(req.body?.notes, 10000);
  if (!deviceId || !type || notes === undefined) return fail(res, 400, 'Dispositivo e tipo movimento sono obbligatori.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM devices WHERE id = $1 FOR UPDATE', [deviceId]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Dispositivo non trovato.'); }
    const device = found.rows[0];
    const movement = await client.query(
      'INSERT INTO stock_movements(device_id, from_location_id, to_location_id, branch_id, movement_type, notes, moved_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [deviceId, fromId, toId, branchId, type, notes, req.user.id]
    );
    const status = branchId ? 'operational' : 'in_stock';
    const stockLocationId = branchId ? (fromId || device.stock_location_id || toId) : toId;
    await client.query('UPDATE devices SET stock_location_id = $1, branch_id = $2, status = $3, installed_on = CASE WHEN $2 IS NOT NULL THEN COALESCE(installed_on, CURRENT_DATE) ELSE NULL END, updated_at = NOW() WHERE id = $4', [stockLocationId, branchId, status, deviceId]);
    await consumeDeviceStock(client, { ...device, stock_location_id: stockLocationId }, branchId, status, req.user.id);
    await client.query('COMMIT');
    res.status(201).json({ data: movement.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23503') return fail(res, 400, 'Dispositivo, filiale o magazzino non valido.');
    if (error.code === 'STOCK_UNAVAILABLE') return fail(res, 409, error.message);
    next(error);
  } finally { client.release(); }
});

app.get('/branches/:id/checklists', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  try {
    const result = await pool.query(
      'SELECT c.id, c.branch_id, c.title, c.status, c.created_at, c.completed_at, c.notes, COALESCE(json_agg(json_build_object(\'id\', ci.id, \'label\', ci.label, \'is_checked\', ci.is_checked, \'notes\', ci.notes) ORDER BY ci.id) FILTER (WHERE ci.id IS NOT NULL), \'[]\'::json) AS items FROM checklists c LEFT JOIN checklist_items ci ON ci.checklist_id = c.id WHERE c.branch_id = $1 GROUP BY c.id ORDER BY c.created_at DESC',
      [id]
    );
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/branches/:id/checklists', requireRole('admin', 'technician'), async (req, res, next) => {
  const branchId = parseId(req.params.id);
  const title = cleanString(req.body?.title, 200);
  const items = req.body?.items;
  if (!branchId || !title || !Array.isArray(items) || items.length > 100 || items.some((item) => typeof item !== 'string' || !item.trim() || item.length > 300)) return fail(res, 400, 'Titolo e voci checklist non validi.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query('INSERT INTO checklists(branch_id, title, created_by) VALUES ($1,$2,$3) RETURNING *', [branchId, title, req.user.id]);
    for (const item of items) await client.query('INSERT INTO checklist_items(checklist_id, label) VALUES ($1,$2)', [created.rows[0].id, item.trim()]);
    await client.query('COMMIT');
    res.status(201).json({ data: created.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

app.patch('/checklist-items/:id', requireRole('admin', 'technician'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id || typeof req.body?.is_checked !== 'boolean') return fail(res, 400, 'ID o stato checklist non valido.');
  try {
    const result = await pool.query('UPDATE checklist_items SET is_checked = $1, checked_at = CASE WHEN $1 THEN NOW() ELSE NULL END, checked_by = CASE WHEN $1 THEN $2 ELSE NULL END WHERE id = $3 RETURNING *', [req.body.is_checked, req.user.id, id]);
    if (!result.rowCount) return fail(res, 404, 'Voce checklist non trovata.');
    res.json({ data: result.rows[0] });
  } catch (error) { next(error); }
});

app.get('/global-monthly-charges', requireRole('admin'), async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT g.*, COALESCE(ARRAY_AGG(gb.branch_id ORDER BY gb.branch_id) FILTER (WHERE gb.branch_id IS NOT NULL), ARRAY[]::bigint[]) AS branch_ids FROM global_monthly_charges g LEFT JOIN global_monthly_charge_branches gb ON gb.charge_id = g.id GROUP BY g.id ORDER BY g.starts_on DESC, g.created_at DESC');
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/global-monthly-charges', requireRole('admin'), async (req, res, next) => {
  const description = cleanString(req.body?.description, 200);
  const monthlyAmount = Number(req.body?.monthly_amount);
  const startsOn = req.body?.starts_on;
  const durationMonths = Number(req.body?.duration_months ?? 60);
  const applyToAll = req.body?.apply_to_all === true;
  const licenseOrderId = req.body?.license_order_id ? parseId(req.body.license_order_id) : null;
  const branchIds = Array.isArray(req.body?.branch_ids) ? [...new Set(req.body.branch_ids.map(parseId))] : [];
  if (!description || !startsOn || !/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || !Number.isFinite(monthlyAmount) || monthlyAmount < 0 || !Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 600 || (req.body?.license_order_id && !licenseOrderId) || (!applyToAll && (!branchIds.length || branchIds.includes(null)))) return fail(res, 400, 'Descrizione, importo, decorrenza, durata e filiali devono essere validi.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!applyToAll) {
      const valid = await client.query('SELECT COUNT(*)::int AS count FROM branches WHERE id = ANY($1::bigint[])', [branchIds]);
      if (valid.rows[0].count !== branchIds.length) { await client.query('ROLLBACK'); return fail(res, 400, 'Una o più filiali selezionate non esistono.'); }
    }
    const created = await client.query('INSERT INTO global_monthly_charges(description, monthly_amount, starts_on, duration_months, apply_to_all, license_order_id, monthly_cost) VALUES($1,$2,$3,$4,$5,$6,0) RETURNING *', [description, monthlyAmount, startsOn, durationMonths, applyToAll, licenseOrderId]);
    if (!applyToAll) for (const branchId of branchIds) await client.query('INSERT INTO global_monthly_charge_branches(charge_id, branch_id) VALUES($1,$2)', [created.rows[0].id, branchId]);
    await client.query('COMMIT');
    res.status(201).json({ data: { ...created.rows[0], branch_ids: applyToAll ? [] : branchIds } });
  } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
});

app.put('/global-monthly-charges/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  const description = cleanString(req.body?.description, 200);
  const monthlyAmount = Number(req.body?.monthly_amount);
  const startsOn = req.body?.starts_on;
  const durationMonths = Number(req.body?.duration_months ?? 60);
  const applyToAll = req.body?.apply_to_all === true;
  const licenseOrderId = req.body?.license_order_id ? parseId(req.body.license_order_id) : null;
  const branchIds = Array.isArray(req.body?.branch_ids) ? [...new Set(req.body.branch_ids.map(parseId))] : [];
  if (!id || !description || !startsOn || !/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || !Number.isFinite(monthlyAmount) || monthlyAmount < 0 || !Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 600 || (req.body?.license_order_id && !licenseOrderId) || (!applyToAll && (!branchIds.length || branchIds.includes(null)))) return fail(res, 400, 'Regola, importo, decorrenza, durata e filiali devono essere validi.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query('UPDATE global_monthly_charges SET description=$1, monthly_amount=$2, starts_on=$3, duration_months=$4, apply_to_all=$5, license_order_id=$6, monthly_cost=0, updated_at=NOW() WHERE id=$7 RETURNING *', [description, monthlyAmount, startsOn, durationMonths, applyToAll, licenseOrderId, id]);
    if (!updated.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Canone globale non trovato.'); }
    if (!applyToAll) {
      const valid = await client.query('SELECT COUNT(*)::int AS count FROM branches WHERE id = ANY($1::bigint[])', [branchIds]);
      if (valid.rows[0].count !== branchIds.length) { await client.query('ROLLBACK'); return fail(res, 400, 'Una o più filiali selezionate non esistono.'); }
    }
    await client.query('DELETE FROM global_monthly_charge_branches WHERE charge_id=$1', [id]);
    if (!applyToAll) for (const branchId of branchIds) await client.query('INSERT INTO global_monthly_charge_branches(charge_id, branch_id) VALUES($1,$2)', [id, branchId]);
    await client.query('COMMIT');
    res.json({ data: { ...updated.rows[0], branch_ids: applyToAll ? [] : branchIds } });
  } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
});

app.delete('/global-monthly-charges/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID canone globale non valido.');
  try { const result = await pool.query('DELETE FROM global_monthly_charges WHERE id=$1 RETURNING id', [id]); if (!result.rowCount) return fail(res, 404, 'Canone globale non trovato.'); res.status(204).end(); }
  catch (error) { next(error); }
});
app.get('/license-finance', requireRole('admin'), async (_req, res, next) => {
  try {
    const [ordersResult, branchesResult, chargesResult] = await Promise.all([
      pool.query('SELECT * FROM license_purchase_orders ORDER BY purchased_on DESC NULLS LAST, created_at DESC'),
      pool.query(`
        SELECT b.id, b.is_active, b.active_since,
          COALESCE(json_agg(json_build_object(
            'is_active', h.is_active, 'active_since', h.active_since,
            'recorded_at', h.recorded_at, 'id', h.id
          ) ORDER BY h.active_since, h.recorded_at, h.id)
          FILTER (WHERE h.id IS NOT NULL), '[]'::json) AS history
        FROM branches b
        LEFT JOIN branch_active_history h ON h.branch_id = b.id
        GROUP BY b.id
      `),
      pool.query('SELECT * FROM global_monthly_charges WHERE license_order_id IS NOT NULL')
    ]);
    const today = new Date();
    const currentMonth = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
    const monthIndex = (value) => {
      if (!value) return null;
      const d = new Date(String(value).slice(0, 10) + 'T00:00:00Z');
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    };
    const monthDate = (index) => {
      const year = Math.floor(index / 12);
      const month = index % 12;
      return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    };
    const branchHistory = branchesResult.rows.map((branch) => ({
      active_since: String(branch.active_since || '').slice(0, 10),
      is_active: branch.is_active,
      history: (branch.history || []).map((item) => ({
        ...item, active_since: String(item.active_since).slice(0, 10)
      }))
    }));
    const activeBranchesAt = (month) => {
      const date = monthDate(month);
      return branchHistory.reduce((count, branch) => {
        const events = branch.history.filter((event) => event.active_since <= date);
        const active = events.length ? Boolean(events[events.length - 1].is_active)
          : Boolean(branch.is_active) && branch.active_since <= date;
        return count + (active ? 1 : 0);
      }, 0);
    };
    const chargesByOrder = new Map(chargesResult.rows.map((charge) => [String(charge.license_order_id), charge]));
    const data = [];
    for (const order of ordersResult.rows) {
      const investment = Number(order.unit_cost || 0) * Number(order.quantity || 1);
      const charge = chargesByOrder.get(String(order.id));
      const start = monthIndex(charge?.starts_on || order.ea_starts_on || '2026-10-01');
      const end = charge
        ? start + Number(charge.duration_months || 60)
        : monthIndex(order.renewal_on);
      const validTerm = start !== null && end !== null && end > start;
      const monthlyTimeline = [];
      if (validTerm) {
        for (let m = start; m < end; m++) {
          const month = monthDate(m);
          const activeBranches = activeBranchesAt(m);
          const canonePerBranch = Number(charge?.monthly_amount || 0);
          const monthlyInvestmentCost = (end > start ? investment / (end - start) : 0);
          const allocatedCostPerBranch = activeBranches > 0 ? monthlyInvestmentCost / activeBranches : 0;
          const monthlyRevenue = canonePerBranch * activeBranches;
          const monthlyCost = monthlyInvestmentCost;
          const netContribution = monthlyRevenue - monthlyCost;
          const snapshotValues = [activeBranches, canonePerBranch, allocatedCostPerBranch, monthlyRevenue, monthlyCost, netContribution];
          let snapshot;
          if (Date.parse(month + 'T00:00:00Z') < currentMonth) {
            const inserted = await pool.query(`INSERT INTO license_finance_monthly_snapshots
              (license_order_id, month_start, active_branches, canone_per_branch, allocated_cost_per_branch, monthly_revenue, monthly_cost, net_contribution)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
              ON CONFLICT (license_order_id, month_start) DO NOTHING
              RETURNING active_branches, canone_per_branch, allocated_cost_per_branch, monthly_revenue, monthly_cost, net_contribution`,
              [order.id, month, ...snapshotValues]);
            if (inserted.rowCount) snapshot = inserted.rows[0];
            else {
              const existing = await pool.query('SELECT active_branches, canone_per_branch, allocated_cost_per_branch, monthly_revenue, monthly_cost, net_contribution FROM license_finance_monthly_snapshots WHERE license_order_id=$1 AND month_start=$2', [order.id, month]);
              snapshot = existing.rows[0];
            }
          } else {
            const upserted = await pool.query(`INSERT INTO license_finance_monthly_snapshots
              (license_order_id, month_start, active_branches, canone_per_branch, allocated_cost_per_branch, monthly_revenue, monthly_cost, net_contribution)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
              ON CONFLICT (license_order_id, month_start) DO UPDATE SET
                active_branches=EXCLUDED.active_branches, canone_per_branch=EXCLUDED.canone_per_branch,
                allocated_cost_per_branch=EXCLUDED.allocated_cost_per_branch, monthly_revenue=EXCLUDED.monthly_revenue,
                monthly_cost=EXCLUDED.monthly_cost, net_contribution=EXCLUDED.net_contribution
              RETURNING active_branches, canone_per_branch, allocated_cost_per_branch, monthly_revenue, monthly_cost, net_contribution`,
              [order.id, month, ...snapshotValues]);
            snapshot = upserted.rows[0];
          }
          const row = {
            month, active_branches: Number(snapshot.active_branches),
            canone_per_branch: Number(snapshot.canone_per_branch),
            allocated_cost_per_branch: Number(snapshot.allocated_cost_per_branch),
            monthly_revenue: Number(snapshot.monthly_revenue),
            monthly_cost: Number(snapshot.monthly_cost),
            net_contribution: Number(snapshot.net_contribution)
          };
          monthlyTimeline.push(row);
        }
      }
      const metrics = calculateLicenseFinanceMetrics({
        investment,
        monthlyTimeline,
        currentMonth: monthDate(today.getUTCFullYear() * 12 + today.getUTCMonth())
      });
      const currentRow = monthlyTimeline.find((item) => item.month === monthDate(today.getUTCFullYear() * 12 + today.getUTCMonth()));
      data.push({
        ...order,
        investment_cost: investment,
        active_branches_now: currentRow?.active_branches ?? activeBranchesAt(today.getUTCFullYear() * 12 + today.getUTCMonth()),
        monthly_revenue_now: currentRow?.monthly_revenue ?? 0,
        monthly_cost_now: currentRow?.monthly_cost ?? 0,
        recovered_to_date: validTerm ? metrics.recovered : null,
        amount_to_recover: validTerm ? metrics.amountToRecover : null,
        recovery_percent: validTerm ? metrics.recoveryPercent : null,
        projected_net_revenue: validTerm ? metrics.projectedRevenue : null,
        projected_margin: validTerm ? metrics.projectedMargin : null,
        break_even_date: validTerm ? metrics.breakEvenDate : null,
        term_complete: validTerm,
        monthly_timeline: monthlyTimeline
      });
    }
    res.json({ data });
  } catch (error) { next(error); }
});

app.get('/finance/dashboard',async(req,res,next)=>{
 const filter=queryBranch(req);if(filter.error)return fail(res,400,filter.error);
 try{
 const result=await pool.query(`
 WITH months AS (
  SELECT generate_series(
    COALESCE((SELECT date_trunc('month',MIN(starts_on))::date FROM global_monthly_charges), date_trunc('month',CURRENT_DATE)::date),
    date_trunc('month',CURRENT_DATE)::date,
    INTERVAL '1 month'
  )::date AS month_start
 ), branch_month_activity AS (
  SELECT m.month_start,b.id AS branch_id,
   COALESCE(
    (SELECT h.is_active FROM branch_active_history h
     WHERE h.branch_id=b.id AND h.active_since<=m.month_start
     ORDER BY h.active_since DESC,h.recorded_at DESC,h.id DESC LIMIT 1),
    (b.is_active AND b.active_since<=m.month_start),
    FALSE
   ) AS is_active
  FROM months m CROSS JOIN branches b
 ), branch_counts AS (
  SELECT month_start,COUNT(*) FILTER(WHERE is_active)::numeric AS active_count
  FROM branch_month_activity GROUP BY month_start
 ), nol AS (
  SELECT h.*,GREATEST(0,EXTRACT(YEAR FROM age(COALESCE(h.deactivated_on,CURRENT_DATE),h.activated_on))::int*12+EXTRACT(MONTH FROM age(COALESCE(h.deactivated_on,CURRENT_DATE),h.activated_on))::int) AS complete_months
  FROM device_nol_history h WHERE ($1::bigint IS NULL OR h.branch_id=$1)
 ), totals AS (
  SELECT COALESCE(SUM(monthly_fee*complete_months),0)::numeric AS nol_all_time,
   COALESCE(SUM(CASE WHEN complete_months>0 AND activated_on<(date_trunc('month',CURRENT_DATE)+INTERVAL '1 month')::date AND COALESCE(deactivated_on,CURRENT_DATE)>=date_trunc('month',CURRENT_DATE)::date THEN monthly_fee ELSE 0 END),0)::numeric AS nol_current_month,
   COALESCE(SUM(monthly_fee*complete_months-purchase_cost),0)::numeric AS nol_balance FROM nol
 ), sales AS (
  SELECT COALESCE(SUM(sale_price),0)::numeric AS sales_all_time,
   COALESCE(SUM(sale_price) FILTER(WHERE COALESCE(activated_on,installed_on,created_at::date)>=date_trunc('month',CURRENT_DATE)::date AND COALESCE(activated_on,installed_on,created_at::date)<(date_trunc('month',CURRENT_DATE)+INTERVAL '1 month')::date),0)::numeric AS sales_current_month
  FROM devices d WHERE d.ownership_type='sale' AND d.sale_price IS NOT NULL AND ($1::bigint IS NULL OR d.branch_id=$1)
 ), costs AS (
  SELECT
   CASE WHEN $1::bigint IS NULL THEN
    COALESCE((SELECT SUM(COALESCE(p.unit_cost,0)*COALESCE(p.quantity,1)) FROM purchase_profiles p),0)
   ELSE
    COALESCE((SELECT SUM(COALESCE(d.purchase_cost,0)) FROM devices d WHERE d.branch_id=$1),0)
   END::numeric AS hardware_costs,
   CASE WHEN $1::bigint IS NULL THEN
    COALESCE((SELECT SUM(COALESCE(l.unit_cost,0)*COALESCE(l.quantity,1)) FROM license_purchase_orders l),0)
   ELSE
    COALESCE((
     SELECT SUM((COALESCE(l.unit_cost,0)*COALESCE(l.quantity,1))/NULLIF(bc.active_count,0))
     FROM license_purchase_orders l
     JOIN branch_counts bc ON bc.month_start=date_trunc('month',COALESCE(l.ea_starts_on,l.purchased_on,DATE '2026-10-01'))::date
     JOIN branch_month_activity selected_branch ON selected_branch.month_start=bc.month_start
       AND selected_branch.branch_id=$1 AND selected_branch.is_active=TRUE
     WHERE bc.active_count>0
    ),0)
   END::numeric AS license_costs,
   COALESCE((SELECT SUM(fe.amount) FROM finance_entries fe WHERE fe.entry_type IN ('service','other') AND ($1::bigint IS NULL OR fe.branch_id=$1)),0)::numeric AS other_costs
 ), charge_month_rows AS (
  SELECT g.*,m.month_start,COALESCE(bc.active_count,0)::numeric AS active_count,
   CASE WHEN $1::bigint IS NOT NULL THEN
     CASE WHEN EXISTS (
       SELECT 1 FROM branch_month_activity ba
       WHERE ba.month_start=m.month_start AND ba.branch_id=$1 AND ba.is_active
         AND (g.apply_to_all OR EXISTS (
           SELECT 1 FROM global_monthly_charge_branches gb
           WHERE gb.charge_id=g.id AND gb.branch_id=$1
         ))
     ) THEN 1 ELSE 0 END
   WHEN g.apply_to_all THEN COALESCE(bc.active_count,0)
   ELSE (
     SELECT COUNT(*)::numeric
     FROM global_monthly_charge_branches gb
     JOIN branch_month_activity ba ON ba.branch_id=gb.branch_id AND ba.month_start=m.month_start AND ba.is_active
     WHERE gb.charge_id=g.id
   ) END AS branch_count
  FROM global_monthly_charges g
  JOIN months m ON m.month_start>=date_trunc('month',g.starts_on)::date
    AND m.month_start<date_trunc('month',g.starts_on)::date+(g.duration_months*INTERVAL '1 month')
  LEFT JOIN branch_counts bc ON bc.month_start=m.month_start
 ), charge_totals AS (
  SELECT COALESCE(SUM(monthly_amount*branch_count),0)::numeric AS global_charges_all_time,
   COALESCE(SUM(monthly_amount*branch_count) FILTER(WHERE month_start=date_trunc('month',CURRENT_DATE)::date),0)::numeric AS global_charges_current_month
  FROM charge_month_rows
 )
 SELECT (SELECT COUNT(*)::int FROM devices d WHERE ($1::bigint IS NULL OR d.branch_id=$1)) AS devices,
 (SELECT COALESCE(SUM(d.purchase_cost),0)::numeric FROM devices d WHERE ($1::bigint IS NULL OR d.branch_id=$1)) AS purchase_cost,
 (SELECT COALESCE(SUM(d.monthly_fee),0)::numeric FROM devices d WHERE d.ownership_type='rental' AND d.status<>'decommissioned' AND ($1::bigint IS NULL OR d.branch_id=$1)) AS monthly_fees,
 (SELECT COUNT(*)::int FROM devices d WHERE d.ownership_type='rental' AND ($1::bigint IS NULL OR d.branch_id=$1)) AS rental_devices,
 (SELECT COUNT(*)::int FROM devices d WHERE d.ownership_type='sale' AND ($1::bigint IS NULL OR d.branch_id=$1)) AS owned_devices,
 totals.nol_current_month AS nol_current_month,
  totals.nol_all_time AS nol_all_time,
  totals.nol_balance AS nol_balance,
 sales.sales_current_month,sales.sales_all_time,
 costs.hardware_costs,costs.license_costs,costs.other_costs,
 (costs.hardware_costs+costs.license_costs+costs.other_costs)::numeric AS total_costs,
 charge_totals.global_charges_current_month,charge_totals.global_charges_all_time,
 (totals.nol_all_time+sales.sales_all_time+charge_totals.global_charges_all_time-costs.hardware_costs-costs.license_costs-costs.other_costs)::numeric AS overall_margin
 FROM totals CROSS JOIN sales CROSS JOIN costs CROSS JOIN charge_totals
 `,[filter.id]);res.json({data:result.rows[0]});
 }catch(error){next(error);}
});
app.get('/admin/users', requireRole('admin'), async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT id, username, display_name, role, is_active, created_at FROM users ORDER BY display_name, username');
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/admin/users', requireRole('admin'), async (req, res, next) => {
  const username = cleanString(req.body?.username, 120);
  const displayName = cleanString(req.body?.display_name, 160);
  const password = req.body?.password;
  const role = req.body?.role;
  if (!username || !displayName || typeof password !== 'string' || password.length < 12 || password.length > 1024 || !['admin', 'technician', 'sales', 'warehouse', 'finance'].includes(role)) return fail(res, 400, 'Username, nome, password di almeno 12 caratteri e ruolo valido sono obbligatori.');
  try {
    const passwordHash = await hashPassword(password);
    const result = await pool.query('INSERT INTO users(username, display_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, username, display_name, role, is_active, created_at', [username, displayName, passwordHash, role]);
    res.status(201).json({ data: result.rows[0] });
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Username già utilizzato.'); next(error); }
});

app.get('/clients', async (req, res, next) => {
  const requestedLimit = Number(req.query.limit || 50);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) return fail(res, 400, 'limit deve essere un numero intero tra 1 e 100.');
  try {
    const result = await pool.query('SELECT id, company_name, contact_name, email, phone, vat_number, notes, created_at, updated_at FROM clients ORDER BY company_name ASC, id ASC LIMIT $1', [requestedLimit]);
    res.json({ data: result.rows, count: result.rowCount });
  } catch (error) { next(error); }
});

app.get('/clients/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  try {
    const result = await pool.query('SELECT id, company_name, contact_name, email, phone, vat_number, notes, created_at, updated_at FROM clients WHERE id = $1', [id]);
    if (!result.rowCount) return fail(res, 404, 'Cliente non trovato.');
    res.json({ data: result.rows[0] });
  } catch (error) { next(error); }
});

app.post('/clients', requireRole('admin', 'sales'), async (req, res, next) => {
  const errorMessage = validateClient(req.body);
  if (errorMessage) return fail(res, 400, errorMessage);
  const values = clientFields.map((field) => typeof req.body[field] === 'string' ? req.body[field].trim() || null : req.body[field] ?? null);
  try {
    const result = await pool.query('INSERT INTO clients(company_name, contact_name, email, phone, vat_number, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, company_name, contact_name, email, phone, vat_number, notes, created_at, updated_at', values);
    res.status(201).json({ data: result.rows[0] });
  } catch (error) { next(error); }
});

app.put('/clients/:id', requireRole('admin', 'sales'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  const errorMessage = validateClient(req.body, true);
  if (errorMessage) return fail(res, 400, errorMessage);
  const fields = clientFields.filter((field) => Object.hasOwn(req.body, field));
  const values = fields.map((field) => typeof req.body[field] === 'string' ? req.body[field].trim() || null : req.body[field]);
  const assignments = fields.map((field, index) => field + ' = $' + (index + 1));
  values.push(id);
  try {
    const result = await pool.query('UPDATE clients SET ' + assignments.join(', ') + ', updated_at = NOW() WHERE id = $' + values.length + ' RETURNING id, company_name, contact_name, email, phone, vat_number, notes, created_at, updated_at', values);
    if (!result.rowCount) return fail(res, 404, 'Cliente non trovato.');
    res.json({ data: result.rows[0] });
  } catch (error) { next(error); }
});

app.delete('/clients/:id', requireRole('admin', 'sales'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  try {
    const result = await pool.query('DELETE FROM clients WHERE id = $1 RETURNING id', [id]);
    if (!result.rowCount) return fail(res, 404, 'Cliente non trovato.');
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use((_req, res) => fail(res, 404, 'Risorsa non trovata.'));

app.use((error, _req, res, _next) => {
  console.error('API request failed:', error.message);
  if (res.headersSent) return;
  if (error.type === 'entity.parse.failed') return fail(res, 400, 'JSON non valido.');
  if (error.code === '23503') return fail(res, 409, 'Operazione non consentita: record collegato ad altri dati.');
  res.status(500).json({ error: 'Errore interno del server.' });
});

async function start() {
  await pool.query('SELECT 1');
  await runMigrations();
  await bootstrapAdmin();
  const server = app.listen(port, '0.0.0.0', () => console.log('Client Management API listening on port ' + port));
  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((error) => {
  console.error('Unable to start API:', error.message);
  process.exit(1);
});
