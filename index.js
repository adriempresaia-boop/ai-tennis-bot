// index.js — Bot Full Ace -> Google Sheets + servidor Express de estado
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { chromium } = require('playwright');
const { GoogleAuth } = require('google-auth-library');
const { sheets_v4 } = require('@googleapis/sheets');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// ------- ENV -------
const {
  BETTING_URL,
  SPREADSHEET_ID,

  // Credenciales (elige una de las dos formas):
  // a) GCP_SA_JSON con el JSON entero (líneas escapadas)
  // b) GS_CLIENT_EMAIL + GS_PRIVATE_KEY
  GCP_SA_JSON, GS_CLIENT_EMAIL, GS_PRIVATE_KEY,

  // Ajustes
  LOOP_DELAY_MS, HEADLESS, SCROLL_MS, DEBUG, DIAG_ECHO,

  // Alertas opcionales (Slack/Telegram via webhook)
  ALERT_WEBHOOK_URL, ALERT_WEBHOOK_BEARER, ALERT_MIN_COOLDOWN_MIN,

  // Rachas/H2H
  STREAK_LAST_N,

  // Puerto Express (Railway)
  PORT
} = process.env;

const LOOP_MS  = parseInt(LOOP_DELAY_MS || '45000', 10);
const LAST_N   = parseInt(STREAK_LAST_N || '10', 10);
const COOL_MIN = parseInt(ALERT_MIN_COOLDOWN_MIN || '10', 10);

function log(...args){ if(String(DEBUG||'').trim()==='1') console.log('[DBG]', ...args); }

// ------- PERSISTENCIA -------
function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function saveJSON(f, d)  { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

const MATCHUPS = loadJSON('./matchups.json', []);
const RULES    = loadJSON('./rules.json',   []);
const STATE    = loadJSON('./state.json',   { streaks: {}, lastAlertAt: null });
const CACHE    = loadJSON('./cache.json',   { seen: {} });

// status en memoria para /status
const STATUS = {
  startedAt: new Date().toISOString(),
  lastCycleAt: null,
  lastCycle: { cards: 0, appended: 0 },
  lastPageTitle: '',
  lastPageUrl: '',
  lastTextSample: ''
};

// ------- NORM NOMBRES -------
const ALIASES = {
  "Bautista Agut, Roberto": "Roberto Bautista Agut",
  "Carreño Busta, Pablo": "Pablo Carreño Busta",
  "Carreno Busta, Pablo": "Pablo Carreño Busta",
  "Carreno": "Pablo Carreño Busta",
  "Carreño": "Pablo Carreño Busta",
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
  "López, Feliciano": "Feliciano Lopez",
  "Kokkinakis, Thanasi": "Thanasi Kokkinakis",
  "Auger-Aliassime, Felix": "Felix Auger-Aliassime",
  "Félix Auger Aliassime": "Felix Auger-Aliassime",
  "Fognini, Fabio": "Fabio Fognini",
  "Korda, Sebastian": "Sebastian Korda"
};
function norm(s){
  if (!s) return '';
  s = s.trim();
  if (ALIASES[s]) return ALIASES[s];
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}
function mid(a, b) {
  const [x, y] = [norm(a), norm(b)].sort((p, q) => p.localeCompare(q));
  return `${x} vs ${y}`;
}

// ------- GOOGLE SHEETS -------
function getCredsFromEnv(){
  if (GCP_SA_JSON) {
    const obj = JSON.parse(GCP_SA_JSON);
    return { client_email: obj.client_email, private_key: (obj.private_key || '').replace(/\\n/g,'\n') };
  }
  return { client_email: GS_CLIENT_EMAIL, private_key: (GS_PRIVATE_KEY || '').replace(/\\n/g,'\n') };
}
async function getSheets(){
  const auth = new GoogleAuth({ credentials: getCredsFromEnv(), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return new sheets_v4.Sheets({ auth });
}
async function read(s, range){
  const r = await s.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return r.data.values || [];
}
async function clearUpdate(s, range, values){
  await s.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range });
  if(values.length){
    await s.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range, valueInputOption:'USER_ENTERED', requestBody:{ values }
    });
  }
}
async function append(s, range, row){
  await s.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range, valueInputOption:'USER_ENTERED', requestBody:{ values:[row] }
  });
}

// ------- RACHAS/H2H -------
function updateStreak(prev,winner,ts){ let owner=prev?.owner||null,len=prev?.len||0;
  if(!owner||winner!==owner){ owner=winner; len=1; } else { len++; }
  return { owner,len,last_ts:ts }; }
