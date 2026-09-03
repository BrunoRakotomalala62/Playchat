'use strict';
// API REST — wrapper du chat gratuit de https://plai.chat
//
//   GET  /api/chat?prompt=bonjour comment ça va?&uid=123
//   GET  /api/chat?prompt=décrivez cette photo&image_url=https://…&uid=123
//   POST /api/chat            (JSON : {prompt, uid?, image_url?, model?, think?, reset?})
//   GET  /api/chat?prompt=…&stream=1   -> SSE brut (recopie du flux amont)
//   GET  /api/models          -> presets/alias côté plai.chat
//   GET  /api/status          -> cookies + auto-mint
//   GET  /healthz
//
// Zéro dépendance : Node >= 22 (fetch natif). Session anonyme auto-renouvelée
// via camoufox-cli (résout le Turnstile) — voir README.md pour les limites réelles.

const http = require('http');
const cfg = require('./lib/config');
const { log, ApiError, downloadUrl } = require('./lib/util');
const { runChat, resetHistory, sessionInfo, withCookie, getHistory } = require('./lib/jar');
const { fetchAliases, chatSendStreaming } = require('./lib/plai');

const startedAt = Date.now();
log('info', `[init] module chargé (mode ${process.env.VERCEL ? 'Vercel import' : 'serveur'}, node ${process.version}, pid ${process.pid})`);

// ---------- Files d'attente ----------
// Concurrence amont limitée ; les tours d'un même uid sont sérialisés (la
// mémoire conversationnelle est rejouée à chaque appel, l'ordre doit tenir).
class Dispatcher {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.uidChains = new Map();
  }

  schedule(uid, task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ uid, task, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const { uid, task, resolve, reject } = this.queue.shift();
      const exec = () => {
        this.running++;
        const p = Promise.resolve().then(task).finally(() => { this.running--; this._pump(); });
        p.then(resolve, reject); // câble le résultat de la tâche à la promesse de schedule()
        return p;
      };
      if (uid) {
        const prev = this.uidChains.get(uid) || Promise.resolve();
        const chain = prev.then(exec); // attend la fin du tour précédent (même si erreur)
        const tracked = chain.catch(() => {});
        this.uidChains.set(uid, tracked);
        tracked.then(() => { if (this.uidChains.get(uid) === tracked) this.uidChains.delete(uid); });
      } else {
        exec();
      }
    }
  }
}
const dispatcher = new Dispatcher(cfg.concurrency);

// ---------- Helpers HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) { req.destroy(); reject(new ApiError(413, 'too_large', 'Corps trop gros.')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseQuery(url) {
  const q = {};
  const i = url.indexOf('?');
  if (i !== -1) {
    for (const part of url.slice(i + 1).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const k = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
      const v = eq === -1 ? '' : decodeURIComponent(part.slice(eq + 1));
      q[k] = v;
    }
  }
  return q;
}

function boolParam(v) {
  return v === '1' || v === 'true';
}

