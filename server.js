// servidor-agendamento/server.js
// Servidor de agendamento de posts Instagram — O Globo
// Deploy no Railway: conecta o repo e pronto

const http = require('http');
const url = require('url');
const https = require('https');
const cron = require('node-cron');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'trocar-por-chave-secreta';

// ─── Banco de dados SQLite ───────────────────────────────────────────────────
// No Railway, DB_PATH deve apontar para o Volume (ex: /data/posts.db);
// sem Volume o banco fica no filesystem efêmero e é apagado a cada deploy.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'posts.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    caption     TEXT,
    image_url   TEXT NOT NULL,
    ig_user_id  TEXT NOT NULL,
    ig_token    TEXT NOT NULL,
    fb_page_id  TEXT,
    fb_page_token TEXT,
    scheduled_at TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    error       TEXT,
    published_at TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

// Migration: adiciona fb_page_id em bancos antigos
try { db.exec('ALTER TABLE posts ADD COLUMN fb_page_id TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE posts ADD COLUMN fb_page_token TEXT'); } catch(e) {}

// ─── Helpers ────────────────────────────────────────────────────────────────
function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Secret',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  return req.headers['x-api-secret'] === API_SECRET;
}

// Remove tokens de mensagens de erro antes de gravar no banco/log.
// Ex: erros de rede do node-fetch incluem a URL completa, com ?access_token=...
function sanitizeError(message, ...tokens) {
  let s = String(message ?? '');
  for (const t of tokens) if (t) s = s.split(t).join('[REDACTED]');
  return s
    .replace(/access_token=[^&\s"']+/gi, 'access_token=[REDACTED]')
    .replace(/\bEAA[A-Za-z0-9]{20,}/g, '[REDACTED]');
}

// Cria um Error a partir da resposta da Graph API preservando code, subcode e fbtrace_id.
function graphError(data, fallbackMessage) {
  const e = (data && data.error) || {};
  const err = new Error(e.message || fallbackMessage);
  err.code = e.code;
  err.subcode = e.error_subcode;
  err.fbtraceId = e.fbtrace_id;
  return err;
}

// Mensagem para a coluna error: "mensagem [code=… subcode=… fbtrace_id=…]", sem tokens.
function formatError(err, ...tokens) {
  const details = [
    err.code != null && `code=${err.code}`,
    err.subcode != null && `subcode=${err.subcode}`,
    err.fbtraceId && `fbtrace_id=${err.fbtraceId}`,
  ].filter(Boolean).join(' ');
  return sanitizeError(details ? `${err.message} [${details}]` : err.message, ...tokens);
}

// ─── Publicar no Instagram ───────────────────────────────────────────────────
async function publishToInstagram(post) {
  console.log(`[publish] iniciando post ${post.id} — ${post.title.substring(0, 40)}`);

  // 1. Cria container de mídia no Instagram
  const containerUrl = `https://graph.facebook.com/v19.0/${post.ig_user_id}/media` +
    `?image_url=${encodeURIComponent(post.image_url)}` +
    `&caption=${encodeURIComponent(post.caption || '')}` +
    `&access_token=${post.ig_token}`;

  // Retry APENAS na criação do container: um container não publicado expira sozinho
  // em 24h e é inofensivo. NUNCA repetir o /media_publish — criaria posts duplicados.
  // A Graph API falha de forma intermitente ao baixar a imagem (9004/2207052).
  const MAX_CONTAINER_ATTEMPTS = 3;
  const CONTAINER_RETRY_DELAY_MS = 5000;
  let containerData;
  for (let attempt = 1; ; attempt++) {
    const containerRes = await fetch(containerUrl, { method: 'POST' });
    containerData = await containerRes.json();
    if (containerRes.ok && containerData.id) break;

    const err = graphError(containerData, 'Erro ao criar container');
    const isMediaDownloadFailure = err.code === 9004 && err.subcode === 2207052;
    if (!isMediaDownloadFailure || attempt >= MAX_CONTAINER_ATTEMPTS) {
      if (attempt > 1) err.message += ` (falhou após ${attempt} tentativas)`;
      throw err;
    }
    console.warn(`[publish] container falhou (tentativa ${attempt}/${MAX_CONTAINER_ATTEMPTS}): ` +
      `${sanitizeError(err.message, post.ig_token)} [fbtrace_id=${err.fbtraceId}] — nova tentativa em ${CONTAINER_RETRY_DELAY_MS / 1000}s`);
    await new Promise(r => setTimeout(r, CONTAINER_RETRY_DELAY_MS));
  }

  console.log(`[publish] container criado: ${containerData.id}`);

  // 2. Aguarda processamento
  await new Promise(r => setTimeout(r, 4000));

  // 3. Publica no Instagram
  const publishUrl = `https://graph.facebook.com/v19.0/${post.ig_user_id}/media_publish` +
    `?creation_id=${containerData.id}` +
    `&access_token=${post.ig_token}`;

  const publishRes = await fetch(publishUrl, { method: 'POST' });
  const publishData = await publishRes.json();

  if (!publishRes.ok) {
    throw graphError(publishData, 'Erro ao publicar');
  }

  console.log(`[publish] IG publicado! post_id=${publishData.id}`);

  // 4. Publica no Facebook se page_id configurado
  if (post.fb_page_id) {
    try {
      // Tenta /photos primeiro
      const fbToken = post.fb_page_token || post.ig_token;
      const fbPhotoUrl = `https://graph.facebook.com/v19.0/${post.fb_page_id}/photos` +
        `?url=${encodeURIComponent(post.image_url)}` +
        `&caption=${encodeURIComponent(post.caption || '')}` +
        `&access_token=${fbToken}`;
      const fbPhotoRes = await fetch(fbPhotoUrl, { method: 'POST' });
      const fbPhotoData = await fbPhotoRes.json();
      if (fbPhotoRes.ok) {
        console.log(`[publish] FB publicado! post_id=${fbPhotoData.post_id || fbPhotoData.id}`);
      } else {
        console.warn(`[publish] FB erro: ${fbPhotoData.error?.message}`);
      }
    } catch(e) {
      console.warn(`[publish] FB erro: ${sanitizeError(e.message, post.fb_page_token, post.ig_token)}`);
    }
  }

  return publishData.id;
}

// ─── Cron: verifica a cada minuto ───────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = new Date().toISOString().slice(0, 16); // "2026-05-29T14:30"

  const pending = db.prepare(`
    SELECT * FROM posts
    WHERE status = 'pending'
    AND substr(scheduled_at, 1, 16) <= ?
    ORDER BY scheduled_at ASC
    LIMIT 5
  `).all(now);

  if (pending.length === 0) return;
  console.log(`[cron] ${pending.length} post(s) para publicar agora`);

  for (const post of pending) {
    // Marca como 'publishing' só se ainda estiver 'pending'. O node-cron não espera a
    // rodada anterior terminar; se outra rodada já pegou o post, pula (evita publish duplo).
    const claimed = db.prepare(`UPDATE posts SET status='publishing' WHERE id=? AND status='pending'`).run(post.id);
    if (claimed.changes === 0) continue;
    try {
      const postId = await publishToInstagram(post);
      db.prepare(`
        UPDATE posts SET status='published', published_at=datetime('now'), error=NULL
        WHERE id=?
      `).run(post.id);
      console.log(`[cron] ✓ ${post.id} publicado (ig_id=${postId})`);
    } catch(err) {
      const safeMessage = formatError(err, post.ig_token, post.fb_page_token);
      db.prepare(`
        UPDATE posts SET status='failed', error=? WHERE id=?
      `).run(safeMessage, post.id);
      console.error(`[cron] ✗ ${post.id} falhou: ${safeMessage}`);
    }
  }
});

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const method = req.method;
  const pathname = parsed.pathname;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Secret',
    });
    res.end();
    return;
  }

  // ── GET /ping ──────────────────────────────────────────────────────────────
  if (pathname === '/ping' && method === 'GET') {
    return jsonResponse(res, 200, { ok: true, version: '1.0', time: new Date().toISOString() });
  }

  // ── POST /schedule ─────────────────────────────────────────────────────────
  // Body: { title, caption, image_url, ig_user_id, ig_token, scheduled_at }
  if (pathname === '/schedule' && method === 'POST') {
    if (!checkAuth(req)) return jsonResponse(res, 401, { error: 'Não autorizado' });
    try {
      const body = await readBody(req);
      const { title, caption, image_url, ig_user_id, ig_token, scheduled_at } = body;

      if (!title || !image_url || !ig_user_id || !ig_token || !scheduled_at) {
        return jsonResponse(res, 400, { error: 'Campos obrigatórios: title, image_url, ig_user_id, ig_token, scheduled_at' });
      }

      const id = crypto.randomUUID();
      const { fb_page_id, fb_page_token } = body;
      db.prepare(`
        INSERT INTO posts (id, title, caption, image_url, ig_user_id, ig_token, fb_page_id, fb_page_token, scheduled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, caption || '', image_url, ig_user_id, ig_token, fb_page_id || null, fb_page_token || null, scheduled_at);

      console.log(`[schedule] novo post agendado: ${id} para ${scheduled_at}`);
      return jsonResponse(res, 201, { id, scheduled_at, status: 'pending' });
    } catch(err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // ── POST /queue ────────────────────────────────────────────────────────────
  // Adiciona à fila — calcula horário baseado no último post agendado + intervalo
  // Body: { title, caption, image_url, ig_user_id, ig_token, interval_minutes (default 60) }
  if (pathname === '/queue' && method === 'POST') {
    if (!checkAuth(req)) return jsonResponse(res, 401, { error: 'Não autorizado' });
    try {
      const body = await readBody(req);
      const { title, caption, image_url, ig_user_id, ig_token, interval_minutes = 60 } = body;

      if (!title || !image_url || !ig_user_id || !ig_token) {
        return jsonResponse(res, 400, { error: 'Campos obrigatórios: title, image_url, ig_user_id, ig_token' });
      }

      // Pega o último post pendente/agendado
      const last = db.prepare(`
        SELECT scheduled_at FROM posts
        WHERE status IN ('pending', 'publishing') AND ig_user_id = ?
        ORDER BY scheduled_at DESC LIMIT 1
      `).get(ig_user_id);

      const baseTime = last
        ? new Date(last.scheduled_at)
        : new Date();

      const scheduledAt = new Date(baseTime.getTime() + interval_minutes * 60 * 1000).toISOString();
      const id = crypto.randomUUID();
      const { fb_page_id: fb_page_id_q } = body;

      db.prepare(`
        INSERT INTO posts (id, title, caption, image_url, ig_user_id, ig_token, fb_page_id, scheduled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, caption || '', image_url, ig_user_id, ig_token, fb_page_id_q || null, scheduledAt);

      console.log(`[queue] post adicionado à fila: ${id} para ${scheduledAt}`);
      return jsonResponse(res, 201, { id, scheduled_at: scheduledAt, status: 'pending' });
    } catch(err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // ── GET /posts ─────────────────────────────────────────────────────────────
  if (pathname === '/posts' && method === 'GET') {
    if (!checkAuth(req)) return jsonResponse(res, 401, { error: 'Não autorizado' });
    const status = parsed.query.status || null;
    const limit = parseInt(parsed.query.limit) || 50;
    const posts = status
      ? db.prepare(`SELECT id,title,caption,image_url,ig_user_id,scheduled_at,status,error,published_at,created_at FROM posts WHERE status=? ORDER BY scheduled_at DESC LIMIT ?`).all(status, limit)
      : db.prepare(`SELECT id,title,caption,image_url,ig_user_id,scheduled_at,status,error,published_at,created_at FROM posts ORDER BY scheduled_at DESC LIMIT ?`).all(limit);
    return jsonResponse(res, 200, { posts, total: posts.length });
  }

  // ── DELETE /posts/:id ──────────────────────────────────────────────────────
  const deleteMatch = pathname.match(/^\/posts\/([a-f0-9\-]+)$/);
  if (deleteMatch && method === 'DELETE') {
    if (!checkAuth(req)) return jsonResponse(res, 401, { error: 'Não autorizado' });
    const id = deleteMatch[1];
    const result = db.prepare(`DELETE FROM posts WHERE id=? AND status IN ('pending','failed')`).run(id);
    if (result.changes === 0) return jsonResponse(res, 404, { error: 'Post não encontrado, publicado ou em publicação' });
    return jsonResponse(res, 200, { ok: true, deleted: id });
  }

  // ── PATCH /posts/:id ───────────────────────────────────────────────────────
  const patchMatch = pathname.match(/^\/posts\/([a-f0-9\-]+)$/);
  if (patchMatch && method === 'PATCH') {
    if (!checkAuth(req)) return jsonResponse(res, 401, { error: 'Não autorizado' });
    try {
      const id = patchMatch[1];
      const body = await readBody(req);
      const { scheduled_at } = body;
      if (!scheduled_at) return jsonResponse(res, 400, { error: 'scheduled_at obrigatório' });
      const result = db.prepare(`UPDATE posts SET scheduled_at=? WHERE id=? AND status='pending'`).run(scheduled_at, id);
      if (result.changes === 0) return jsonResponse(res, 404, { error: 'Post não encontrado ou já publicado' });
      return jsonResponse(res, 200, { ok: true, id, scheduled_at });
    } catch(err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  return jsonResponse(res, 404, { error: 'Rota não encontrada' });
});

server.listen(PORT, () => {
  console.log('');
  console.log(`✓ Servidor de agendamento rodando na porta ${PORT}`);
  console.log(`  Banco: ${DB_PATH}`);
  console.log(`  Cron: verificando a cada minuto`);
  console.log('');
});
