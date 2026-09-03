'use strict';
// Adaptateur Vercel (serverless) pour le wrapper plai.chat.
//
// Vercel ne fait pas tourner de serveur HTTP persistant : ce fichier expose le
// MÊME handler HTTP que server.js (routes /api/chat, /api/models, /api/status,
// /healthz) sous forme de fonction serverless. vercel.json route les chemins
// vers cette fonction.
//
// Différences avec le mode autonome (server.js) :
//  - pas de mint camoufox : PLAI_AUTO_MINT est forcé à false sauf si vous
//    définissez explicitement la variable. Fournissez PLAI_COOKIE (session
//    anonyme exportée d'un navigateur) — elle est re-lue à chaque requête et
//    « empoisonnée » localement si le serveur la rejette (403).
//  - pas de fichier d'état persistant : la mémoire par uid et le pool de
//    cookies vivent en mémoire d'instance (fiable en usage mono-instance,
//    réinitialisés au cold start).
//  - le flux SSE (stream=1) et les générations longues sont limités par le
//    maxDuration de la fonction (voir vercel.json).

// Config lue au require : forcer l'auto-mint OFF par défaut en serverless.
if (process.env.PLAI_AUTO_MINT === undefined) process.env.PLAI_AUTO_MINT = 'false';

const { handler } = require('../server');

module.exports = async function vercelPlaychat(req, res) {
  await handler(req, res);
};
