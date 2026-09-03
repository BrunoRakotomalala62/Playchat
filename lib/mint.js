'use strict';
// Mint d'un cookie de session anonyme « web_anon_session » pour plai.chat.
//
// Pourquoi : /api/web/chat/send exige un cookie HttpOnly posé par
// /api/web/auth/anonymous-verify après résolution d'un challenge Cloudflare
// Turnstile (sitekey 0x4AAAAAAC-lISmo_bU02UL9). Un token Turnstile ne peut pas
// être fabriqué hors navigateur ; on laisse donc un vrai navigateur anti-détection
// (camoufox-cli) faire le flux comme un humain : envoi d'un message → l'app reçoit
// le 403 anon_verification_required → Turnstile invisible se résout → le cookie
// est posé → la réponse arrive. On exporte ensuite les cookies et on récupère
// web_anon_session (HttpOnly, TTL observé ~2 h).
//
// NB : le Chrome du bac à sable échoue au Turnstile (erreur 600010) alors que
// camoufox passe — d'où camoufox. Sur une machine « propre », tout navigateur
// réel convient ; la même fonction peut être adaptée (Playwright, etc.).

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { log, ApiError } = require('./util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJsonish(text) {
  const s = String(text).trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i === -1 || j === -1) throw new Error('Sortie non JSON: ' + s.slice(0, 200));
  return JSON.parse(s.slice(i, j + 1));
}

function runCli(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cfg.mintCmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env } },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(err);
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

// Envoie « ping » depuis la page : déclenche 403 → vérification anonyme → cookie.
const SEND_JS = `(() => {
  const ta = document.querySelector('textarea.chat-input');
  if (!ta) return JSON.stringify({ ok: false, why: 'no-textarea' });
  ta.value = 'ping';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = document.querySelector('#send-btn') || [...document.querySelectorAll('button')].find(b => (b.className||'').includes('send-btn'));
  if (!btn) return JSON.stringify({ ok: false, why: 'no-sendbtn' });
  btn.click();
  return JSON.stringify({ ok: true });
})()`;

const STATE_JS = `(() => {
  const host = document.querySelector('#chat-view, .conversation, main') || document.body;
  const txt = (host.innerText || '').slice(-600);
  return JSON.stringify({ hasFail: /Couldn't verify|failed to load/i.test(txt), last: txt.split('\\n').filter(Boolean).slice(-6) });
})()`;

async function mintCookie() {
  const session = `plai-mint-${crypto.randomBytes(3).toString('hex')}`;
  const exportFile = path.join(os.tmpdir(), `plai-cookies-${session}.json`);
  const base = ['--session', session, '--no-geoip'];
  const withProxy = cfg.mintProxy ? ['--proxy', cfg.mintProxy] : [];
  let cookie = null;
  let lastState = '';
  try {
    log('info', '[mint] ouverture de plai.chat dans camoufox…');
    await runCli([...base, ...withProxy, 'open', cfg.http.base + '/']);
    await sleep(4000);

    log('info', '[mint] envoi du message déclencheur…');
    await runCli([...base, ...withProxy, 'eval', SEND_JS]);

    // Poll : réponse reçue (le cookie est posé juste avant) ou échec Turnstile.
    const deadline = Date.now() + 60000;
    let done = false;
    while (Date.now() < deadline && !done) {
      await sleep(4000);
      try {
        const r = await runCli([...base, ...withProxy, 'eval', STATE_JS], 30000);
        const st = parseJsonish(r.stdout);
        lastState = JSON.stringify(st).slice(0, 300);
        if (st.hasFail) break;                     // Turnstile a échoué : inutile d'attendre
        if (Array.isArray(st.last) && st.last.some((l) => l && !/^plai\.chat|^You|^Save|^New chat/.test(l) && l.length > 2)) {
          done = true;                             // une réponse IA est apparue → cookie posé
        }
      } catch { /* camoufox occupé : on re-poll */ }
    }
    if (!done) log('warn', '[mint] pas de réponse détectée, export des cookies quand même. État:', lastState);

    await runCli([...base, ...withProxy, 'cookies', 'export', exportFile], 30000);
    const data = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    const jar = Array.isArray(data) ? data : (data.cookies || []);
    const ck = jar.find((c) => c.name === 'web_anon_session');
    if (ck && ck.value) {
      const expiresAt = ck.expires && ck.expires > 0 ? ck.expires * 1000 : Date.now() + cfg.cookieTtlMs;
      cookie = { value: ck.value, expiresAt };
      log('info', '[mint] cookie web_anon_session obtenu, expire dans',
        Math.round((expiresAt - Date.now()) / 60000), 'min');
    } else {
      log('error', '[mint] cookie introuvable dans', JSON.stringify(jar.map((c) => c.name)));
    }
  } catch (err) {
    log('error', '[mint] échec:', err.message);
    throw new ApiError(503, 'mint_failed', `Impossible de renouveler le cookie anonyme : ${err.message}`);
  } finally {
    try { await runCli([...base, ...withProxy, 'close'], 15000); } catch { /* best-effort */ }
    try { fs.unlinkSync(exportFile); } catch { /* best-effort */ }
  }
  if (!cookie) throw new ApiError(503, 'mint_failed',
    'camoufox n’a pas obtenu le cookie (Turnstile ?). État: ' + lastState);
  return cookie;
}

module.exports = { mintCookie };
