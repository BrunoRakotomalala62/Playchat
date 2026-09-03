# Playchat — API REST autour de plai.chat

Wrapper API REST autour du chat gratuit de **https://plai.chat** (300+ modèles IA,
tier « FREE », sans compte). Le serveur reproduit exactement les requêtes de
l'application web — aucun compte, aucune clé API. Déployable en self-host
(Node ≥ 22, zéro dépendance). Self-host ou déploiement **Vercel** en mode serveur Node.js (voir plus bas).

```
GET  /api/chat?prompt=bonjour comment ça va?&uid=123
GET  /api/chat?prompt=décrivez cette photo&image_url=https://…&uid=123
POST /api/chat            (JSON : {prompt, uid?, image_url?, model?, think?, reset?})
GET  /api/chat?prompt=…&stream=1      → SSE brut (flux amont recopié en direct)
GET  /api/models          → presets/alias du site
GET  /api/status          → sessions anonymes
GET  /healthz
```

Réponse type :

```json
{
  "ok": true,
  "reply": "Bonjour ! Ça va très bien, merci 😊 …",
  "model": "minimax/minimax-m3:free",
  "uid": "123"
}
```

- `uid` **présent** → mémoire conversationnelle (le fil est rejoué à chaque tour,
  comme le fait l'app). `&reset=1` vide la mémoire.
- `uid` **absent** → tour unique (stateless).
- `image_url` → l'image est téléchargée par le serveur et jointe au message (la
  vision fonctionne sur le tier free).
- `model` → `free` (défaut, $0) · `balanced` · `premium` · `image` · alias/ID
  OpenRouter. Pour un anonyme, seul `free` est utilisable (`402` sinon).
- `stream=1` → proxy SSE : les événements amont arrivent tels quels.
- Erreurs : toujours `{ok:false, error:{code, message}}` (`400`, `402`, `429`,
  `502`, `503`).

## Démarrage rapide (self-host)

```bash
node server.js            # → http://127.0.0.1:8788
```

Session anonyme — 3 modes :

| Mode | Config | Quand |
|---|---|---|
| Cookie fourni | `PLAI_COOKIE=web_anon_session=…` | exporté d'un navigateur (DevTools → Application → Cookies) |
| Auto-mint | `PLAI_AUTO_MINT=true` + `camoufox-cli` installé (défaut) | serveur autonome : renouvelle ses cookies tout seul via le Turnstile |
| Aucun | les deux coupés | `503 no_session` |

Copier `.env.example` → `.env` pour ajuster (port, pool de sessions, pacing…).

## Déploiement Vercel (mode serveur Node.js)

Vercel traite le dépôt comme **une fonction Node.js unique** : la plateforme
**importe** `server.js` (compilé en `server.cjs`) et **toutes** les routes
arrivent au même handler. `server.js` exporte donc le handler HTTP en **export
par défaut** (fonction `(req, res)`) — exigence Vercel, sans quoi :
`Invalid export found in module server.cjs. The default export must be a
function or server.` (500 sur toutes les routes). En `node server.js`
(self-host), le même fichier écoute sur `process.env.PORT`/`8788`.

```bash
# brancher le repo sur Vercel (framework : Node.js, pas de build commande) puis :
vercel --prod
```

Variables d'environnement (dashboard Vercel) :

- `PLAI_COOKIE=web_anon_session=…` — recommandé : le cookie exporté d'un
  navigateur. Relu à chaque requête si le pool est vide ; « empoisonné » en
  mémoire d'instance s'il est rejeté (403), pour ne pas boucler.
- `PLAI_AUTO_MINT` — forcé à `false` par défaut sous Vercel (`VERCEL=1`) : pas de
  navigateur headless en serverless. Ne pas l'activer.

Limites du mode Vercel (serverless = instances éphémères) :

- **Pas de fichier d'état persistant** : mémoire uid et cookies vivent en
  mémoire d'instance (fiables en mono-instance, remis à zéro au cold start).
- Le **plafond anonyme horaire de plai.chat (~40 messages/IP/heure, `429`)**
  s'applique à l'IP de sortie de Vercel — partagée entre tous les utilisateurs
  du projet. Pour un usage soutenu, préférez le self-host sur votre IP.
