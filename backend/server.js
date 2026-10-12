import express from 'express';
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
    const [branches, devices, faults, monthly, stock] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM branches WHERE ($1::bigint IS NULL OR id = $1)', [filter.id]),
      pool.query("SELECT COUNT(*)::int AS count FROM devices WHERE ($1::bigint IS NULL OR branch_id = $1)", [filter.id]),
      pool.query("SELECT COUNT(*)::int AS count FROM devices WHERE status = 'fault' AND ($1::bigint IS NULL OR branch_id = $1)", [filter.id]),
      pool.query('SELECT COALESCE(SUM(monthly_fee), 0)::numeric AS amount FROM devices WHERE ($1::bigint IS NULL OR branch_id = $1)', [filter.id]),
      pool.query("SELECT COUNT(*)::int AS count FROM devices WHERE status = 'in_stock' AND ($1::bigint IS NULL OR branch_id = $1)", [filter.id])
    ]);
    res.json({ data: { branches: branches.rows[0].count, devices: devices.rows[0].count, faults: faults.rows[0].count, monthlyFees: monthly.rows[0].amount, stock: stock.rows[0].count } });
  } catch (error) { next(error); }
});

app.get('/companies', async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT c.*, COUNT(b.id)::int AS branch_count FROM companies c LEFT JOIN branches b ON b.company_id = c.id GROUP BY c.id ORDER BY c.legal_name');
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});

