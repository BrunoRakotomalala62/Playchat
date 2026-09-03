'use strict';
// Petits utilitaires : logs, erreurs typées, fetch « navigateur », lecture SSE.

const cfg = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[cfg.logLevel] ?? 20;

function log(level, ...args) {
  if ((LEVELS[level] ?? 20) < THRESHOLD) return;
  const ts = new Date().toISOString().slice(11, 23);
  console[level === 'debug' ? 'log' : level](`[${ts}] [${level.toUpperCase()}]`, ...args);
}
const debug = (...a) => log('debug', ...a);
const info = (...a) => log('info', ...a);
const warn = (...a) => log('warn', ...a);
const error = (...a) => log('error', ...a);

// Erreur applicative typée, sérialisée en JSON {ok:false, error:{code, message}}.
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  toJSON() {
    return { ok: false, error: { code: this.code, message: this.message, ...this.extra } };
  }
}

// En-têtes d'un navigateur Chrome — sans ça Cloudflare peut répondre 403/1010.
function browserHeaders(extra = {}) {
  return {
    'User-Agent': cfg.http.ua,
    'Accept': '*/*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Origin': cfg.http.origin,
    'Referer': cfg.http.base + '/',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    ...extra,
  };
}

// Télécharge une URL (pour image_url) avec une identité navigateur.
async function downloadUrl(url, maxBytes = cfg.imageMaxBytes, timeoutMs = 20000) {
  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { headers: browserHeaders({ Accept: 'image/*,*/*' }), redirect: 'follow', signal: ctl });
  if (!res.ok) throw new ApiError(502, 'image_download_failed', `Téléchargement de l'image échoué: HTTP ${res.status}`);
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.startsWith('image/')) throw new ApiError(400, 'invalid_image_url', `L'URL ne pointe pas vers une image (content-type: ${ctype || 'inconnu'})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new ApiError(400, 'image_too_large', `Image trop lourde (${buf.length} octets, max ${maxBytes})`);
  return { buf, ctype };
}

// Parse un flux SSE « data: {...}\n\n » en liste d'événements JSON.
function parseSse(body) {
  const events = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('data: ')) {
      try { events.push(JSON.parse(line.slice(6))); } catch { /* ligne malformée : ignorée */ }
    }
  }
  return events;
}

// Reconstruit la réponse finale depuis les événements SSE de /chat/send :
//  - `content` s'accumule (le dernier porte done:true)
//  - `model` donne le modèle (le dernier gagné — l'app fait des fallbacks)
//  - `error` / `info` / `usage` sont remontés
function summarizeSse(events) {
  let reply = '';
  let model = null;
  let errorMsg = null;
  let infoMsg = null;
  let usage = null;
  for (const ev of events) {
    switch (ev.type) {
      case 'content':
        reply = ev.text;
        break;
      case 'model':
        model = ev.model || model;
        break;
      case 'error':
        errorMsg = ev.error;
        break;
      case 'info':
        infoMsg = ev.message;
        break;
      case 'usage':
        usage = ev.balance !== undefined ? { balance: ev.balance } : usage;
        break;
      case 'done':
        model = ev.model || model;
        break;
    }
  }
  return { reply, model, errorMsg, infoMsg, usage };
}

module.exports = { log, debug, info, warn, error, ApiError, browserHeaders, downloadUrl, parseSse, summarizeSse };
