// index.js — TwentyBet Full Ace Bot: head-to-head + rachas + alertas
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { google } = require('@googleapis/sheets');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const {
  BETTING_URL, SPREADSHEET_ID, GS_CLIENT_EMAIL, GS_PRIVATE_KEY,
  LOOP_DELAY_MS, HEADLESS, ALERT_WEBHOOK_URL, ALERT_WEBHOOK_BEARER,
  ALERT_MIN_COOLDOWN_MIN, STREAK_LAST_N
} = process.env;

const LOOP_MS = parseInt(LOOP_DELAY_MS || '45000', 10);
const LAST_N = parseInt(STREAK_LAST_N || '10', 10);
const COOL_MIN = parseInt(ALERT_MIN_COOLDOWN_MIN || '10', 10);

function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function saveJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }
const MATCHUPS = loadJSON('./matchups.json', []);
const RULES = loadJSON('./rules.json', []);
const STATE = loadJSON('./state.json', { streaks: {}, lastAlertAt: null });
const CACHE = loadJSON('./cache.json', { seen: {} });

const ALIASES = {
  "Bautista Agut, Roberto": "Roberto Bautista Agut",
  "Carreno": "Pablo Carreno Busta",
  "Carreño": "Pablo Carreno Busta",
  "Carreno Busta, Pablo": "Pablo Carreno Busta",
  "Karatsev, Aslan": "Aslan Karatsev",
  "Brooksby, Jenson": "Jenson Brooksby",
  "Nishikori, Kei": "Kei Nishikori",
  "Simon, Gilles": "Gilles Simon",
  "Sock, Jack": "Jack Sock",
  "Gasquet, Richard": "Richard Gasquet",
  "Shapovalov, Denis": "Denis Shapovalov",
  "Thiem, Dominic": "Dominic Thiem",
  "Hurcackz": "Hubert Hurkacz",
  "Hurkackz": "Hubert Hurkacz",
  "Hurkacz, Hubert": "Hubert Hurkacz",
  "Wawrinka, Stan": "Stan Wawrinka",
  "Schwartzman, Diego": "Diego Schwartzman",
  "Kyrgios, Nick": "Nick Kyrgios",
  "Tiafoe, Frances": "Frances Tiafoe",
  "Mussetti": "Lorenzo Musetti",
  "Musetti, Lorenzo": "Lorenzo Musetti",
  "Cilic, Marin": "Marin Cilic",
  "De minaur": "Alex de Minaur",
  "De Minaur, Alex": "Alex de Minaur",
  "Raonic, Milos": "Milos Raonic",
  "Lopez, Feliciano": "Feliciano Lopez",
  "Kokkinakis, Thanasi": "Thanasi Kokkinakis",
  "Auger-Aliassime, Felix": "Felix Auger-Aliassime",
  "Félix Auger Aliassime": "Felix Auger-Aliassime"
};

function norm(s) {
  if (!s) return '';
  s = s.trim();
  if (ALIASES[s]) return ALIASES[s];
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}
function mid(a, b) { const [x, y] = [norm(a), norm(b)].sort((p, q) => p.localeCompare(q)); return `${x} vs ${y}`; }

async function sheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: GS_CLIENT_EMAIL, private_key: GS_PRIVATE_KEY.replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}
async function read(s, range) {
  const r = await s.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return r.data.values || [];
}
async function clearUpdate(s, range, values) {
  await s.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range });
  if (values.length) {
    await s.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range, valueInputOption: 'USER_ENTERED', requestBody: { values }
    });
  }
}
async function append(s, range, row) {
  await s.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range, valueInputOption: 'USER_ENTERED', requestBody: { values: [row] }
  });
}

function updateStreak(prev, winner, ts) {
  let owner = prev?.owner || null, len = prev?.len || 0;
  if (!owner || winner !== owner) { owner = winner; len = 1; } else { len++; }
  return { owner, len, last_ts: ts };
}
function throttle() {
  if (!STATE.lastAlertAt) return false;
  const diff = (Date.now() - new Date(STATE.lastAlertAt).getTime()) / 60000;
  return diff < COOL_MIN;
}
async function alert({ mid, owner, len, min }) {
  const txt = `🎾 Racha alcanzada\n• Enfrentamiento: ${mid}\n• Ganador actual: ${owner}\n• Racha: ${len}\n• Umbral: ${min}\n• ${new Date().toISOString()}`;
  if (!ALERT_WEBHOOK_URL) { console.log('[ALERTA]', txt); return; }
  const headers = { 'Content-Type': 'application/json' };
  if (ALERT_WEBHOOK_BEARER) headers['Authorization'] = `Bearer ${ALERT_WEBHOOK_BEARER}`;
  await fetch(ALERT_WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify({ text: txt }) });
  STATE.lastAlertAt = new Date().toISOString();
  saveJSON('./state.json', STATE);
}