// Normalise + valide les paramètres communs (query ou corps JSON).
function normalizeParams(p) {
  const prompt = String(p.prompt ?? '').trim();
  const imageUrl = String(p.image_url ?? '');
  const uid = p.uid != null && p.uid !== '' ? String(p.uid) : null;
  const model = String(p.model ?? 'free').trim() || 'free';
  const think = boolParam(p.think);
  const reset = boolParam(p.reset);
  const stream = boolParam(p.stream);

  if (!prompt && !imageUrl) throw new ApiError(400, 'missing_prompt', 'Paramètre "prompt" (ou "image_url") requis.');
  if (imageUrl && !/^https?:\/\//.test(imageUrl)) throw new ApiError(400, 'invalid_image_url', 'image_url doit être une URL http(s).');
  if (!/^[A-Za-z0-9_.:\/@-]{1,120}$/.test(model)) throw new ApiError(400, 'invalid_model', 'Modèle invalide.');
  return { prompt, imageUrl, uid, model, think, reset, stream };
}

async function fetchImage(imageUrl) {
  const { buf, ctype } = await downloadUrl(imageUrl);
  const ext = (ctype.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return { name: `image.${ext}`, type: ctype, dataUrl: `data:${ctype};base64,${buf.toString('base64')}` };
}

// ---------- Serveur ----------
// Handler HTTP partagé : utilisé par le serveur autonome (server.js) et par
// l'adaptateur Vercel (api/index.js). Ne jamais écouter deux fois.
async function handler(req, res) {
  const start = Date.now();
  const pathname = req.url.split('?')[0];
  try {
    if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, uptime: Math.round((Date.now() - startedAt) / 1000) });
      return;
    }

    if (pathname === '/api/chat') {
      if (req.method !== 'GET' && req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'GET ou POST uniquement.');
      const p = parseQuery(req.url);
      if (req.method === 'POST') {
        const body = await readBody(req);
        try { Object.assign(p, JSON.parse(body || '{}')); } catch { throw new ApiError(400, 'bad_json', 'Corps JSON invalide.'); }
      }
      const params = normalizeParams(p);
      if (params.reset && params.uid) resetHistory(params.uid);

      // Mode stream : proxy SSE temps réel (événements amont recopiés tels quels,
      // détection de stall incluse).
      if (params.stream) {
        const att = params.imageUrl ? await fetchImage(params.imageUrl) : null;
        const history = params.uid ? getHistory(params.uid) : [];
        const attachments = att ? [att] : [];
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        const events = [];
        await withCookie((cookie) => chatSendStreaming({
          cookie, message: params.prompt, history, model: params.model, attachments,
          think: params.think,
          onData: (chunk) => { try { res.write(chunk); } catch { /* client parti */ } },
          onEvent: (ev) => events.push(ev),
        })).catch(async (err) => {
          // Erreur après le début du flux : on signale en SSE puis on ferme.
          log('warn', '[api] stream interrompu:', err.code || err.message);
          try { res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`); } catch { /* noop */ }
          res.end();
        });
        res.end();
        log('info', `[api] chat stream uid=${params.uid ?? '-'} model=${params.model} (${Date.now() - start}ms)`);
        return;
      }

      const att = params.imageUrl ? await fetchImage(params.imageUrl) : null;
      const result = await dispatcher.schedule(params.uid, () =>
        runChat({
          uid: params.uid, prompt: params.prompt,
          imageDataUrl: att ? att.dataUrl : null,
          imageName: att ? att.name : null,
          imageType: att ? att.type : null,
          model: params.model, think: params.think,
        }));
      sendJson(res, 200, { ok: true, reply: result.reply, model: result.model, uid: params.uid ?? null });
      log('info', `[api] chat uid=${params.uid ?? '-'} model=${result.model}${att ? ' [image]' : ''} (${Date.now() - start}ms)`);
      return;
    }

    if (pathname === '/api/models') {
      const data = await fetchAliases();
      sendJson(res, 200, { ok: true, aliases: data.aliases });
      return;
    }

    if (pathname === '/api/status') {
      const info = await sessionInfo();
      sendJson(res, 200, { ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), ...info });
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Route inconnue. Voir GET /api/chat?prompt=…&uid=…' } });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status >= 500) log('error', '[api]', err.code, err.message);
      sendJson(res, err.status, err.toJSON());
    } else {
      log('error', '[api] erreur inattendue:', err);
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(err.message || err) } });
    }
  }
}

const server = http.createServer(handler);

// Export pour Vercel (preset Node.js) : la plateforme IMPORTE server.js
// (compilé en server.cjs) et exige un export par défaut qui soit une FONCTION
// (req, res) ou un serveur HTTP — sinon :
//   « Invalid export found in module server.cjs. The default export must be a
//     function or server. » -> 500 sur toutes les routes.
module.exports = handler;
module.exports.handler = handler; // compat : require('./server').handler
module.exports.server = server;   // compat : require('./server').server

// Démarrage self-host : `node server.js` écoute sur HOST/PORT (défaut
// 127.0.0.1:8788) ; sous Vercel (process.env.PORT fourni) on écoute sur le port
// de la plateforme, host 0.0.0.0.
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : cfg.port;
  const host = process.env.PORT ? '0.0.0.0' : cfg.host;
  server.listen(port, host, () => {
    log('info', `plai-api démarré sur http://${host}:${port}`);
    log('info', `  curl "http://127.0.0.1:${port}/api/chat?prompt=bonjour&uid=123"`);
    log('info', `  curl "http://127.0.0.1:${port}/api/chat?prompt=décris cette photo&image_url=https://exemple.com/photo.png&uid=123"`);
  });
}