- Cookies et IP : si plai.chat lie la session à l'IP d'origine, un cookie minté
  chez vous peut être rejeté depuis l'IP de Vercel → ré-exportez un cookie depuis
  un environnement sortant par la même IP que l'exécution.

> ⚠️ Symptôme d'un mauvais port : `This Serverless Function has crashed` /
> `FUNCTION_INVOCATION_FAILED` sur TOUTES les routes (même `/README.md`) =
> le serveur n'écoutait pas sur `process.env.PORT`. Corrigé dans `server.js`.

## Limites réelles de plai.chat (vérifiées le 2026-09-03)

1. **Plafond anonyme HORAIRE** : `429 {"error":"You've hit the anonymous usage
   limit for this hour. Sign in to keep going."}` — atteint après ~40 messages
   en une heure depuis la même IP (tous cookies confondus). Se réinitialise à
   l'heure suivante.
2. **Budget par session** : un cookie `web_anon_session` (~2 h) tient quelques
   dizaines de messages puis exige une re-vérification
   (`403 anon_verification_required`, parfois un flux silencieux : détection de
   stall incluse). Le wrapper invalide et passe au cookie suivant (mint auto en
   self-host).
3. **Pas de rate-limit fin** en dessous de ces plafonds : 17 requêtes directes OK
   dont 12 en rafale (~2-9 s), aucune erreur intermédiaire.
4. **Cloudflare protège le site** : clients non-navigateur type Python-urllib
   bannis (`403/1010`) ; rafales extrêmes risquent un blocage IP. Le wrapper
   garde un pacing par cookie (`PLAI_MIN_INTERVAL_MS`, défaut 700 ms).
5. Modèles payants (`balanced`/`premium`) : `402` pour un anonyme, non
   contournable.

En pratique : **illimité à rythme humain** en self-host (rotation + auto-mint),
avec un plafond dur d'environ 40 messages/heure/IP à ne pas dépasser pour un
usage soutenu — au-delà, il faut plusieurs IP (le pool de cookies ne repousse
que le plafond par session, pas le plafond horaire).

## Sous le capot (reverse-engineering)

plai.chat est une SPA qui parle à son backend Express (même origine, derrière
Cloudflare) :

| Appel | Rôle |
|---|---|
| `POST /api/web/chat/send` | le chat. Corps `{message, history, model, attachments, conversationStartedAt, zdr, think}` → **SSE** `data: {…}`. `history` = tours précédents seulement. |
| `POST /api/web/auth/anonymous-verify` | échange un jeton **Cloudflare Turnstile** (sitekey `0x4AAAAAAC-lISmo_bU02UL9`) contre le cookie HttpOnly `web_anon_session` (~2 h). |
| `GET /api/web/models/aliases` | presets/alias publics. `free` → `nvidia/nemotron-…:free`, `minimax/minimax-m3:free` (multimodal). |
| `GET /api/web/auth/session` | `{authenticated:false}` pour un anonyme. |

Détails : le preset `free` fait du fallback serveur (un 2ᵉ événement `model`
apparaît si le 1ᵉʳ modèle est lent) ; la réponse s'obtient en accumulant les
événements `content` (le dernier porte `done:true`) ; les images partent en
base64 inline dans `attachments:[{name,type,dataUrl}]` ; l'historique est
rejoué à chaque tour (le serveur n'a pas de mémoire).

## Fichiers

```
server.js            API HTTP (self-host et Vercel — écoute sur process.env.PORT si fourni)
lib/config.js        configuration (env + .env)
lib/util.js          logs, erreurs typées, téléchargement image, parse SSE
lib/plai.js          client du backend plai.chat (+ stall detection, mapping 429/402/403)
lib/jar.js           pool de cookies, rotation, auto-mint, mémoire uid
lib/mint.js          mint d'un cookie via camoufox-cli (résout le Turnstile)
tools/demo.sh        démo curl
```

Fait le 2026-09-03. Si le site change ses endpoints, relire `lib/plai.js`.
