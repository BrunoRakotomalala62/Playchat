'use strict';
// Configuration centralisée (variables d'environnement + .env simple, sans dépendance).
const fs = require('fs');
const path = require('path');

(function loadDotEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true' || String(v) === '1');
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

module.exports = {
  host: process.env.HOST || '127.0.0.1',
  port: int(process.env.PORT, 8788),

  // Identité HTTP « fidèle à un navigateur » : Cloudflare bannit (403/1010) les
  // clients HTTP non-navigateur type Python-urllib / UA "node".
  http: {
    base: process.env.PLAI_BASE || 'https://plai.chat',
    origin: process.env.PLAI_ORIGIN || 'https://plai.chat',
    ua: process.env.PLAI_UA ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.124 Safari/537.36',
  },

  // Session anonyme : soit un cookie fourni (PLAI_COOKIE ou fichier d'état),
  // soit un mint automatique via camoufox-cli (résout le Turnstile).
  cookieEnv: process.env.PLAI_COOKIE || '',                 // ex. "web_anon_session=abc…"
  autoMint: bool(process.env.PLAI_AUTO_MINT, true),         // utilise camoufox-cli si dispo
  mintCmd: process.env.PLAI_MINT_CMD || 'camoufox-cli',
  mintProxy: process.env.PLAI_MINT_PROXY || '',             // optionnel : proxy pour camoufox
  cookieTtlMs: int(process.env.PLAI_COOKIE_TTL_MS, 2 * 60 * 60 * 1000), // TTL observé ~2 h
  preemptiveRefreshMs: int(process.env.PLAI_PREEMPTIVE_REFRESH_MS, 10 * 60 * 1000),
  stateFile: process.env.PLAI_STATE_FILE || path.join(__dirname, '..', '.plai-state.json'),

  // Comportement du serveur
  concurrency: int(process.env.PLAI_CONCURRENCY, 2),        // requêtes upstream simultanées
  minIntervalMs: int(process.env.PLAI_MIN_INTERVAL_MS, 700),// pacing entre 2 requêtes/cookie
  maxHistory: int(process.env.PLAI_MAX_HISTORY, 20),        // msgs conservés par uid
  maxUids: int(process.env.PLAI_MAX_UIDS, 200),
  maxCookies: int(process.env.PLAI_MAX_COOKIES, 3),         // sessions anonymes en pool
  chatTimeoutMs: int(process.env.PLAI_CHAT_TIMEOUT_MS, 240000),
  chatIdleMs: int(process.env.PLAI_CHAT_IDLE_MS, 45000),    // silence amont = session bridée
  upstreamResponseMs: int(process.env.PLAI_RESPONSE_MS, 45000), // attente max des en-têtes
  imageMaxBytes: int(process.env.PLAI_IMAGE_MAX_BYTES, 10 * 1024 * 1024),
  aliasesCacheMs: int(process.env.PLAI_ALIASES_CACHE_MS, 10 * 60 * 1000),
  logLevel: (process.env.PLAI_LOG_LEVEL || 'info').toLowerCase(),

  // Liste publique des presets/alias (observée sur /api/web/models/aliases le 2026-09-03).
  // "free" est le seul preset réellement $0/gratuit et illimité pour un anonyme ;
  // balanced/premium exigent un compte crédité (402 balance=$0 pour un anonyme).
  presets: {
    free: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,minimax/minimax-m3:free',
    image: 'google/gemini-3.1-flash-lite-image,google/gemini-2.5-flash-image,google/gemini-3.1-flash-image',
  },
};
