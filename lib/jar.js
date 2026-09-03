'use strict';
// Gestionnaire de session anonyme + mémoire conversationnelle, persistés dans
// un seul fichier d'état (.plai-state.json).
//
// Cookies : le serveur garde 1..N cookies `web_anon_session` (valeur + expiration).
//   - rotation round-robin (moins récemment utilisé d'abord)
//   - renouvellement préventif ~10 min avant expiration (si autoMint)
//   - sur 403 anon_required : invalidation immédiate + mint en single-flight
// Histoires uid : {uid: [{role, content}, …]} — tronquées à maxHistory.

const fs = require('fs');
const cfg = require('./config');
const { log, ApiError } = require('./util');
const { chatSend } = require('./plai');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try {
    const raw = fs.readFileSync(cfg.stateFile, 'utf8');
    const j = JSON.parse(raw);
    return {
      cookies: Array.isArray(j.cookies) ? j.cookies : [],
      histories: j.histories && typeof j.histories === 'object' ? j.histories : {},
    };
  } catch {
    return { cookies: [], histories: {} };
  }
}

let state = loadState();
let saving = Promise.resolve();
function save() {
  // Écritures sérialisées, best-effort (le fichier n'est qu'un cache de session).
  const payload = JSON.stringify(state);
  saving = saving.then(() => new Promise((resolve) => {
    fs.writeFile(cfg.stateFile, payload, () => resolve());
  }));
  return saving;
}

// Cookie fourni par PLAI_COOKIE : sert de graine quand le pool est vide (utile en
// serverless : le fichier d'état n'existe pas). S'il est rejeté par le serveur
// (403 anon_required), on le « empoisonne » pour ne pas le réutiliser en boucle.
const envPoisoned = new Set();
function seedFromEnv() {
  if (!cfg.cookieEnv) return null;
  const m = cfg.cookieEnv.match(/web_anon_session=([0-9a-fA-F]{8,128})/);
  if (!m) return null;
  const value = m[1];
  if (envPoisoned.has(value)) return null;
  if (state.cookies.some((c) => c.value === value)) return null;
  const ck = { value, expiresAt: Date.now() + cfg.cookieTtlMs, seeded: true };
  state.cookies.push(ck);
  log('info', '[jar] cookie fourni par PLAI_COOKIE chargé');
  save();
  return ck;
}
seedFromEnv();

// ---- Renouvellement single-flight via camoufox ----
let minting = null;
function mintNow() {
  if (!minting) {
    minting = (async () => {
      const { mintCookie } = require('./mint');
      const ck = await mintCookie();
      state.cookies = state.cookies.filter((c) => c.value !== ck.value);
      state.cookies.push({ value: ck.value, expiresAt: ck.expiresAt, lastUsed: 0 });
      save();
      return ck;
    })().finally(() => { minting = null; });
  }
  return minting;
}

function validCookies() {
  const now = Date.now();
  return state.cookies.filter((c) => c.expiresAt > now + 30000);
}

// Renvoie un cookie utilisable, ou lance un mint (si autorisé), ou une ApiError.
async function getCookie(forceMint) {
  const pool = validCookies();
  if (!pool.length) {
    const envSeed = seedFromEnv(); // serverless : le cookie d'env repart à chaque requête
    if (envSeed) return envSeed;
  }
  if (validCookies().length) {
    // Moins récemment utilisé d'abord (round-robin).
    const ck = [...pool].sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))[0];
    // Recharge du pool en arrière-plan : sous trafic, on maintient jusqu'à
    // maxCookies sessions (chacune a un budget de messages avant re-vérification).
    if (cfg.autoMint && !minting && validCookies().length < cfg.maxCookies) {
      mintNow().catch((e) => log('warn', '[jar] recharge du pool échouée:', e.message));
    }
    return ck;
  }
  if (cfg.autoMint && forceMint !== false) {
    return mintNow(); // échoue en ApiError mint_failed si camoufox n'y arrive pas
  }
  throw new ApiError(503, 'no_session',
    'Aucun cookie de session anonyme valide. Fournissez PLAI_COOKIE="web_anon_session=…" ' +
    'ou activez PLAI_AUTO_MINT (camoufox-cli requis).');
}

function invalidate(value) {
  const wasSeeded = state.cookies.some((c) => c.value === value && c.seeded);
  if (wasSeeded) envPoisoned.add(value);
  state.cookies = state.cookies.filter((c) => c.value !== value);
  save();
  log('warn', '[jar] cookie invalidé (403 anon), restants:', state.cookies.length);
}

// Exécute fn(cookie) ; si l'amont répond 403 anon_required, invalide le cookie
// et réessaie avec un cookie neuf (mint si besoin) — max 3 tentatives.
async function withCookie(fn, forceMint) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ck = await getCookie(forceMint);
    ck.lastUsed = Date.now();
    save();
    try {
      return await fn(ck.value);
    } catch (err) {
      // Une session « épuisée » répond 403 anon_required, ou parfois reste
      // silencieuse (upstream_stall / upstream_timeout) : on la jette et on
      // repart sur un cookie neuf.
      const retryable = err && (err.code === 'anon_required' || err.code === 'upstream_stall' || err.code === 'upstream_timeout');
      if (retryable) {
        invalidate(ck.value);
        forceMint = true;
        await sleep(500);
        continue;
      }
      throw err;
    }
  }
  throw new ApiError(503, 'session_exhausted', 'Session anonyme introuvable après renouvellements.');
}

// ---- Mémoire par uid ----
function getHistory(uid) {
  return state.histories[uid] || [];
}
function appendTurn(uid, userMsg, assistantMsg) {
  if (!uid) return;
  if (!state.histories[uid]) state.histories[uid] = [];
  const h = state.histories[uid];
  if (userMsg) h.push({ role: 'user', content: userMsg });
  if (assistantMsg) h.push({ role: 'assistant', content: assistantMsg.reply });
  if (h.length > cfg.maxHistory) state.histories[uid] = h.slice(h.length - cfg.maxHistory);
  const keys = Object.keys(state.histories);
  if (keys.length > cfg.maxUids) {
    for (const k of keys.slice(0, keys.length - cfg.maxUids)) delete state.histories[k];
  }
  save();
}
function resetHistory(uid) {
  if (uid && state.histories[uid]) { delete state.histories[uid]; save(); }
}

// Un tour de chat : mémoire uid + message + (option) image.
async function runChat({ uid, prompt, imageDataUrl, imageName, imageType, model, think }) {
  const history = uid ? getHistory(uid) : [];
  const attachments = imageDataUrl
    ? [{ name: imageName || 'image.png', type: imageType || 'image/png', dataUrl: imageDataUrl }]
    : [];
  const res = await withCookie((cookie) =>
    chatSend({ cookie, message: prompt, history, model: model || 'free', attachments, think }));
  if (uid) appendTurn(uid, prompt, res);
  return res;
}

async function sessionInfo() {
  const cookies = state.cookies.map((c) => ({
    expiresInMs: Math.max(0, c.expiresAt - Date.now()),
    lastUsedMsAgo: c.lastUsed ? Date.now() - c.lastUsed : null,
    seeded: !!c.seeded,
  }));
  return { cookies, autoMint: cfg.autoMint, mintCmd: cfg.mintCmd };
}

module.exports = { withCookie, runChat, getHistory, resetHistory, sessionInfo, invalidate, mintNow };