function computeTables(rows) {
  const by = {};
  for (const r of rows) {
    const [ts, id, a, b, winner] = r;
    if (!id || !winner) continue;
    by[id] = by[id] || [];
    by[id].push({ ts, a: norm(a), b: norm(b), w: norm(winner) });
  }
  const H2H = [['matchup_id', 'wins_playerA', 'wins_playerB', 'total']];
  const ST = [['matchup_id', 'current_streak_owner', 'current_streak_len', 'last_N', 'last_N_wins_ownerA', 'last_N_wins_ownerB', 'last_N_sequence']];
  for (const [id, arr] of Object.entries(by)) {
    arr.sort((x, y) => new Date(x.ts) - new Date(y.ts));
    const [pA, pB] = [arr[0].a, arr[0].b].sort((p, q) => p.localeCompare(q));
    let wA = 0, wB = 0, owner = null, len = 0;
    for (const e of arr) {
      if (e.w === pA) wA++; else if (e.w === pB) wB++;
      if (!owner || e.w !== owner) { owner = e.w; len = 1; } else { len++; }
    }
    const last = arr.slice(-LAST_N).reverse();
    const lA = last.filter(e => e.w === pA).length;
    const lB = last.filter(e => e.w === pB).length;
    const seq = last.map(e => e.w.split(' ')[0]).join(' | ');
    H2H.push([id, wA, wB, wA + wB]);
    ST.push([id, owner || '', len || 0, LAST_N, lA, lB, seq]);
  }
  return { H2H, ST };
}

async function ensureHeaders(s) {
  const r = await read(s, 'Results!A:I');
  if (!r.length) {
    await clearUpdate(s, 'Results!A:I', [[
      'timestamp', 'matchup_id', 'player_a', 'player_b', 'winner', 'loser', 'win_type', 'source_url', 'dedupe_key'
    ]]);
  }
  const h = await read(s, 'H2H!A:D');
  if (!h.length) await clearUpdate(s, 'H2H!A:D', [['matchup_id', 'wins_playerA', 'wins_playerB', 'total']]);
  const st = await read(s, 'Streaks!A:G');
  if (!st.length) await clearUpdate(s, 'Streaks!A:G', [['matchup_id', 'current_streak_owner', 'current_streak_len', 'last_N', 'last_N_wins_ownerA', 'last_N_wins_ownerB', 'last_N_sequence']]);
  const a = await read(s, 'Alerts!A:F');
  if (!a.length) await clearUpdate(s, 'Alerts!A:F', [['timestamp', 'matchup_id', 'winner', 'streak_len', 'rule_min_streak', 'note']]);
}

async function scrapeOnce(page, s) {
  await page.goto(process.env.BETTING_URL, { waitUntil: 'domcontentloaded' });

  for (const label of ['Aceptar', 'Acepto', 'OK', 'De acuerdo', 'I agree', 'Accept']) {
    const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') });
    if (await btn.count()) { await btn.first().click().catch(() => {}); break; }
  }

  const cards = await page.locator('div:has-text("Winner")').all();
  const now = new Date().toISOString();

  for (const card of cards) {
    const text = (await card.textContent() || '').replace(/\s+/g, ' ').trim();

    let pair = null;
    for (const m of MATCHUPS) {
      const A = norm(m.a), B = norm(m.b);
      if (new RegExp(`\\b${A}\\b`, 'i').test(text) && new RegExp(`\\b${B}\\b`, 'i').test(text)) {
        pair = { a: A, b: B }; break;
      }
    }
    if (!pair) continue;

    const id = mid(pair.a, pair.b);

    const hasLive = await card.locator(':text("LIVE")').count();
    const disabledOdds = await card.locator('button[disabled], [aria-disabled="true"]').count();
    const looksFinal = (!hasLive && disabledOdds > 0);
    if (!looksFinal) continue;

    let winner = await card.locator('.is-winner, .winner, [data-result="win"], .result-win').first().textContent().catch(() => '');
    winner = norm(winner);

    if (!winner) {
      for (const sel of ['.player:has(.icon-trophy)', '.participant:has(.icon-trophy)', '.market-row.win', '.row.win']) {
        const t = await card.locator(sel).first().textContent().catch(() => '');
        if (t) { winner = norm(t); break; }
      }
    }

    if (!winner) {
      const html = await card.evaluate(el => el.outerHTML);
      fs.mkdirSync('diagnostics', { recursive: true });
      fs.writeFileSync(path.join('diagnostics', `card-${Date.now()}.html`), html);
      console.log('Guardado diagnóstico: diagnostics/card-*.html');
      continue;
    }

    const loser = winner === pair.a ? pair.b : pair.a;
    const key = `${id}|${winner}|${now.slice(0, 10)}`;
    if (CACHE.seen[key]) continue;

    const st = updateStreak(STATE.streaks[id], winner, now);
    STATE.streaks[id] = st; saveJSON('./state.json', STATE);

    await append(s, 'Results!A:I', [now, id, pair.a, pair.b, winner, loser, '', process.env.BETTING_URL, key]);
    CACHE.seen[key] = true; saveJSON('./cache.json', CACHE);

    const rules = RULES.filter(r => r.matchup === id);
    for (const r of rules) {
      const ok = (r.player === 'ANY') || (norm(r.player) === st.owner);
      const thr = Number(r.min_streak || 0);
      if (ok && st.len >= thr && !throttle()) {
        await alert({ mid: id, owner: st.owner, len: st.len, min: thr });
        await append(s, 'Alerts!A:F', [now, id, st.owner, st.len, thr, 'streak reached']);
      }
    }
  }

  const all = await read(s, 'Results!A:I');
  const rows = all.slice(1);
  const { H2H, ST } = computeTables(rows);
  await clearUpdate(s, 'H2H!A:D', H2H);
  await clearUpdate(s, 'Streaks!A:G', ST);
}

async function main() {
  const browser = await chromium.launch({ headless: String(HEADLESS || 'false').toLowerCase() === 'true' });
  const context = await browser.newContext({
    viewport: { width: 420, height: 860 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36'
  });
  const page = await context.newPage();
  const s = await sheets();
  await ensureHeaders(s);

  while (true) {
