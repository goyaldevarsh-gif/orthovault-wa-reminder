/**
 * OrthoVault WhatsApp Reminder Service (Baileys / unofficial)
 * ============================================================
 * This is DELIBERATELY separate from OrthoVault's Firebase Cloud Functions.
 * Unlike the official Meta WhatsApp Business API (which the app also supports
 * and is the recommended path), this connects as a *regular WhatsApp account*
 * via the unofficial Baileys library — the same technique WhatsApp Web itself
 * uses, reverse-engineered. This is NOT sanctioned by WhatsApp/Meta and their
 * Terms of Service prohibit unofficial automation. The number connected here
 * carries a real risk of being banned, with no guaranteed appeal process.
 *
 * ==> Use a SECONDARY number for this, never your primary clinic number. <==
 *
 * WHY THIS CAN'T BE A CLOUD FUNCTION:
 * Baileys needs a persistent, always-open WebSocket connection to WhatsApp's
 * servers (like keeping a WhatsApp Web browser tab open forever) — serverless
 * functions spin down between invocations and can't hold that connection.
 * This file is built to run continuously on Railway.app (or any always-on
 * Node host) via `node index.js`.
 *
 * RAILWAY-SPECIFIC NOTES (read this if deploying there):
 * - Railway expects something listening on a port to consider the service
 *   "alive" — this file runs a tiny HTTP server for that, and doubles it up
 *   as a way to view the QR code from a browser (much easier to scan than
 *   squinting at an ASCII QR code in Railway's log viewer).
 * - Railway's filesystem resets on every redeploy UNLESS you attach a Volume.
 *   Without one, you'd have to re-scan the QR code after every deploy —
 *   attach a Railway Volume mounted at /app/auth_session so the login
 *   persists. See the README for exact steps.
 * - Firebase credentials are read from an environment variable
 *   (FIREBASE_SERVICE_ACCOUNT_JSON) here, not a file — Railway doesn't have
 *   a simple "upload a file" step, but env vars are built in.
 *
 * FIRST-TIME SETUP (Railway):
 * 1. Push this folder to a GitHub repo (private repo recommended).
 * 2. On Railway: New Project → Deploy from GitHub repo → pick this repo.
 * 3. Add a Volume, mounted at /app/auth_session (Settings → Volumes).
 * 4. Add an environment variable FIREBASE_SERVICE_ACCOUNT_JSON — paste the
 *    ENTIRE contents of your Firebase service account JSON file as the value.
 * 5. Deploy. Open the Railway-provided public URL in a browser — it'll show
 *    a QR code. Scan it with the SECONDARY phone's WhatsApp (Settings →
 *    Linked Devices → Link a Device) within the ~60 second validity window.
 * 6. Once linked, the page will say "Connected". You won't need to scan
 *    again unless the Volume is deleted or the phone unlinks the device.
 */

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const cron = require('node-cron');
const admin = require('firebase-admin');
const http = require('http');
const path = require('path');

// ---- Config ----
const AUTH_SESSION_DIR = path.join(__dirname, 'auth_session');
const DELAY_BETWEEN_MESSAGES_MS = 4000; // spacing messages out looks more human, less likely to trip spam detection
const DAILY_CRON_SCHEDULE = '0 9 * * *'; // 9:00 AM
const CRON_TIMEZONE = 'Asia/Kolkata';
const PORT = process.env.PORT || 3000;

// ---- Firebase init (from env var, not a file, so this works on Railway) ----
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('❌ Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable — see the setup steps at the top of this file.');
  process.exit(1);
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (e) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole file contents, unmodified.');
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ---- Shared state for the tiny status/QR web page ----
let lastQrDataUrl = null;
let connectionStatus = 'starting'; // 'starting' | 'awaiting-scan' | 'connected' | 'disconnected'
let lastRunSummary = null;

