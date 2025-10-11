// index.js — versión con PROXY y endpoints de debug
// -------------------------------------------------

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const playwright = require('playwright');

const { google } = require('googleapis');

// ---------- CONFIG ----------
const TARGET_URL = process.env.TARGET_URL || 'https://twentybetzone.com/es/live/fullace';
const PORT = process.env.PORT || 8080;

// Google Sheets
const SHEET_ID = process.env.SHEET_ID; // obligatorio
const SHEET_TAB_RESULTS = 'Results';
const SHEET_TAB_H2H = 'H2H';
const SHEET_TAB_STREAKS = 'Streaks';

// Service Account JSON en env GOOGLE_SERVICE_ACCOUNT_JSON
function getGoogleAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Falta GOOGLE_SERVICE_ACCOUNT_JSON');

  // Se acepta JSON plano o en base64
  const json = raw.trim().startsWith('{')
    ? JSON.parse(raw)
    : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));

  const jwt = new google.auth.JWT({
    email: json.client_email,
    key: json.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return jwt;
}

const sheetsApi = google.sheets('v4');

// ---------- UTILS SHEETS ----------
async function ensureHeaders(auth) {
  const headers = [
    ['timestamp', 'matchup_id', 'player_a', 'player_b', 'winner', 'loser', 'win_type', 'source_url', 'dedupe_key'],
  ];

  // Crea cabeceras si la hoja está vacía
  await sheetsApi.spreadsheets.values.update({
    auth,
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_RESULTS}!A1:I1`,
    valueInputOption: 'RAW',
    requestBody: { values: headers },
  });
}

async function appendResults(auth, rows) {
  if (!rows || rows.length === 0) return;
  await sheetsApi.spreadsheets.values.append({
    auth,
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB_RESULTS}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

// ---------- SCRAPER ----------
function buildProxyOptions() {
  const server = process.env.PROXY_SERVER?.trim();
  if (!server) return undefined;

  const proxy = { server };
  if (process.env.PROXY_USERNAME) proxy.username = process.env.PROXY_USERNAME;
  if (process.env.PROXY_PASSWORD) proxy.password = process.env.PROXY_PASSWORD;
  return proxy;
}

async function createBrowser() {
  const proxy = buildProxyOptions();

  const browser = await playwright.chromium.launch({
    headless: true,
    proxy, // <<< AQUI EL PROXY
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 1800 },
    locale: 'es-ES',
  });

  const page = await context.newPage();
  return { browser, context, page };
}

// Detecta si la página está bloqueada por país
async function checkBlocked(page) {
  const title = await page.title().catch(() => '');
  const bodyText = (await page.textContent('body').catch(() => '')) || '';

  const blocked =
    /country blocked|not available in your country|no disponible en tu país/i.test(title + ' ' + bodyText);

  return { blocked, title, sample: bodyText.slice(0, 300) };
}

// Heurística para extraer tarjetas finalizadas (sin “Winner” en la web)
async function extractFinishedCards(page) {
  // 1) Busca bloques de eventos; ajusta selectores si cambian los estilos
  const cards = await page.$$('[data-testid], div:has-text("LIVE")'); // selector amplio
  const collected = [];

  for (const card of cards) {
    const txt = (await card.innerText().catch(() => '')) || '';
    // nombres (dos líneas con "Jugador, Nombre")
    const nameMatches = txt.match(/^[A-ZÁÉÍÓÚÑ][^\n]+,\s*[A-ZÁÉÍÓÚÑ][^\n]+/gmi) || [];
    if (nameMatches.length < 2) continue;

    // marcador final (ej: 2-0, 3-1, 2-3, 1-3, 0-2, 3-2)
    const scoreMatch = txt.match(/(?:^|\s)([0-3])\s*-\s*([0-3])(?:\s|$)/m);
    if (!scoreMatch) continue;

    const playerA = nameMatches[0].trim();
    const playerB = nameMatches[1].trim();
    const a = parseInt(scoreMatch[1], 10);
    const b = parseInt(scoreMatch[2], 10);

    // Consideramos “final” si alguno llegó a 2 o 3 (según el formato que viste)
    const isFinal = (a >= 2 || b >= 2) && (a !== b);
    if (!isFinal) continue;

    const winner = a > b ? playerA : playerB;
    const loser = a > b ? playerB : playerA;
    const winType = `${a}-${b}`;

    collected.push({
      playerA,
      playerB,
      winner,
      loser,
      winType,
    });
  }

  return collected;
}

function normalizeName(n) {
  return n.toLowerCase().replace(/\s+/g, ' ').trim();
}

function makeMatchupId(a, b) {
  const [x, y] = [normalizeName(a), normalizeName(b)].sort();
  return `${x}__vs__${y}`;
}

async function runCycle(auth) {
  const { browser, page } = await createBrowser();
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // si hay banner de cookies, intenta cerrarlo
    try {
      const cookiesBtn = await page.$('text=/aceptar|accept/i');
      if (cookiesBtn) await cookiesBtn.click({ timeout: 1000 });
    } catch {}

    const blockInfo = await checkBlocked(page);

    if (blockInfo.blocked) {
      console.log('[DBG] Country block detectado.');
      console.log('[DBG] PAGE TITLE:', blockInfo.title);
      console.log('[DBG] PAGE TEXT SAMPLE:', blockInfo.sample);
      return; // no seguimos; con proxy correcto esto no debe salir
    }

    const finished = await extractFinishedCards(page);

    if (finished.length === 0) {
      console.log('[DBG] No se detectaron tarjetas con marcador final y nombres conocidos.');
    } else {
      console.log(`[DBG] Detectadas ${finished.length} tarjetas finalizadas.`);
    }

    // Escribe en Sheets
    const nowIso = new Date().toISOString();
    const rows = finished.map((m) => {
      const matchupId = makeMatchupId(m.playerA, m.playerB);
      const dedupe = `${matchupId}::${m.winType}::${nowIso.slice(0, 13)}`; // hora redondeada
      return [
        nowIso,
        matchupId,
        m.playerA,
        m.playerB,
        m.winner,
        m.loser,
        m.winType,
        TARGET_URL,
        dedupe,
      ];
    });

    await ensureHeaders(auth);
    await appendResults(auth, rows);

    console.log(`[DBG] CICLO: tarjetas=${finished.length}, añadidas=${rows.length}`);
  } catch (err) {
    console.error('[ERR] runCycle:', err);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- LOOP ----------
async function main() {
  if (!SHEET_ID) throw new Error('Falta SHEET_ID en variables de entorno');

  const auth = getGoogleAuth();

  // servidor simple de debug
  const app = express();

  app.get('/', (_, res) =>
    res.send('ai-tennis-bot ✅ — Usa /debug para ver estado y /screenshot para captura (si está habilitado).')
  );

  app.get('/debug', async (_, res) => {
    try {
      const { browser, page } = await createBrowser();
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const title = await page.title().catch(() => '');
      const body = (await page.textContent('body').catch(() => '')) || '';
      await browser.close().catch(() => {});
      res.type('text/plain').send(
        [
          `URL: ${TARGET_URL}`,
          `Title: ${title}`,
          '',
          'Primeros 600 caracteres del body:',
          body.slice(0, 600),
        ].join('\n')
      );
    } catch (e) {
      res.status(500).send(String(e));
    }
  });

  app.listen(PORT, () => console.log(`HTTP server ready on ${PORT}`));

  // ciclo cada 60s
  for (;;) {
    await runCycle(auth);
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
