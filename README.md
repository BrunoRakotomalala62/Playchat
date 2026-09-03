# Playchat — API REST autour de plai.chat

Wrapper API REST autour du chat gratuit de **https://plai.chat** (300+ modèles IA,
tier « FREE », sans compte). Le serveur reproduit exactement les requêtes de
l'application web — aucun compte, aucune clé API. Déployable en self-host
(Node ≥ 22, zéro dépendance) ou sur **Vercel** (serverless, `vercel.json` inclus).

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

## Déploiement Vercel

`vercel.json` route `/api/chat`, `/api/models`, `/api/status` et `/healthz` vers
la fonction `api/index.js` (même handler HTTP que `server.js`, sans `listen`).
`maxDuration: 60` pour laisser le temps aux générations longues.

```bash
vercel --prod     # après avoir branché le repo sur Vercel
```

Variable d'environnement à définir dans le dashboard Vercel :

- `PLAI_COOKIE=web_anon_session=…` — **obligatoire** (voir ci-dessous).

Limites propres au serverless (documentées dans `api/index.js`) :

- **Pas de mint camoufox** : `PLAI_AUTO_MINT` est forcé à `false` sauf si vous le
  définissez explicitement (et de toute façon un navigateur headless ne tourne
  pas sur Vercel). Le cookie d'env est relu à chaque requête, et « empoisonné »
  en mémoire d'instance s'il est rejeté (403) pour éviter les boucles.
- **Pas de stockage persistant** : mémoire uid et pool de cookies vivent en
  mémoire d'instance (fiables en mono-instance, remis à zéro au cold start).
- **Limite anonyme horaire de plai.chat** (`429`) : voir plus bas — elle
  s'applique à l'IP de sortie de Vercel, comme à n'importe quelle IP.

> ⚠️ Cookies et IP : la limite anonyme est liée à l'IP d'où l'on parle à
> plai.chat. Si vous déployez sur Vercel, exportez le cookie depuis un
> navigateur qui sort par la même IP que votre instance (ou acceptez des
> `429`/`403` jusqu'à re-export). En self-host sur votre machine/box, le cookie
> minté localement est le bon.

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
server.js            API HTTP complète (self-host) — exporte aussi `handler`
api/index.js         adaptateur Vercel (même handler, serverless)
vercel.json          routes + maxDuration pour Vercel
lib/config.js        configuration (env + .env)
lib/util.js          logs, erreurs typées, téléchargement image, parse SSE
lib/plai.js          client du backend plai.chat (+ stall detection, mapping 429/402/403)
lib/jar.js           pool de cookies, rotation, auto-mint, mémoire uid
lib/mint.js          mint d'un cookie via camoufox-cli (résout le Turnstile)
tools/demo.sh        démo curl
```

Fait le 2026-09-03. Si le site change ses endpoints, relire `lib/plai.js`.
