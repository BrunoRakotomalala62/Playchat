'use strict';
// Client HTTP du backend de plai.chat (mêmes appels que l'application web).
//
// Reverse-engineering du 2026-09-03 :
//   POST /api/web/chat/send        -> SSE `data: {…}` (start, model, content,
//                                     error, info, usage, done)
//   POST /api/web/auth/anonymous-verify  {turnstileToken} -> pose le cookie
//                                     HttpOnly `web_anon_session` (~2 h)
//   GET  /api/web/models/aliases   -> presets/alias (public)
//   GET  /api/web/auth/session     -> {authenticated:false} pour un anonyme
//
// Corps de chat/send : {message, history, model, attachments,
//                       conversationStartedAt, zdr, think}
//   - history = tours PRÉCÉDENTS uniquement (le serveur ajoute `message`)
//   - attachments = [{name, type, dataUrl}] (images en base64 inline)
//   - model = preset ("free" par défaut) ou alias/ID OpenRouter
//
// Comportements observés (importants) :
//   - 403 {"error":"anon_verification_required"} quand le cookie est
//     absent/expiré/épuisé (budget d'une session anonyme ≈ quelques dizaines de
//     messages, puis re-vérification Turnstile exigée).
//   - Une session « bridée » peut aussi rester silencieuse (SSE qui ne reçoit
//     rien et ne se termine pas) : d'où la détection de stall ci-dessous.

const cfg = require('./config');
const { browserHeaders, parseSse, summarizeSse, ApiError, log } = require('./util');

async function upstream(path, { method = 'GET', body, cookie, accept } = {}) {
  const headers = browserHeaders({ 'Content-Type': 'application/json' });
  // Le jar stocke la valeur brute ; l'en-tête attend `web_anon_session=<valeur>`.
  if (cookie) headers.Cookie = cookie.includes('=') ? cookie : 'web_anon_session=' + cookie;
  if (accept) headers.Accept = accept;
  const res = await fetch(cfg.http.base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(cfg.upstreamResponseMs),
  });
  return res;
}

// Erreurs HTTP « propres » de /chat/send → ApiError typée.
function mapHttpError(status, raw) {
  if (status === 403) {
    try {
      const j = JSON.parse(raw);
      if (j.error === 'anon_verification_required') {
        throw new ApiError(403, 'anon_required', 'Session anonyme à revérifier (cookie épuisé/expiré).');
      }
    } catch (e) { if (e instanceof ApiError) throw e; }
    throw new ApiError(403, 'upstream_403', `plai.chat HTTP 403 : ${raw.slice(0, 200)}`);
  }
  if (status === 402) {
    let msg = raw;
    try { const j = JSON.parse(raw); msg = j.error || raw; } catch { /* brut */ }
    throw new ApiError(402, 'payment_required', `Ce modèle exige un compte crédité : ${msg.slice(0, 300)}`);
  }
  if (status === 429) {
    // Limite anonyme HORAIRE constatée : « You've hit the anonymous usage limit
    // for this hour. Sign in to keep going. » (plafond par IP/heure, tous
    // cookies confondus ; se réinitialise à l'heure suivante).
    let msg = raw;
    try { const j = JSON.parse(raw); if (j.error) msg = j.error; } catch { /* brut */ }
    throw new ApiError(429, 'rate_limited', `plai.chat : ${msg.slice(0, 300)}`);
  }
  throw new ApiError(502, 'upstream_error', `plai.chat a répondu HTTP ${status} : ${raw.slice(0, 300)}`);
}

// Consomme le corps d'une réponse avec détection de stall.
// Important : un timer ne peut pas interrompre un reader.read() en attente — le
// watchdog annule donc le reader (le read en cours rejette -> ApiError).
//   - idleMs sans AUCUN octet reçu -> ApiError upstream_stall (session bridée)
//   - timeoutMs au total            -> ApiError upstream_timeout
async function readBodyWithStall(res, { idleMs = cfg.chatIdleMs, timeoutMs = cfg.chatTimeoutMs, onData = null } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let lastActivity = Date.now();
  const started = Date.now();
  let watchdog = null;
  try {
    const readLoop = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastActivity = Date.now();
        const chunk = decoder.decode(value, { stream: true });
        text += chunk;
        if (onData) onData(chunk);
      }
    })();
    watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastActivity > idleMs) {
        reader.cancel('idle-timeout').catch(() => {});
      } else if (now - started > timeoutMs) {
        reader.cancel('total-timeout').catch(() => {});
      }
    }, 3000);
    await readLoop;
    return text;
  } catch (err) {
    const now = Date.now();
    if (now - lastActivity > idleMs) throw new ApiError(504, 'upstream_stall', 'plai.chat reste silencieux (session bridée ?).');
    if (now - started > timeoutMs) throw new ApiError(504, 'upstream_timeout', 'plai.chat ne répond plus (timeout global).');
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'upstream_error', 'Lecture du flux plai.chat interrompue : ' + err.message);
  } finally {
    if (watchdog) clearInterval(watchdog);
  }
}

function buildBody({ message, history, model, attachments, think, zdr }) {
  return {
    message: message || '',
    history: Array.isArray(history) ? history : [],
    model: model || 'free',
    attachments: attachments || [],
    conversationStartedAt: new Date().toISOString(),
    zdr: !!zdr,
    think: !!think,
  };
}

// Envoie un message et renvoie {reply, model, events, infoMsg}.
async function chatSend({ cookie, message, history = [], model = 'free', attachments = [], think = false, zdr = false }) {
  const res = await upstream('/api/web/chat/send', {
    method: 'POST', cookie, accept: 'text/event-stream',
    body: buildBody({ message, history, model, attachments, think, zdr }),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    mapHttpError(res.status, raw);
  }
  const raw = await readBodyWithStall(res);
  const events = parseSse(raw);
  const { reply, model: finalModel, errorMsg, infoMsg } = summarizeSse(events);
  if (errorMsg) throw new ApiError(502, 'model_error', `Erreur du modèle : ${errorMsg}`);
  return { reply, model: finalModel || model, events, infoMsg };
}

// Version « proxy SSE » : consomme le flux amont et appelle onEvent/onData au
// fil de l'eau. Renvoie {model, events} une fois terminé. Idéal pour stream=1.
async function chatSendStreaming({ cookie, message, history = [], model = 'free', attachments = [], think = false, zdr = false, onData = null, onEvent = null }) {
  const res = await upstream('/api/web/chat/send', {
    method: 'POST', cookie, accept: 'text/event-stream',
    body: buildBody({ message, history, model, attachments, think, zdr }),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    mapHttpError(res.status, raw);
  }
  let buf = '';
  await readBodyWithStall(res, {
    onData: (chunk) => {
      if (onData) onData(chunk);
      buf += chunk;
      // Événements complets au fil de l'eau (le flux fait « data: …\n\n »).
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) {
            try { if (onEvent) onEvent(JSON.parse(line.slice(6))); } catch { /* malformé */ }
          }
        }
      }
    },
  });
  return { model: null };
}

async function fetchAliases(cookie) {
  const res = await upstream('/api/web/models/aliases', { cookie });
  if (!res.ok) throw new ApiError(502, 'upstream_error', `aliases: HTTP ${res.status}`);
  return res.json();
}

async function fetchSession(cookie) {
  const res = await upstream('/api/web/auth/session', { cookie });
  if (!res.ok) return { authenticated: false };
  return res.json();
}

module.exports = { chatSend, chatSendStreaming, fetchAliases, fetchSession, upstream, buildBody };