function throttle(){ if(!STATE.lastAlertAt) return false;
  const diff=(Date.now()-new Date(STATE.lastAlertAt).getTime())/60000;
  return diff < COOL_MIN;
}
async function alert({mid,owner,len,min,score}){
  const now = new Date().toISOString();
  const txt=`🎾 Racha alcanzada\n• Enfrentamiento: ${mid}\n• Ganador actual: ${owner}\n• Racha: ${len}\n• Umbral: ${min}\n• Marcador: ${score}\n• ${now}`;
  if(!ALERT_WEBHOOK_URL){ console.log('[ALERTA]',txt); return; }
  const headers={'Content-Type':'application/json'};
  if(ALERT_WEBHOOK_BEARER) headers.Authorization=`Bearer ${ALERT_WEBHOOK_BEARER}`;
  await fetch(ALERT_WEBHOOK_URL,{method:'POST',headers,body:JSON.stringify({text:txt})});
  STATE.lastAlertAt=new Date().toISOString(); saveJSON('./state.json',STATE);
}
function computeTables(rows){
  const by={};
  for(const r of rows){ const [ts,id,a,b,w]=r; if(!id||!w) continue;
    by[id]=by[id]||[]; by[id].push({ts,a:norm(a),b:norm(b),w:norm(w)}); }
  const H2H=[['matchup_id','wins_playerA','wins_playerB','total']];
  const ST=[['matchup_id','current_streak_owner','current_streak_len','last_N','last_N_wins_ownerA','last_N_wins_ownerB','last_N_sequence']];
  for(const [id,arr] of Object.entries(by)){
    arr.sort((x,y)=>new Date(x.ts)-new Date(y.ts));
    const [pA,pB]=[arr[0].a,arr[0].b].sort((p,q)=>p.localeCompare(q));
    let wA=0,wB=0,owner=null,len=0;
    for(const e of arr){ if(e.w===pA) wA++; else if(e.w===pB) wB++; if(!owner||e.w!==owner){owner=e.w;len=1;} else {len++;}}
    const last=arr.slice(-LAST_N).reverse();
    const lA=last.filter(e=>e.w===pA).length; const lB=last.filter(e=>e.w===pB).length;
    const seq=last.map(e=>e.w.split(' ')[0]).join(' | ');
    H2H.push([id,wA,wB,wA+wB]); ST.push([id,owner||'',len||0,LAST_N,lA,lB,seq]);
  }
  return {H2H,ST};
}
async function ensureHeaders(s){
  const r=await read(s,'Results!A:I');
  if(!r.length){ await clearUpdate(s,'Results!A:I',[['timestamp','matchup_id','player_a','player_b','winner','loser','win_type','source_url','dedupe_key']]); }
  const h=await read(s,'H2H!A:D'); if(!h.length) await clearUpdate(s,'H2H!A:D',[['matchup_id','wins_playerA','wins_playerB','total']]);
  const st=await read(s,'Streaks!A:G'); if(!st.length) await clearUpdate(s,'Streaks!A:G',[['matchup_id','current_streak_owner','current_streak_len','last_N','last_N_wins_ownerA','last_N_wins_ownerB','last_N_sequence']]);
  const a=await read(s,'Alerts!A:F'); if(!a.length) await clearUpdate(s,'Alerts!A:F',[['timestamp','matchup_id','winner','streak_len','rule_min_streak','note']]);
}

// ------- PLAYWRIGHT HELPERS -------
async function clickIfVisible(page, text){
  const btn = page.getByRole('button', { name: new RegExp(text, 'i') });
  if(await btn.count()){ await btn.first().click().catch(()=>{}); return true; }
  const tab = page.locator(`:is(a,button,div,span)[role="tab"]:has-text("${text}")`);
  if(await tab.count()){ await tab.first().click().catch(()=>{}); return true; }
  const any = page.locator(`:text("${text}")`);
  if(await any.count()){ await any.first().click().catch(()=>{}); return true; }
  return false;
}
async function autoScroll(page, ms=3000){
  const endAt = Date.now() + ms;
  while(Date.now()<endAt){
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(250);
  }
}
async function dumpPage(page){
  STATUS.lastPageUrl = page.url();
  STATUS.lastPageTitle = await page.title().catch(()=> '');
  STATUS.lastTextSample = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(()=> '');
  console.log('[DBG] PAGE URL:', STATUS.lastPageUrl);
  console.log('[DBG] PAGE TITLE:', STATUS.lastPageTitle);
  console.log('[DBG] PAGE TEXT SAMPLE:', STATUS.lastTextSample);
}

// ------- DETECCIÓN DE PARTIDOS -------
// Marcadores finales válidos
const SCORE_RE = /\b(2-0|0-2|3-1|1-3|3-2|2-3)\b/;

function pickPlayersFromText(text){
  const present = [];
  for (const m of MATCHUPS) {
    const A = norm(m.a), B = norm(m.b);
    const rxA = new RegExp(`\\b${A}\\b`, 'i');
    const rxB = new RegExp(`\\b${B}\\b`, 'i');
    if (rxA.test(text) && rxB.test(text)) {
      const idxA = text.search(rxA);
      const idxB = text.search(rxB);
      if (idxA <= idxB) present.push({ a: A, b: B });
      else              present.push({ a: B, b: A });
    }
  }
  return present[0] || null;
}
function winnerFromScore(pair, score){
  const [n1, n2] = score.split('-').map(x => parseInt(x,10));
  if (Number.isNaN(n1) || Number.isNaN(n2)) return null;
  if (n1 === n2) return null;
  return (n1 > n2) ? pair.a : pair.b; // primer número para primer jugador
}

