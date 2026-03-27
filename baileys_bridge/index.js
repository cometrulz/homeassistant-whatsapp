const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const PORT = Number(process.env.PORT || 3100);
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'change-me';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_BEARER = process.env.WEBHOOK_BEARER || '';
const AUTH_DIR = process.env.AUTH_DIR || '/config/baileys_auth';
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS || 30));
const LOG_FILE = process.env.LOG_FILE || path.join(AUTH_DIR, 'send_receive.log.ndjson');
const LICENSE_FILE = path.join(AUTH_DIR, 'license.json');
const LICENSE_SERVER_URL = String(process.env.LICENSE_SERVER_URL || '').trim().replace(/\/$/, '');
const LICENSE_KEY_ENV = String(process.env.LICENSE_KEY || '').trim();
const LICENSE_EMAIL_ENV = String(process.env.LICENSE_EMAIL || '').trim();
const ALLOW_ALL_INBOUND = String(process.env.ALLOW_ALL_INBOUND || 'false').toLowerCase() === 'true';
const ALLOWLIST_RAW = (process.env.ALLOWLIST || '').trim();
const ALLOWLIST = ALLOWLIST_RAW
  .split(',')
  .map((s) => s.replace(/[^0-9]/g, ''))
  .filter(Boolean);
const ITEOLOGY_ICON = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256' viewBox='0 0 256 256'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%25' stop-color='%2300c2ff'/><stop offset='100%25' stop-color='%23007a5e'/></linearGradient></defs><rect rx='56' width='256' height='256' fill='url(%23g)'/><path d='M128 52a76 76 0 0 0-66.8 112L52 204l41-9a76 76 0 1 0 35-143z' fill='%23fff' fill-opacity='.95'/><path d='M171 147c-2 6-12 11-19 12-5 1-11 2-31-6-25-11-42-38-43-40s-10-13-10-25 6-17 9-19c2-3 5-3 7-3h5c2 0 4 0 5 4 2 5 7 18 7 20 1 2 0 3-1 5l-3 4c-1 1-2 3-1 5 1 2 6 10 14 16 10 9 18 12 21 14 2 1 4 1 5-1l7-9c2-2 3-2 6-1l17 8c3 1 4 2 5 4 1 2 1 11-1 16z' fill='%2300755a'/><text x='128' y='236' font-family='Segoe UI,Arial' font-size='24' text-anchor='middle' fill='%23fff'>ITEOLOGY</text></svg>`;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

let sock = null;
let latestQrText = null;
let latestQrImage = null;
let paired = false;
let selfJid = null;
let lastError = null;
let reconnecting = false;
let lastPruneAt = 0;
let instanceFingerprint = null;
let licenseKey = LICENSE_KEY_ENV;
let licenseEmail = LICENSE_EMAIL_ENV;

const licenseState = {
  mode: 'unknown',
  licensed: false,
  wildcard: false,
  trialActive: false,
  trialEndsAt: null,
  expiresAt: null,
  reason: null,
  lastCheckedAt: null,
};

function normalizeMsisdn(to) {
  if (!to) return null;
  const digits = String(to).replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

function toDigits(jidOrNumber) {
  return String(jidOrNumber || '').replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
}

function getMessageText(msgObj) {
  if (!msgObj) return '';
  const m = msgObj.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  );
}

function allowedSender(fromDigits) {
  if (ALLOW_ALL_INBOUND) return true;
  if (!ALLOWLIST.length) return false;
  return ALLOWLIST.includes(fromDigits);
}

function ensureLogDir() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

function appendLog(entry) {
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    maybePruneLogs();
  } catch (e) {
    lastError = `Log write failed: ${e.message}`;
  }
}

function maybePruneLogs(force = false) {
  const now = Date.now();
  if (!force && now - lastPruneAt < 60 * 60 * 1000) return;
  lastPruneAt = now;
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const cutoff = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const kept = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        const ts = Number(new Date(row.ts || 0));
        if (Number.isFinite(ts) && ts >= cutoff) kept.push(line);
      } catch (_) {}
    }
    fs.writeFileSync(LOG_FILE, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
  } catch (e) {
    lastError = `Log prune failed: ${e.message}`;
  }
}

function readLogs(limit = 250, days = LOG_RETENTION_DAYS) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const effectiveLimit = Math.max(1, Math.min(2000, Number(limit) || 250));
    const cutoff = Date.now() - Math.max(1, Number(days) || LOG_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const row = JSON.parse(lines[i]);
        const ts = Number(new Date(row.ts || 0));
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        out.push(row);
        if (out.length >= effectiveLimit) break;
      } catch (_) {}
    }
    return out;
  } catch (_) {
    return [];
  }
}

function logsToCsv(logs) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['ts', 'direction', 'to', 'from', 'status', 'message', 'error'];
  const rows = [header.join(',')];
  for (const r of logs) {
    rows.push([esc(r.ts), esc(r.direction), esc(r.to), esc(r.from), esc(r.status), esc(r.message), esc(r.error)].join(','));
  }
  return `${rows.join('\n')}\n`;
}

function clearLogs() {
  ensureLogDir();
  fs.writeFileSync(LOG_FILE, '', 'utf8');
}

function loadLocalLicense() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    if (!licenseKey && data?.license_key) licenseKey = String(data.license_key).trim();
    if (!licenseEmail && data?.email) licenseEmail = String(data.email).trim();
  } catch (_) {}
}

function saveLocalLicense() {
  try {
    fs.mkdirSync(path.dirname(LICENSE_FILE), { recursive: true });
    fs.writeFileSync(LICENSE_FILE, JSON.stringify({ license_key: licenseKey || '', email: licenseEmail || '', updated_at: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {
    lastError = `License save failed: ${e.message}`;
  }
}

function removeLocalLicense() {
  try {
    if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE);
  } catch (_) {}
}

function readCoreUuidRaw() {
  const candidates = ['/config/.storage/core.uuid', '/homeassistant/.storage/core.uuid'];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const j = JSON.parse(raw);
      const v = j?.data?.uuid || j?.uuid || '';
      if (v) return String(v);
      const m = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) return m[0];
    } catch (_) {}
  }
  return '';
}

function ensureInstanceFingerprint() {
  if (instanceFingerprint) return instanceFingerprint;
  const coreUuid = readCoreUuidRaw();
  const base = coreUuid || `fallback-${selfJid || 'unknown'}`;
  instanceFingerprint = crypto.createHash('sha256').update(base).digest('hex');
  return instanceFingerprint;
}

function licenseAllowsMessaging() {
  return !!(licenseState.licensed || licenseState.trialActive);
}

async function licenseApiPost(route, payload) {
  if (!LICENSE_SERVER_URL) throw new Error('license_server_url not configured');
  const url = `${LICENSE_SERVER_URL}${route}`;
  const resp = await axios.post(url, payload, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });
  return resp.data || {};
}

async function refreshLicenseState() {
  licenseState.lastCheckedAt = new Date().toISOString();
  licenseState.reason = null;
  licenseState.expiresAt = null;

  if (!LICENSE_SERVER_URL) {
    licenseState.mode = 'locked';
    licenseState.licensed = false;
    licenseState.trialActive = false;
    licenseState.reason = 'license_server_not_configured';
    return;
  }

  const fp = ensureInstanceFingerprint();

  if (licenseKey) {
    try {
      const out = await licenseApiPost('/api/license/validate', { license_key: licenseKey, instance_fingerprint: fp });
      if (out?.licensed) {
        licenseState.mode = 'licensed';
        licenseState.licensed = true;
        licenseState.wildcard = !!out.wildcard;
        licenseState.trialActive = false;
        licenseState.expiresAt = out.expires_at || null;
        return;
      }
      if (out?.expired) {
        licenseState.mode = 'locked';
        licenseState.licensed = false;
        licenseState.trialActive = false;
        licenseState.reason = 'license_expired';
        licenseState.expiresAt = out.expires_at || null;
      }
    } catch (e) {
      licenseState.reason = `license_validate_error: ${e.message}`;
    }
  }

  try {
    const trial = await licenseApiPost('/api/trial/start', { instance_fingerprint: fp, email: licenseEmail || '' });
    licenseState.trialActive = !!trial?.trial_active;
    licenseState.trialEndsAt = trial?.trial_ends_at || null;
    if (licenseState.trialActive) {
      licenseState.mode = 'trial';
      licenseState.licensed = false;
      return;
    }
  } catch (e) {
    if (!licenseState.reason) licenseState.reason = `trial_error: ${e.message}`;
  }

  licenseState.mode = 'locked';
  licenseState.licensed = false;
  licenseState.trialActive = false;
}

async function postInbound(fromJid, message, raw) {
  if (!licenseAllowsMessaging()) {
    appendLog({ ts: new Date().toISOString(), direction: 'receive', from: `+${toDigits(fromJid)}`, message: message || '', status: 'blocked_unlicensed' });
    return;
  }
  if (!WEBHOOK_URL) return;
  const fromDigits = toDigits(fromJid);

  if (!allowedSender(fromDigits)) {
    appendLog({ ts: new Date().toISOString(), direction: 'receive', from: `+${fromDigits}`, message: message || '', status: 'ignored', reason: 'not_allowlisted' });
    return;
  }

  const payload = { from: `+${fromDigits}`, message: message || '', raw };
  const headers = { 'Content-Type': 'application/json' };
  if (WEBHOOK_BEARER) headers.Authorization = `Bearer ${WEBHOOK_BEARER}`;

  try {
    await axios.post(WEBHOOK_URL, payload, {
      headers,
      timeout: 15000,
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
    });
    appendLog({ ts: new Date().toISOString(), direction: 'receive', from: `+${fromDigits}`, message: message || '', status: 'forwarded' });
  } catch (e) {
    lastError = `Webhook post failed: ${e.message}`;
    appendLog({ ts: new Date().toISOString(), direction: 'receive', from: `+${fromDigits}`, message: message || '', status: 'webhook_error', error: e.message });
  }
}

function authRequired(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const fromDashboard = String(req.headers['x-dashboard-ui'] || '') === '1';
  if (fromDashboard) return next();
  if (!AUTH_TOKEN || token === AUTH_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

function renderDashboard() {
  const status = paired ? '✅ Linked' : '⚠️ Not linked';
  const err = lastError ? `<p style="color:#b00020"><b>Last error:</b> ${lastError}</p>` : '';
  const qrBlock = latestQrImage
    ? `<img src="${latestQrImage}" style="max-width:320px"/><p>Scan this QR in WhatsApp → Linked Devices</p>`
    : '<p>No QR currently available. If already linked, this is normal.</p>';

  const licenseText = licenseState.licensed
    ? `Licensed${licenseState.wildcard ? ' (developer wildcard)' : ''}${licenseState.expiresAt ? ` • Expires: ${licenseState.expiresAt}` : ''}`
    : licenseState.trialActive
      ? `Trial active • Ends: ${licenseState.trialEndsAt || '-'}`
      : `Locked${licenseState.reason ? ` • ${licenseState.reason}` : ''}`;

  return `<!doctype html><html><head><meta charset="utf-8"/>
  <title>Iteology WhatsApp</title>\n  <link rel="icon" type="image/svg+xml" href="${ITEOLOGY_ICON}"/>
  <style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:1100px;margin:18px auto;padding:0 12px}
  .row{display:flex;gap:12px;flex-wrap:wrap}.card{border:1px solid #ddd;border-radius:10px;padding:12px;flex:1 1 330px}
  button{padding:8px 12px;border-radius:8px;border:1px solid #888;background:#f7f7f7;cursor:pointer}
  input,textarea{padding:7px;border:1px solid #bbb;border-radius:7px;width:100%} textarea{min-height:86px}
  code{background:#f3f3f3;padding:2px 4px;border-radius:4px}
  form{margin:8px 0}
  </style></head><body>
  <h2 style="display:flex;align-items:center;gap:10px"><img src="${ITEOLOGY_ICON}" alt="Iteology WhatsApp" style="width:38px;height:38px;border-radius:9px"/>Iteology WhatsApp</h2>\n  <p><a href="https://whatsappha.webeology.app" target="_blank" rel="noopener noreferrer">Visit Iteology WhatsApp</a></p>
  <p><b>Status:</b> ${status} ${reconnecting ? '(reconnecting...)' : ''}<br/><b>Self JID:</b> ${selfJid || '-'}<br/><b>License:</b> ${licenseText}</p>
  ${err}
  <div class="row">
    <div class="card">
      <h3>Connection</h3>
      ${qrBlock}
      <form method="POST" action="reconnect-ui"><button type="submit">Reconnect now</button></form>
    </div>
    <div class="card">
      <h3>License</h3>
      <form method="POST" action="license/start-trial-ui">
        <p><input name="email" placeholder="Email" value="${licenseEmail || ''}"/></p>
        <p><button type="submit">Start/Refresh Trial</button></p>
      </form>
      <form method="POST" action="license/activate-ui">
        <p><input name="email" placeholder="Email" value="${licenseEmail || ''}"/></p>
        <p><input name="license_key" placeholder="License key" value="${licenseKey || ''}"/></p>
        <p><button type="submit">Activate License</button></p>
      </form>
      <form method="POST" action="license/release-ui">
        <p><input name="license_key" placeholder="License key" value="${licenseKey || ''}"/></p>
        <p><button type="submit">Release License</button></p>
      </form>
      <form method="POST" action="license/create-order-ui">
        <p><input name="email" placeholder="Email" value="${licenseEmail || ''}"/></p>
        <p><button type="submit">Buy License</button></p>
      </form>
    </div>
  </div>\n  <div class="card" style="margin-top:12px">\n    <h3>Technology & Service Notice</h3>\n    <p style="line-height:1.45;color:#333">This add-on uses a WhatsApp-compatible technology layer to deliver messaging features. Service availability depends on continued support of that technology by WhatsApp and related upstream services. The add-on and its creator cannot be held liable if those external services change or discontinue support. If this happens, the developer will make reasonable efforts to update the software for compatibility. The technology is currently stable and expected to remain reliable long-term, but all usage is at your own risk.</p>\n  </div>\n  </body></html>`;
}

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(renderDashboard());
});

app.get('/health', (req, res) => {
  res.json({ ok: true, paired, reconnecting, hasQr: !!latestQrText, ts: new Date().toISOString() });
});

app.get('/qr', (req, res) => {
  res.json({ ok: true, hasQr: !!latestQrText, qr: latestQrText, qrImage: latestQrImage });
});


app.post('/reconnect-ui', async (req, res) => {
  try {
    reconnecting = true;
    paired = false;
    lastError = null;
    latestQrText = null;
    latestQrImage = null;
    if (sock?.end) {
      try { sock.end(new Error('manual reconnect')); } catch (_) {}
    }
    setTimeout(() => { startSock(true).catch((e) => { lastError = `Reconnect failed: ${e.message}`; reconnecting = false; }); }, 300);
  } catch (e) {
    lastError = `Reconnect failed: ${e.message}`;
  }
  res.redirect(req.get('referer') || '.');
});

app.post('/license/start-trial-ui', async (req, res) => {
  try {
    if (req.body?.email) licenseEmail = String(req.body.email).trim();
    await refreshLicenseState();
    saveLocalLicense();
  } catch (e) {
    lastError = `Trial failed: ${e.message}`;
  }
  res.redirect(req.get('referer') || '.');
});

app.post('/license/create-order-ui', async (req, res) => {
  try {
    if (!LICENSE_SERVER_URL) throw new Error('license_server_url_not_configured');
    const email = String(req.body?.email || licenseEmail || '').trim();
    if (!email) throw new Error('email_required');
    licenseEmail = email;
    const out = await licenseApiPost('/api/paypal/create-order', { email });
    saveLocalLicense();
    if (out?.approve_url) return res.redirect(out.approve_url);
    throw new Error('approve_url_missing');
  } catch (e) {
    lastError = `Buy failed: ${e.message}`;
    res.redirect(req.get('referer') || '.');
  }
});

app.post('/license/activate-ui', async (req, res) => {
  try {
    if (!LICENSE_SERVER_URL) throw new Error('license_server_url_not_configured');
    const key = String(req.body?.license_key || '').trim().toUpperCase();
    const email = String(req.body?.email || licenseEmail || '').trim();
    if (!key) throw new Error('license_key_required');
    licenseKey = key;
    licenseEmail = email;
    const out = await licenseApiPost('/api/license/activate', { license_key: key, instance_fingerprint: ensureInstanceFingerprint() });
    if (!out?.licensed) throw new Error(out?.error || 'license_not_activated');
    await refreshLicenseState();
    saveLocalLicense();
  } catch (e) {
    lastError = `Activation failed: ${e.message}`;
  }
  res.redirect(req.get('referer') || '.');
});

app.post('/license/release-ui', async (req, res) => {
  try {
    if (!LICENSE_SERVER_URL) throw new Error('license_server_url_not_configured');
    const key = String(req.body?.license_key || licenseKey || '').trim().toUpperCase();
    if (!key) throw new Error('license_key_required');
    await licenseApiPost('/api/license/release', { license_key: key, instance_fingerprint: ensureInstanceFingerprint() });
    licenseKey = '';
    await refreshLicenseState();
    removeLocalLicense();
    saveLocalLicense();
  } catch (e) {
    lastError = `Release failed: ${e.message}`;
  }
  res.redirect(req.get('referer') || '.');
});

app.get('/status', authRequired, (req, res) => {
  res.json({ ok: true, paired, reconnecting, selfJid, hasQr: !!latestQrText, lastError, allowlist: ALLOWLIST, allowAllInbound: ALLOW_ALL_INBOUND, logRetentionDays: LOG_RETENTION_DAYS, license: licenseState, instanceFingerprint });
});

app.post('/license/start-trial', authRequired, async (req, res) => {
  try {
    if (req.body?.email) licenseEmail = String(req.body.email).trim();
    await refreshLicenseState();
    saveLocalLicense();
    res.json({ ok: true, license: licenseState });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/license/create-order', authRequired, async (req, res) => {
  try {
    if (!LICENSE_SERVER_URL) return res.status(400).json({ ok: false, error: 'license_server_url_not_configured' });
    const email = String(req.body?.email || licenseEmail || '').trim();
    if (!email) return res.status(400).json({ ok: false, error: 'email_required' });
    licenseEmail = email;
    const out = await licenseApiPost('/api/paypal/create-order', { email });
    saveLocalLicense();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/license/activate', authRequired, async (req, res) => {
  try {
    if (!LICENSE_SERVER_URL) return res.status(400).json({ ok: false, error: 'license_server_url_not_configured' });
    const key = String(req.body?.license_key || '').trim().toUpperCase();
    const email = String(req.body?.email || licenseEmail || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'license_key_required' });
    licenseKey = key;
    licenseEmail = email;
    const out = await licenseApiPost('/api/license/activate', { license_key: key, instance_fingerprint: ensureInstanceFingerprint() });
    if (!out?.licensed) return res.status(400).json({ ok: false, error: 'license_not_activated', raw: out });
    await refreshLicenseState();
    saveLocalLicense();
    res.json({ ok: true, license: licenseState });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/license/release', authRequired, async (req, res) => {
  try {
    if (!LICENSE_SERVER_URL) return res.status(400).json({ ok: false, error: 'license_server_url_not_configured' });
    const key = String(req.body?.license_key || licenseKey || '').trim().toUpperCase();
    if (!key) return res.status(400).json({ ok: false, error: 'license_key_required' });
    await licenseApiPost('/api/license/release', { license_key: key, instance_fingerprint: ensureInstanceFingerprint() });
    licenseKey = '';
    await refreshLicenseState();
    removeLocalLicense();
    saveLocalLicense();
    res.json({ ok: true, license: licenseState });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/logs', authRequired, (req, res) => {
  const limit = Number(req.query?.limit || 250);
  const days = Number(req.query?.days || LOG_RETENTION_DAYS);
  res.json({ ok: true, retentionDays: LOG_RETENTION_DAYS, logs: readLogs(limit, days) });
});

app.get('/logs.csv', (req, res) => {
  const token = String(req.query?.token || '');
  if (AUTH_TOKEN && token !== AUTH_TOKEN) return res.status(401).send('unauthorized');
  const limit = Number(req.query?.limit || 2000);
  const days = Number(req.query?.days || LOG_RETENTION_DAYS);
  const csv = logsToCsv(readLogs(limit, days));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="whatsapp-send-receive-log.csv"');
  res.send(csv);
});

app.post('/logs/clear', authRequired, (req, res) => {
  try {
    clearLogs();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/send', authRequired, async (req, res) => {
  try {
    await refreshLicenseState();
    if (!licenseAllowsMessaging()) return res.status(403).json({ ok: false, error: 'license_required', license: licenseState });
    if (!sock) return res.status(503).json({ ok: false, error: 'socket not ready' });
    const to = normalizeMsisdn(req.body?.to || req.body?.target);
    const message = String(req.body?.message || '').trim();
    if (!to || !message) return res.status(400).json({ ok: false, error: 'to/target and message required' });
    await sock.sendMessage(to, { text: message });
    appendLog({ ts: new Date().toISOString(), direction: 'send', to: `+${toDigits(to)}`, message, status: 'sent' });
    res.json({ ok: true });
  } catch (e) {
    lastError = `Send failed: ${e.message}`;
    appendLog({ ts: new Date().toISOString(), direction: 'send', to: `+${toDigits(req.body?.to || req.body?.target)}`, message: String(req.body?.message || ''), status: 'send_error', error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/reconnect', authRequired, async (req, res) => {
  try {
    reconnecting = true;
    paired = false;
    lastError = null;
    latestQrText = null;
    latestQrImage = null;
    if (sock?.end) {
      try { sock.end(new Error('manual reconnect')); } catch (_) {}
    }
    setTimeout(() => { startSock(true).catch((e) => { lastError = `Reconnect failed: ${e.message}`; reconnecting = false; }); }, 300);
    res.json({ ok: true, message: 'reconnect requested' });
  } catch (e) {
    reconnecting = false;
    lastError = `Reconnect failed: ${e.message}`;
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function startSock(force = false) {
  if (reconnecting && !force) return;
  reconnecting = true;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrText = qr;
      latestQrImage = await QRCode.toDataURL(qr);
    }

    if (connection === 'open') {
      reconnecting = false;
      paired = true;
      latestQrText = null;
      latestQrImage = null;
      selfJid = sock?.user?.id || null;
      lastError = null;
    }

    if (connection === 'close') {
      paired = false;
      reconnecting = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startSock(true).catch((e) => { lastError = `Auto reconnect failed: ${e.message}`; }), 3000);
      } else {
        lastError = 'Logged out; re-link required';
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !messages?.length) return;
    for (const m of messages) {
      if (!m.message || m.key?.fromMe) continue;
      const txt = getMessageText(m).trim();
      if (!txt) continue;
      await refreshLicenseState();
      await postInbound(m.key?.remoteJid, txt, m);
    }
  });
}

app.listen(PORT, async () => {
  console.log(`Iteology WhatsApp Connector listening on :${PORT}`);
  maybePruneLogs(true);
  loadLocalLicense();
  ensureInstanceFingerprint();
  await refreshLicenseState();

  setInterval(() => {
    refreshLicenseState().catch((e) => { lastError = `License refresh failed: ${e.message}`; });
  }, 5 * 60 * 1000);

  try {
    await startSock(true);
  } catch (e) {
    reconnecting = false;
    lastError = `Init failed: ${e.message}`;
    console.error(e);
  }
});