// ---- Tiny HTTP server: health check + QR code viewer ----
http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (connectionStatus === 'connected') {
    res.end(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2>✅ WhatsApp Connected</h2>
      <p>Reminder service is running. Daily check happens at 9:00 AM IST.</p>
      <p style="color:#666;font-size:13px;">${lastRunSummary ? 'Last run: ' + lastRunSummary : 'No run yet today.'}</p>
      </body></html>`);
  } else if (lastQrDataUrl) {
    res.end(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2>📱 Scan with the SECONDARY WhatsApp number</h2>
      <p>WhatsApp → Settings → Linked Devices → Link a Device</p>
      <img src="${lastQrDataUrl}" style="width:280px;height:280px;" />
      <p style="color:#666;font-size:13px;">This page auto-refreshes every 10s. QR codes expire quickly — if it goes stale, just reload.</p>
      <script>setTimeout(() => location.reload(), 10000);</script>
      </body></html>`);
  } else {
    res.end(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2>⏳ Starting up…</h2><script>setTimeout(() => location.reload(), 5000);</script>
      </body></html>`);
  }
}).listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

// ---- Helpers (mirrors index.html's own date/number/message logic so
// reminders sent from here read identically to ones sent manually in-app) ----

function todayDateString() {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(Date.now() + istOffsetMs);
  return ist.toISOString().slice(0, 10);
}
function todayDateStringFromMillis(ms) {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = new Date(ms + istOffsetMs);
  return ist.toISOString().slice(0, 10);
}
function formatDateForMessage(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00+05:30');
    const withDay = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const dayName = d.toLocaleDateString('en-IN', { weekday: 'short' });
    return withDay + ' (' + dayName + ')';
  } catch (e) { return dateStr; }
}
function toWaJid(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) digits = '91' + digits;
  return digits + '@s.whatsapp.net';
}
function buildReminderMessage(patientName, nextFollowUpDate, isOverdue, doctorName, clinicPhone) {
  const dateFormatted = formatDateForMessage(nextFollowUpDate);
  const dateLine = isOverdue
    ? `\nआपकी फॉलो-अप विज़िट ${dateFormatted} को रखी गई थी।`
    : `\nआपकी अगली फॉलो-अप विज़िट ${dateFormatted} को है — आपका इलाज कैसा चल रहा है, यह देखने के लिए यह ज़रूरी है।`;
  const rescheduleLine = clinicPhone
    ? `\n\nअगर आप नहीं आ पा रहे, कृपया ${clinicPhone} पर कॉल करके नई तारीख तय कर लें, ताकि इलाज बीच में न रुके।`
    : '';
  return `नमस्ते ${patientName} जी,`
    + dateLine
    + `\n\nकृपया साथ लाएं:\n✅ पुराने X-ray/MRI/CT रिपोर्ट\n✅ चल रही दवाइयां`
    + rescheduleLine
    + `\n\nधन्यवाद,\n${doctorName || 'आपका डॉक्टर'}`;
}

const doctorProfileCache = new Map();
async function getDoctorProfileFields(uid) {
  if (doctorProfileCache.has(uid)) return doctorProfileCache.get(uid);
  let result = { doctorName: 'Your Doctor', clinicPhone: '' };
  try {
    const doc = await db.collection('users').doc(uid).collection('meta').doc('profile').get();
    if (doc.exists) {
      const data = doc.data();
      if (data.doctorName) result.doctorName = data.doctorName;
      if (data.clinicPhone) result.clinicPhone = data.clinicPhone;
    }
  } catch (e) {
    console.warn(`Could not load doctor profile for ${uid}:`, e.message);
  }
  doctorProfileCache.set(uid, result);
  return result;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ---- The actual daily job: find today's follow-ups, message each one ----
async function runDailyReminderJob(sock) {
  const today = todayDateString();
  console.log(`\n[${new Date().toISOString()}] Checking for follow-ups due ${today}...`);

  const snapshot = await db.collectionGroup('patients').where('nextFollowUpDate', '==', today).get();
  if (snapshot.empty) {
    console.log('No follow-ups due today. Nothing to send.');
    lastRunSummary = `${today}: nothing due.`;
    return;
  }
  console.log(`Found ${snapshot.size} patient(s) due today.`);

  let sent = 0, skipped = 0, failed = 0;
  for (const docSnap of snapshot.docs) {
    const patient = docSnap.data();
    const patientRef = docSnap.ref;
    const doctorUid = docSnap.ref.parent.parent.id;

    try {
      if (patient.lastAutoReminderSentAt && todayDateStringFromMillis(patient.lastAutoReminderSentAt) === today) {
        skipped++; continue; // already messaged today, don't double-send on a restart/retry
      }
      const jid = toWaJid(patient.whatsapp);
      if (!jid) { skipped++; continue; } // no WhatsApp number on file

      const { doctorName, clinicPhone } = await getDoctorProfileFields(doctorUid);
      const isOverdue = patient.nextFollowUpDate < today; // false here since we queried an exact match, kept for message-text parity
      const message = buildReminderMessage(patient.name || 'Patient', patient.nextFollowUpDate, isOverdue, doctorName, clinicPhone);

      await sock.sendMessage(jid, { text: message });
      await patientRef.set({ lastAutoReminderSentAt: Date.now() }, { merge: true });
      sent++;
      console.log(`  ✓ Sent to ${patient.name}`);
      await sleep(DELAY_BETWEEN_MESSAGES_MS); // pace it out — less bot-like, gentler on the account
    } catch (err) {
      failed++;
      console.error(`  ✗ Failed for ${patient.name || docSnap.id}:`, err.message);
    }
  }
  lastRunSummary = `${today}: sent ${sent}, skipped ${skipped}, failed ${failed}.`;
  console.log(`Done. Sent: ${sent}, Skipped: ${skipped}, Failed: ${failed}.`);
}

// ---- Baileys connection lifecycle ----
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_SESSION_DIR);

  // WhatsApp has been rejecting Baileys' default "Web" platform identification
  // since Feb 2026, and fetchLatestBaileysVersion() can return a stale cached
  // value that WhatsApp no longer accepts. Both fixes below are widely reported
  // as necessary as of mid-2026 \u2014 see WhiskeySockets/Baileys#2248 and related.
  const KNOWN_GOOD_VERSION = [2, 3000, 1044015310]; // last confirmed-working WA Web version as of Jul 2026
  let version = KNOWN_GOOD_VERSION;
  try {
    const fetched = await fetchLatestBaileysVersion();
    if (fetched && fetched.version && fetched.version[2] > KNOWN_GOOD_VERSION[2]) {
      version = fetched.version; // only trust the fetched value if it's genuinely newer
    }
  } catch (e) {
    console.warn('Could not fetch latest WA version, using known-good fallback:', e.message);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'warn' }), // 'silent' if the connection logs feel noisy once things are stable
    printQRInTerminal: false, // we handle QR display ourselves (terminal + web page) below
    browser: Browsers.macOS('Desktop'), // avoids the Platform.WEB rejection issue above
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'awaiting-scan';
      qrcodeTerminal.generate(qr, { small: true }); // still shown in logs as a fallback
      try { lastQrDataUrl = await QRCode.toDataURL(qr); } catch (e) { console.error('QR render failed:', e.message); }
      console.log('\n📱 QR ready — open this service\'s Railway public URL in a browser to scan it.\n');
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`Connection closed (${statusCode}). Logged out: ${loggedOut}.`);
      if (lastDisconnect?.error) {
        console.log('--- Full error detail ---');
        console.log('Message:', lastDisconnect.error.message);
        console.log('Stack:', lastDisconnect.error.stack);
        if (lastDisconnect.error.output) console.log('Output:', JSON.stringify(lastDisconnect.error.output));
        console.log('--------------------------');
      }
      if (loggedOut) {
        console.error('Session was unlinked from the phone — delete the auth_session Volume contents and redeploy to re-link.');
      } else {
        console.log('Reconnecting in 5s...');
        setTimeout(startWhatsApp, 5000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      lastQrDataUrl = null;
      console.log('✅ WhatsApp connected.');
      scheduleDailyJob(sock);
    }
  });

  return sock;
}

let cronScheduled = false;
function scheduleDailyJob(sock) {
  if (cronScheduled) return; // avoid double-scheduling across reconnects
  cronScheduled = true;
  cron.schedule(DAILY_CRON_SCHEDULE, () => {
    runDailyReminderJob(sock).catch(err => console.error('Daily job crashed:', err));
  }, { timezone: CRON_TIMEZONE });
  console.log(`Scheduled daily reminder run for ${DAILY_CRON_SCHEDULE} (${CRON_TIMEZONE}).`);

  // Optional: uncomment to run once immediately on startup for testing,
  // instead of waiting for the next 9 AM slot.
  // runDailyReminderJob(sock).catch(err => console.error('Manual test run crashed:', err));
}

startWhatsApp().catch(err => {
  console.error('Failed to start WhatsApp connection:', err);
  process.exit(1);
});