// ------- SCRAPE -------
async function scrapeOnce(page, s) {
  await page.goto(BETTING_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});

  // aceptar cookies si aparece
  for (const label of ['Aceptar','Acepto','OK','De acuerdo','I agree','Accept']) {
    const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') });
    if (await btn.count()) { await btn.first().click().catch(() => {}); break; }
  }

  // pestaña tennis
  await clickIfVisible(page, 'AI Tennis').catch(()=>{});
  await clickIfVisible(page, 'vTennis').catch(()=>{});
  await clickIfVisible(page, 'Tennis').catch(()=>{});
  await page.waitForTimeout(600);
  await autoScroll(page, parseInt(SCROLL_MS || '4000',10));

  // recolecta nodos
  const nodes = await page.locator('section, article, div').all();
  let cards = [];
  for (const node of nodes.slice(0, 600)) {
    const txt = (await node.textContent().catch(()=> '') || '').replace(/\s+/g,' ').trim();
    if (!txt) continue;

    const m = txt.match(SCORE_RE);
    if (!m) continue;

    const pair = pickPlayersFromText(txt);
    if (!pair) continue;

    cards.push({ node, text: txt, score: m[1], pair });
  }

  if (cards.length === 0) {
    log('No se detectaron tarjetas con marcador final y nombres conocidos.');
    if (parseInt(DIAG_ECHO||'0',10) > 0) await dumpPage(page);
  }

  const now = new Date().toISOString();
  let appended = 0;

  for (const c of cards) {
    const id = mid(c.pair.a, c.pair.b);
    const winner = winnerFromScore(c.pair, c.score);
    if (!winner) {
      if (parseInt(DIAG_ECHO||'0',10) > 0) {
        console.log('--- DIAG CARD (sin ganador deducible) ---');
        console.log(c.text.slice(0, 1400));
        console.log('-----------------------------------------');
      }
      continue;
    }
    const loser = (winner === c.pair.a) ? c.pair.b : c.pair.a;

    // evita duplicados (por día)
    const key = `${id}|${winner}|${c.score}|${now.slice(0,10)}`;
    if (CACHE.seen[key]) continue;

    await append(s, 'Results!A:I', [
      now, id, c.pair.a, c.pair.b, winner, loser, c.score, BETTING_URL, key
    ]);
    CACHE.seen[key] = true; saveJSON('./cache.json', CACHE);
    appended++;

    // rachas + reglas
    const st = updateStreak(STATE.streaks[id], winner, now);
    STATE.streaks[id] = st; saveJSON('./state.json', STATE);

    const rules = RULES.filter(r => r.matchup === id);
    for (const r of rules) {
      const ok  = (r.player === 'ANY') || (norm(r.player) === st.owner);
      const thr = Number(r.min_streak || 0);
      if (ok && st.len >= thr && !throttle()) {
        await alert({ mid:id, owner:st.owner, len:st.len, min:thr, score:c.score });
        await append(s, 'Alerts!A:F', [now, id, st.owner, st.len, thr, `score=${c.score}`]);
      }
    }
  }

  log(`CICLO: tarjetas=${cards.length}, nuevos=${appended}`);
  STATUS.lastCycleAt = new Date().toISOString();
  STATUS.lastCycle = { cards: cards.length, appended };

  // refresca H2H/Streaks
  const all  = await read(s, 'Results!A:I');
  const rows = all.slice(1);
  const { H2H, ST } = computeTables(rows);
  await clearUpdate(s, 'H2H!A:D', H2H);
  await clearUpdate(s, 'Streaks!A:G', ST);
}

// ------- LOOP PRINCIPAL -------
async function main(){
  const browser = await chromium.launch({
    headless: String(HEADLESS || 'false').toLowerCase() === 'true'
  });
  const context = await browser.newContext({
    viewport: { width: 420, height: 860 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36'
  });
  const page = await context.newPage();

  const s = await getSheets();
  await ensureHeaders(s);

  // bucle
  while (true) {
    try { await scrapeOnce(page, s); }
    catch (e) { console.error('scrapeOnce error:', e && e.stack || e); }
    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

// ------- EXPRESS (para URL pública en Railway) -------
const app = express();
app.get('/', (_, res) => {
  res.type('html').send(
    `<html><body style="font-family:system-ui;padding:20px">
      <h1>🎾 Tennis Bot is running</h1>
      <p>Started: ${STATUS.startedAt}</p>
      <p>Last cycle: ${STATUS.lastCycleAt || '-'}</p>
      <p>Last: cards=${STATUS.lastCycle.cards}, appended=${STATUS.lastCycle.appended}</p>
      <p><a href="/status">/status</a></p>
    </body></html>`
  );
});
app.get('/status', (_, res) => res.json(STATUS));
app.listen(PORT || 8080, () => console.log('HTTP server ready on', PORT || 8080));

// ------- START -------
main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
