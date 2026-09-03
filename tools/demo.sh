#!/usr/bin/env bash
# Démo rapide de l'API (serveur lancé au préalable : node server.js)
set -uo pipefail
BASE="${1:-http://127.0.0.1:8788}"

echo "== 1. Chat texte simple (uid=123) =="
curl -s "$BASE/api/chat?prompt=bonjour%20comment%20%C3%A7a%20va%3F&uid=123"
echo; echo

echo "== 2. Mémoire conversationnelle : 2e tour avec le même uid =="
curl -s "$BASE/api/chat?prompt=tu%20te%20souviens%20de%20mon%20pr%C3%A9nom%20%3F&uid=123"
echo; echo

echo "== 3. Vision : décrire une image (image_url) =="
curl -s "$BASE/api/chat?prompt=d%C3%A9cris%20cette%20image%20en%20une%20phrase&image_url=https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/320px-Cat03.jpg&uid=456"
echo; echo

echo "== 4. Effacer la mémoire d'un uid =="
curl -s "$BASE/api/chat?prompt=reset&uid=123&reset=1" -X POST -d '{}'
echo; echo

echo "== 5. État des sessions =="
curl -s "$BASE/api/status"
echo