app.post('/companies', requireRole('admin'), async (req, res, next) => {
  const legalName = cleanString(req.body?.legal_name, 200);
  const taxCode = cleanString(req.body?.tax_code, 50);
  if (legalName === undefined || taxCode === undefined) return fail(res, 400, 'Verificare i campi inseriti.');
  if (!legalName) return fail(res, 400, 'La ragione sociale è obbligatoria.');
  try {
    const result = await pool.query('INSERT INTO companies(legal_name, tax_code) VALUES ($1, $2) RETURNING *', [legalName, taxCode]);
    res.status(201).json({ data: result.rows[0] });
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Ragione sociale già presente.'); next(error); }
});

app.put('/companies/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  const legalName = cleanString(req.body?.legal_name, 200);
  const taxCode = cleanString(req.body?.tax_code, 50);
  if (!id) return fail(res, 400, 'ID non valido.');
  if (legalName === undefined || taxCode === undefined || !legalName) return fail(res, 400, 'Ragione sociale non valida.');
  try {
    const result = await pool.query('UPDATE companies SET legal_name = $1, tax_code = $2, updated_at = NOW() WHERE id = $3 RETURNING *', [legalName, taxCode, id]);
    if (!result.rowCount) return fail(res, 404, 'Ragione sociale non trovata.');
    res.json({ data: result.rows[0] });
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Ragione sociale già presente.'); next(error); }
});

app.delete('/companies/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  try {
    const usage = await pool.query('SELECT 1 FROM branches WHERE company_id = $1 LIMIT 1', [id]);
    if (usage.rowCount) return fail(res, 409, 'La ragione sociale è associata a una o più filiali.');
    const result = await pool.query('DELETE FROM companies WHERE id = $1 RETURNING id', [id]);
    if (!result.rowCount) return fail(res, 404, 'Ragione sociale non trovata.');
    res.status(204).end();
  } catch (error) { next(error); }
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
  if (!companyId || [country, street, nomenclature, previous, network, prefix, wlc].includes(undefined)) return fail(res, 400, 'Verificare i campi della filiale.');
  if (!country || !street) return fail(res, 400, 'Paese e via sono obbligatori.');
  try {
    const result = await pool.query(
      'INSERT INTO branches(company_id, country, street, nomenclature, previous_nomenclature, network, phone_prefix, wlc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [companyId, country, street, nomenclature, previous, network, prefix, wlc]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) { if (error.code === '23503') return fail(res, 400, 'Ragione sociale inesistente.'); next(error); }
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
  const fields = ['company_id', 'country', 'street', 'nomenclature', 'previous_nomenclature', 'network', 'phone_prefix', 'wlc', 'status'];
  const limits = { country: 100, street: 300, nomenclature: 100, previous_nomenclature: 100, network: 100, phone_prefix: 30, wlc: 200, status: 30 };
  const updates = [];
  const values = [];
  for (const field of fields) {
    if (!Object.hasOwn(req.body || {}, field)) continue;
    let value = req.body[field];
    if (field === 'company_id') value = parseId(value);
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
    const before = await client.query('SELECT b.company_id, c.legal_name AS company_name FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.id = $1 FOR UPDATE OF b', [id]);
    if (!before.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Filiale non trovata.'); }
    const oldCompanyId = String(before.rows[0].company_id);
    const oldCompanyName = before.rows[0].company_name;
    const result = await client.query('UPDATE branches SET ' + updates.join(', ') + ', updated_at = NOW() WHERE id = $' + values.length + ' RETURNING *', values);
    if (!result.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Filiale non trovata.'); }
    const newCompanyId = String(result.rows[0].company_id);
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
  if (!id || [supplier, reference, notes].includes(undefined) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return fail(res, 400, 'Ordine, quantità o campi non validi.');
  if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) return fail(res, 400, 'Il costo unitario deve essere un importo valido e non negativo.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM purchase_profiles WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return fail(res, 404, 'Ordine non trovato.'); }
    const order = found.rows[0];
    const consumed = await client.query('SELECT COUNT(*)::int AS count FROM devices WHERE purchase_profile_id = $1 AND stock_consumed = TRUE', [id]);
    const consumedCount = consumed.rows[0].count;
    if (quantity < consumedCount) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'La quantità non può essere inferiore ai device già prelevati da questo ordine (' + consumedCount + ').');
    }
    const delta = quantity - Number(order.quantity || 1);
    if (delta !== 0 && order.stock_location_id) {
      if (delta > 0) {
        await client.query('INSERT INTO product_stock(device_model_id, stock_location_id, quantity) VALUES ($1,$2,$3) ON CONFLICT(device_model_id, stock_location_id) DO UPDATE SET quantity = product_stock.quantity + EXCLUDED.quantity, updated_at = NOW()', [order.device_model_id, order.stock_location_id, delta]);
      } else {
        const stock = await client.query('UPDATE product_stock SET quantity = quantity + $1, updated_at = NOW() WHERE device_model_id = $2 AND stock_location_id = $3 AND quantity + $1 >= 0 RETURNING quantity', [delta, order.device_model_id, order.stock_location_id]);
        if (!stock.rowCount) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'Impossibile ridurre la quantità: la giacenza disponibile non è sufficiente.');
        }
      }
      await client.query("INSERT INTO product_stock_movements(device_model_id, stock_location_id, quantity_delta, movement_type, purchase_profile_id, notes, moved_by) VALUES ($1,$2,$3,'adjustment',$4,$5,$6)", [order.device_model_id, order.stock_location_id, delta, id, 'Modifica quantità ordine ' + (reference || order.reference || id), req.user.id]);
    }
    const result = await client.query('UPDATE purchase_profiles SET supplier = $1, reference = $2, purchased_on = $3, unit_cost = $4, quantity = $5, notes = $6 WHERE id = $7 RETURNING *', [supplier, reference, purchasedOn, unitCost, quantity, notes, id]);
    await client.query('COMMIT');
    res.json({ data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23503') return fail(res, 400, 'Ordine collegato a dati non validi.');
    next(error);
  } finally { client.release(); }
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

app.post('/devices', requireRole('admin', 'technician', 'warehouse'), async (req, res, next) => {
  const modelId = parseId(req.body?.model_id);
  const branchId = req.body?.branch_id ? parseId(req.body.branch_id) : null;
  const stockLocationId = req.body?.stock_location_id ? parseId(req.body.stock_location_id) : null;
  const purchaseProfileId = req.body?.purchase_profile_id ? parseId(req.body.purchase_profile_id) : null;
  const assetTag = cleanString(req.body?.asset_tag, 100);
  const serial = cleanString(req.body?.serial_number, 200);
  const status = req.body?.status || (branchId ? 'operational' : 'in_stock');
  const ownership = req.body?.ownership_type || 'sale';
  const cost = req.body?.purchase_cost ?? null;
  const fee = req.body?.monthly_fee ?? null;
  const purchased = req.body?.purchased_on || null;
  const installed = req.body?.installed_on || null;
  const notes = cleanString(req.body?.notes, 10000);
  if (!modelId || [assetTag, serial, notes].includes(undefined)) return fail(res, 400, 'Modello o campi non validi.');
  if (!['to_activate', 'operational', 'fault', 'decommissioned', 'in_stock'].includes(status)) return fail(res, 400, 'Stato dispositivo non valido.');
  if (!['sale', 'rental'].includes(ownership)) return fail(res, 400, 'Tipologia economica non valida.');
  if ((cost !== null && (!Number.isFinite(Number(cost)) || Number(cost) < 0)) || (fee !== null && (!Number.isFinite(Number(fee)) || Number(fee) < 0))) return fail(res, 400, 'Importi non validi.');
  try {
    const result = await pool.query(
      'INSERT INTO devices(model_id, branch_id, stock_location_id, purchase_profile_id, asset_tag, serial_number, status, ownership_type, purchase_cost, monthly_fee, purchased_on, installed_on, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4::bigint IS NOT NULL THEN (SELECT unit_cost FROM purchase_profiles WHERE id=$4) ELSE $9 END,$10,$11,$12,$13) RETURNING *',
      [modelId, branchId, stockLocationId, purchaseProfileId, assetTag, serial, status, ownership, cost, fee, purchased, installed, notes]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Asset tag già presente.'); if (error.code === '23503') return fail(res, 400, 'Modello, filiale o magazzino non valido.'); next(error); }
});

app.put('/devices/:id', requireRole('admin', 'technician', 'warehouse'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'ID non valido.');
  const allowed = ['model_id', 'branch_id', 'stock_location_id', 'asset_tag', 'serial_number', 'status', 'ownership_type', 'purchase_cost', 'monthly_fee', 'purchased_on', 'installed_on', 'notes'];
  const limits = { asset_tag: 100, serial_number: 200, status: 30, ownership_type: 20, notes: 10000 };
  const values = [];
  const assignments = [];
  for (const field of allowed) {
    if (!Object.hasOwn(req.body || {}, field)) continue;
    let value = req.body[field];
    if (['model_id', 'branch_id', 'stock_location_id'].includes(field)) value = value === null || value === '' ? null : parseId(value);
    else if (['purchase_cost', 'monthly_fee'].includes(field)) value = value === null || value === '' ? null : Number(value);
    else if (['purchased_on', 'installed_on'].includes(field)) value = value || null;
    else value = cleanString(value, limits[field] || 200);
    if (value === undefined || (['purchase_cost', 'monthly_fee'].includes(field) && value !== null && (!Number.isFinite(value) || value < 0))) return fail(res, 400, 'Campo non valido: ' + field);
    values.push(value);
    assignments.push(field + ' = $' + values.length);
  }
  if (!assignments.length) return fail(res, 400, 'Specificare almeno un campo.');
  values.push(id);
  try {
    const result = await pool.query('UPDATE devices SET ' + assignments.join(', ') + ', updated_at = NOW() WHERE id = $' + values.length + ' RETURNING *', values);
    if (!result.rowCount) return fail(res, 404, 'Dispositivo non trovato.');
    res.json({ data: result.rows[0] });
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Asset tag già presente.'); next(error); }
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

app.get('/product-stock',async(_req,res,next)=>{
 try{const result=await pool.query('SELECT ps.*,m.sku,m.manufacturer,m.model_name,sl.name AS stock_location_name FROM product_stock ps JOIN device_models m ON m.id=ps.device_model_id JOIN stock_locations sl ON sl.id=ps.stock_location_id ORDER BY m.manufacturer,m.model_name,sl.name');res.json({data:result.rows});}catch(error){next(error);}
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
  if(device.branch_id===null&&device.stock_location_id&&!device.stock_consumed){
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
 await client.query("UPDATE devices SET deactivated_on=$1,status='in_stock',branch_id=NULL,updated_at=NOW() WHERE id=$2",[deactivatedOn,id]);await client.query('COMMIT');res.status(204).end();
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
    const movement = await client.query(
      'INSERT INTO stock_movements(device_id, from_location_id, to_location_id, branch_id, movement_type, notes, moved_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [deviceId, fromId, toId, branchId, type, notes, req.user.id]
    );
    const status = branchId ? 'operational' : 'in_stock';
    await client.query('UPDATE devices SET stock_location_id = $1, branch_id = $2, status = $3, installed_on = CASE WHEN $2 IS NOT NULL THEN COALESCE(installed_on, CURRENT_DATE) ELSE NULL END, updated_at = NOW() WHERE id = $4', [toId, branchId, status, deviceId]);
    await client.query('COMMIT');
    res.status(201).json({ data: movement.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23503') return fail(res, 400, 'Dispositivo, filiale o magazzino non valido.');
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

app.get('/finance/dashboard',async(req,res,next)=>{
 const filter=queryBranch(req);if(filter.error)return fail(res,400,filter.error);
 try{
 const result=await pool.query(`
 WITH nol AS (
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
   COALESCE((SELECT SUM(COALESCE(p.unit_cost,0)*COALESCE(p.quantity,1)) FROM purchase_profiles p),0)::numeric AS hardware_costs,
   COALESCE((SELECT SUM(fe.amount) FROM finance_entries fe WHERE fe.entry_type IN ('service','other') AND ($1::bigint IS NULL OR fe.branch_id=$1)),0)::numeric AS other_costs
 )
 SELECT (SELECT COUNT(*)::int FROM devices d WHERE ($1::bigint IS NULL OR d.branch_id=$1)) AS devices,
 (SELECT COALESCE(SUM(d.purchase_cost),0)::numeric FROM devices d WHERE ($1::bigint IS NULL OR d.branch_id=$1)) AS purchase_cost,
 (SELECT COALESCE(SUM(d.monthly_fee),0)::numeric FROM devices d WHERE d.ownership_type='rental' AND d.status<>'decommissioned' AND ($1::bigint IS NULL OR d.branch_id=$1)) AS monthly_fees,
 (SELECT COUNT(*)::int FROM devices d WHERE d.ownership_type='rental' AND ($1::bigint IS NULL OR d.branch_id=$1)) AS rental_devices,
 (SELECT COUNT(*)::int FROM devices d WHERE d.ownership_type='sale' AND ($1::bigint IS NULL OR d.branch_id=$1)) AS owned_devices,
 totals.nol_current_month,totals.nol_all_time,totals.nol_balance,sales.sales_current_month,sales.sales_all_time,
 costs.hardware_costs,costs.other_costs,(costs.hardware_costs+costs.other_costs)::numeric AS total_costs,
 (totals.nol_all_time+sales.sales_all_time-costs.hardware_costs-costs.other_costs)::numeric AS overall_margin
 FROM totals CROSS JOIN sales CROSS JOIN costs
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
