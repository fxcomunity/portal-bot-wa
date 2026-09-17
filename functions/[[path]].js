import { neon } from '@neondatabase/serverless'

const ADMIN_COOKIE = 'portal_admin'
const SESSION_TTL_SECONDS = 60 * 60 * 8
const MAX_BODY_SIZE = 256 * 1024

function getSql(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured')
  return neon(env.DATABASE_URL)
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
    'Strict-Transport-Security':
      'max-age=31536000; includeSubDomains'
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...securityHeaders(),
      ...extraHeaders
    }
  })
}

function html(content, status = 200, extraHeaders = {}) {
  return new Response(content, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...securityHeaders(),
      ...extraHeaders
    }
  })
}

function redirect(url, status = 302) {
  return new Response(null, {
    status,
    headers: {
      Location: url,
      ...securityHeaders()
    }
  })
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max)
}

function cleanUsername(value) {
  return cleanText(value, 64)
}

function cleanSearch(value) {
  return cleanText(value, 100)
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

function parseCookies(request) {
  const cookies = {}
  const header = request.headers.get('Cookie') || ''

  for (const item of header.split(';')) {
    const index = item.indexOf('=')
    if (index === -1) continue

    const key = item.slice(0, index).trim()
    const value = item.slice(index + 1).trim()

    try {
      cookies[key] = decodeURIComponent(value)
    } catch {
      cookies[key] = value
    }
  }

  return cookies
}

async function sha256(value) {
  const data = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', data)

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)

  return Array.from(buffer)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function normalizePath(url) {
  let pathname = new URL(url).pathname

  if (pathname.length > 1) {
    pathname = pathname.replace(/\/+$/, '')
  }

  return pathname
}

async function readRequestBody(request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0)

  if (contentLength > MAX_BODY_SIZE) {
    throw new Error('BODY_TOO_LARGE')
  }

  const text = await request.text()

  if (text.length > MAX_BODY_SIZE) {
    throw new Error('BODY_TOO_LARGE')
  }

  return text
}

async function readForm(request) {
  const type = request.headers.get('Content-Type') || ''

  if (!type.toLowerCase().includes('application/x-www-form-urlencoded')) {
    throw new Error('INVALID_CONTENT_TYPE')
  }

  return new URLSearchParams(await readRequestBody(request))
}

async function cleanupStaleRooms(sql) {
  try {
    await sql`
      DELETE FROM chess_online_rooms
      WHERE updated_at < NOW() - INTERVAL '12 hours'
    `
  } catch (error) {
    console.error('[CLEANUP_ERROR]', error)
  }
}

/*
 * =========================================================
 * CHESS API
 *
 * Portal ini yang jadi gateway publik buat game chess bot:
 * - bot manggil /api/chess/create & /api/chess/join buat bikin room
 * - board HTML yang dikirim ke user manggil /api/chess/:roomCode
 *   buat ambil state & kirim move (polling tiap 1.2 detik)
 * - hasil pertandingan dicatat ke chess_online_matches, rating pemain
 *   di-update di chess_online_leaderboard buat ditampilin di /leaderboard
 *   & dashboard admin
 * =========================================================
 */

const CHESS_RATING_STEP = 20
const CHESS_RATING_DEFAULT = 1000
const CHESS_ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

let chessTablesReady = false

function chessCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }
}

function chessJson(data, status = 200) {
  return json(data, status, chessCorsHeaders())
}

function cleanChessPlayer(value) {
  return cleanText(value, 150)
}

function cleanChessRoom(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20)
}

function newChessToken() {
  return randomToken(20)
}

function makeChessRoomCode() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)

  let out = ''

  for (let i = 0; i < 8; i++) {
    out += CHESS_ROOM_CODE_CHARS[bytes[i] % CHESS_ROOM_CODE_CHARS.length]
  }

  return out
}

function chessInitialBoard() {
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']
  const board = Array.from({ length: 8 }, () => Array(8).fill(null))

  for (let c = 0; c < 8; c++) {
    board[0][c] = { color: 'b', type: back[c] }
    board[1][c] = { color: 'b', type: 'p' }
    board[6][c] = { color: 'w', type: 'p' }
    board[7][c] = { color: 'w', type: back[c] }
  }

  return board
}

function chessDefaultCastle() {
  return { w: { k: true, q: true }, b: { k: true, q: true } }
}

function chessDefaultCaptured() {
  return { w: [], b: [] }
}

async function readChessJsonBody(request) {
  const text = await readRequestBody(request)

  if (!text) return {}

  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function ensureChessTables(sql) {
  if (chessTablesReady) return

  await sql`
    CREATE TABLE IF NOT EXISTS chess_online_rooms (
      room_code VARCHAR(20) PRIMARY KEY,
      status VARCHAR(20) NOT NULL DEFAULT 'waiting',
      white_player VARCHAR(150),
      black_player VARCHAR(150),
      white_token VARCHAR(64),
      black_token VARCHAR(64),
      turn CHAR(1) NOT NULL DEFAULT 'w',
      board JSONB NOT NULL,
      castle JSONB NOT NULL,
      en_passant JSONB,
      halfmove INT NOT NULL DEFAULT 0,
      captured JSONB NOT NULL,
      move_count INT NOT NULL DEFAULT 0,
      winner CHAR(1),
      result VARCHAR(20),
      version BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `

  await sql`
    CREATE INDEX IF NOT EXISTS chess_online_rooms_updated_at_idx
    ON chess_online_rooms (updated_at)
  `

  await sql`
    CREATE TABLE IF NOT EXISTS chess_online_matches (
      id BIGSERIAL PRIMARY KEY,
      room_code VARCHAR(20) NOT NULL,
      white_player VARCHAR(150),
      black_player VARCHAR(150),
      winner VARCHAR(150),
      result VARCHAR(20),
      move_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE INDEX IF NOT EXISTS chess_online_matches_created_at_idx
    ON chess_online_matches (created_at)
  `

  await sql`
    CREATE TABLE IF NOT EXISTS chess_online_leaderboard (
      username VARCHAR(150) PRIMARY KEY,
      rating INT NOT NULL DEFAULT 1000,
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      draws INT NOT NULL DEFAULT 0,
      games INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  chessTablesReady = true
}

async function getChessRoom(sql, roomCode) {
  const rows = await sql`
    SELECT *
    FROM chess_online_rooms
    WHERE room_code = ${roomCode}
    LIMIT 1
  `

  return rows[0] || null
}

function chessColorFromToken(row, token) {
  if (!token) return null
  if (row.white_token && token === row.white_token) return 'w'
  if (row.black_token && token === row.black_token) return 'b'
  return null
}

function toChessGamePayload(row) {
  return {
    ok: true,
    id: row.room_code,
    roomCode: row.room_code,
    board: row.board,
    turn: row.turn,
    castle: row.castle,
    enPassant: row.en_passant ?? null,
    halfmove: row.halfmove,
    captured: row.captured,
    moveCount: row.move_count,
    status: row.status,
    winner: row.winner,
    version: Number(row.version)
  }
}

async function createChessRoom(sql, player) {
  let roomCode = null

  for (let i = 0; i < 10; i++) {
    const candidate = makeChessRoomCode()
    const existing = await getChessRoom(sql, candidate)

    if (!existing) {
      roomCode = candidate
      break
    }
  }

  if (!roomCode) {
    throw new Error('Gagal membuat room code')
  }

  const token = newChessToken()

  const board = JSON.stringify(chessInitialBoard())
  const castle = JSON.stringify(chessDefaultCastle())
  const captured = JSON.stringify(chessDefaultCaptured())

  const rows = await sql`
    INSERT INTO chess_online_rooms (
      room_code, status, white_player, white_token,
      turn, board, castle, en_passant, halfmove, captured, move_count, version
    )
    VALUES (
      ${roomCode}, 'waiting', ${player}, ${token},
      'w', ${board}::jsonb, ${castle}::jsonb, NULL, 0, ${captured}::jsonb, 0, 0
    )
    RETURNING *
  `

  const row = rows[0]

  return {
    ...toChessGamePayload(row),
    token,
    color: 'w',
    room_code: row.room_code
  }
}

async function joinChessRoom(sql, roomCode, player) {
  const row = await getChessRoom(sql, roomCode)

  if (!row) {
    return { error: 'ROOM_NOT_FOUND' }
  }

  if (row.white_player === player) {
    return {
      ...toChessGamePayload(row),
      token: row.white_token,
      color: 'w',
      room_code: row.room_code
    }
  }

  if (row.black_player === player) {
    return {
      ...toChessGamePayload(row),
      token: row.black_token,
      color: 'b',
      room_code: row.room_code
    }
  }

  if (row.black_player) {
    return { error: 'ROOM_FULL' }
  }

  const token = newChessToken()

  const updated = await sql`
    UPDATE chess_online_rooms
    SET black_player = ${player}, black_token = ${token},
        status = 'playing', updated_at = NOW()
    WHERE room_code = ${roomCode} AND black_player IS NULL
    RETURNING *
  `

  if (!updated.length) {
    const fresh = await getChessRoom(sql, roomCode)

    if (fresh?.black_player === player) {
      return {
        ...toChessGamePayload(fresh),
        token: fresh.black_token,
        color: 'b',
        room_code: fresh.room_code
      }
    }

    return { error: 'ROOM_FULL' }
  }

  const fresh = updated[0]

  return {
    ...toChessGamePayload(fresh),
    token,
    color: 'b',
    room_code: fresh.room_code
  }
}

async function recordChessMatch(sql, row, winnerColor, resultLabel) {
  const winnerName =
    winnerColor === 'w'
      ? row.white_player
      : winnerColor === 'b'
        ? row.black_player
        : null

  const loserName =
    winnerColor === 'w'
      ? row.black_player
      : winnerColor === 'b'
        ? row.white_player
        : null

  await sql`
    INSERT INTO chess_online_matches (
      room_code, white_player, black_player, winner, result, move_count
    )
    VALUES (
      ${row.room_code}, ${row.white_player}, ${row.black_player},
      ${winnerName}, ${resultLabel}, ${row.move_count}
    )
  `

  if (winnerName) {
    await sql`
      INSERT INTO chess_online_leaderboard (username, rating, wins, losses, draws, games, updated_at)
      VALUES (${winnerName}, ${CHESS_RATING_DEFAULT + CHESS_RATING_STEP}, 1, 0, 0, 1, NOW())
      ON CONFLICT (username) DO UPDATE SET
        rating = chess_online_leaderboard.rating + ${CHESS_RATING_STEP},
        wins = chess_online_leaderboard.wins + 1,
        games = chess_online_leaderboard.games + 1,
        updated_at = NOW()
    `
  }

  if (loserName) {
    await sql`
      INSERT INTO chess_online_leaderboard (username, rating, wins, losses, draws, games, updated_at)
      VALUES (${loserName}, ${Math.max(0, CHESS_RATING_DEFAULT - CHESS_RATING_STEP)}, 0, 1, 0, 1, NOW())
      ON CONFLICT (username) DO UPDATE SET
        rating = GREATEST(0, chess_online_leaderboard.rating - ${CHESS_RATING_STEP}),
        losses = chess_online_leaderboard.losses + 1,
        games = chess_online_leaderboard.games + 1,
        updated_at = NOW()
    `
  }

  if (!winnerName && !loserName) {
    for (const name of [row.white_player, row.black_player].filter(Boolean)) {
      await sql`
        INSERT INTO chess_online_leaderboard (username, rating, wins, losses, draws, games, updated_at)
        VALUES (${name}, ${CHESS_RATING_DEFAULT}, 0, 0, 1, 1, NOW())
        ON CONFLICT (username) DO UPDATE SET
          draws = chess_online_leaderboard.draws + 1,
          games = chess_online_leaderboard.games + 1,
          updated_at = NOW()
      `
    }
  }
}

async function syncChessRoom(sql, roomCode, body) {
  const row = await getChessRoom(sql, roomCode)

  if (!row) {
    return { status: 404, data: { ok: false, error: 'ROOM_NOT_FOUND' } }
  }

  const playerColor = chessColorFromToken(row, body.token)

  if (!playerColor) {
    return { status: 403, data: { ok: false, error: 'INVALID_TOKEN' } }
  }

  if (body.resign === true) {
    if (row.status === 'finished') {
      return { status: 200, data: toChessGamePayload(row) }
    }

    const winnerColor = playerColor === 'w' ? 'b' : 'w'
    const nextVersion = Number(row.version) + 1

    const updated = await sql`
      UPDATE chess_online_rooms
      SET status = 'finished', winner = ${winnerColor}, result = 'resign',
          version = ${nextVersion}, updated_at = NOW(), finished_at = NOW()
      WHERE room_code = ${roomCode} AND version = ${row.version}
      RETURNING *
    `

    if (!updated.length) {
      return { status: 409, data: { ok: false, error: 'STALE_VERSION' } }
    }

    const fresh = updated[0]

    await recordChessMatch(sql, fresh, winnerColor, 'resign').catch(error => {
      console.error('[CHESS_MATCH_ERROR]', error)
    })

    return { status: 200, data: toChessGamePayload(fresh) }
  }

  if (row.status === 'finished') {
    return { status: 409, data: { ok: false, error: 'GAME_FINISHED' } }
  }

  if (row.status !== 'playing') {
    return { status: 409, data: { ok: false, error: 'WAITING_FOR_PLAYER' } }
  }

  if (row.turn !== playerColor) {
    return { status: 409, data: { ok: false, error: 'NOT_YOUR_TURN' } }
  }

  const clientVersion = Number(body.version)

  if (
    Number.isFinite(clientVersion) &&
    clientVersion !== Number(row.version)
  ) {
    return { status: 409, data: { ok: false, error: 'STALE_VERSION' } }
  }

  const nextTurn = playerColor === 'w' ? 'b' : 'w'
  const nextVersion = Number(row.version) + 1
  const finished = body.status === 'finished'

  const winner =
    finished && (body.winner === 'w' || body.winner === 'b')
      ? body.winner
      : null

  const board = JSON.stringify(body.board ?? row.board)
  const castle = JSON.stringify(body.castle ?? row.castle)
  const enPassant = body.enPassant != null ? JSON.stringify(body.enPassant) : null
  const captured = JSON.stringify(body.captured ?? row.captured)

  const updated = await sql`
    UPDATE chess_online_rooms
    SET
      turn = ${nextTurn},
      board = ${board}::jsonb,
      castle = ${castle}::jsonb,
      en_passant = ${enPassant}::jsonb,
      halfmove = ${Number(body.halfmove || 0)},
      captured = ${captured}::jsonb,
      move_count = ${Number(body.moveCount || 0)},
      status = ${finished ? 'finished' : 'playing'},
      winner = ${winner},
      result = ${finished ? (winner ? 'checkmate' : 'draw') : null},
      version = ${nextVersion},
      updated_at = NOW(),
      finished_at = CASE WHEN ${finished} THEN NOW() ELSE finished_at END
    WHERE room_code = ${roomCode} AND version = ${row.version}
    RETURNING *
  `

  if (!updated.length) {
    return { status: 409, data: { ok: false, error: 'STALE_VERSION' } }
  }

  const fresh = updated[0]

  if (finished) {
    await recordChessMatch(sql, fresh, winner, winner ? 'checkmate' : 'draw').catch(error => {
      console.error('[CHESS_MATCH_ERROR]', error)
    })
  }

  return { status: 200, data: toChessGamePayload(fresh) }
}

async function handleChessCreate(request, sql) {
  const body = await readChessJsonBody(request)
  const player = cleanChessPlayer(body.player || body.playerId || body.jid)

  if (!player) {
    return chessJson({ ok: false, error: 'PLAYER_REQUIRED' }, 400)
  }

  await ensureChessTables(sql)
  const created = await createChessRoom(sql, player)

  return chessJson(created, 200)
}

async function handleChessJoin(request, sql) {
  const body = await readChessJsonBody(request)

  const roomCode = cleanChessRoom(body.room || body.roomCode || body.code)
  const player = cleanChessPlayer(body.player || body.playerId || body.jid)

  if (!roomCode || !player) {
    return chessJson({ ok: false, error: 'ROOM_AND_PLAYER_REQUIRED' }, 400)
  }

  await ensureChessTables(sql)
  const joined = await joinChessRoom(sql, roomCode, player)

  if (joined.error === 'ROOM_NOT_FOUND') {
    return chessJson({ ok: false, error: 'ROOM_NOT_FOUND' }, 404)
  }

  if (joined.error === 'ROOM_FULL') {
    return chessJson({ ok: false, error: 'ROOM_FULL' }, 409)
  }

  return chessJson(joined, 200)
}

async function handleChessRoom(request, sql, url, pathname, method) {
  const roomCode = cleanChessRoom(
    decodeURIComponent(pathname.slice('/api/chess/'.length))
  )

  if (!roomCode) {
    return chessJson({ ok: false, error: 'INVALID_ROOM_CODE' }, 400)
  }

  await ensureChessTables(sql)

  if (method === 'GET') {
    const token = url.searchParams.get('token') || ''
    const row = await getChessRoom(sql, roomCode)

    if (!row) {
      return chessJson({ ok: false, error: 'ROOM_NOT_FOUND' }, 404)
    }

    if (!chessColorFromToken(row, token)) {
      return chessJson({ ok: false, error: 'INVALID_TOKEN' }, 403)
    }

    return chessJson(toChessGamePayload(row), 200)
  }

  if (method === 'POST') {
    const body = await readChessJsonBody(request)
    const result = await syncChessRoom(sql, roomCode, body)

    return chessJson(result.data, result.status)
  }

  return chessJson({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
}

async function createAdminSession(sql, adminId, request) {
  const rawToken = randomToken(32)
  const tokenHash = await sha256(rawToken)

  await sql`
    INSERT INTO portal_admin_sessions (
      admin_id,
      token_hash,
      expires_at,
      ip_address,
      user_agent
    )
    VALUES (
      ${adminId},
      ${tokenHash},
      NOW() + INTERVAL '8 hours',
      ${getClientIp(request)},
      ${cleanText(request.headers.get('User-Agent'), 500)}
    )
  `

  return rawToken
}

async function getAdmin(sql, request) {
  const rawToken = parseCookies(request)[ADMIN_COOKIE]

  if (!rawToken || rawToken.length < 20) return null

  const tokenHash = await sha256(rawToken)

  const result = await sql`
    SELECT
      a.id,
      a.username,
      s.id AS session_id
    FROM portal_admin_sessions s
    JOIN portal_admins a ON a.id = s.admin_id
    WHERE s.token_hash = ${tokenHash}
      AND s.expires_at > NOW()
      AND a.active = TRUE
    LIMIT 1
  `

  return result[0] || null
}

async function deleteAdminSession(sql, request) {
  const rawToken = parseCookies(request)[ADMIN_COOKIE]
  if (!rawToken) return

  await sql`
    DELETE FROM portal_admin_sessions
    WHERE token_hash = ${await sha256(rawToken)}
  `
}

function loginCookie(token) {
  return [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ].join('; ')
}

function clearLoginCookie() {
  return [
    `${ADMIN_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0'
  ].join('; ')
}

function adminLoginPage(error = '') {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login - JACK Portal</title>
<style>
*{box-sizing:border-box}
body{
 margin:0;min-height:100vh;display:flex;align-items:center;
 justify-content:center;padding:20px;background:#070a10;color:#fff;
 font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif
}
.box{width:100%;max-width:400px}
.logo{
 width:72px;height:72px;border-radius:20px;background:#fff;color:#080b10;
 display:flex;align-items:center;justify-content:center;margin:0 auto 20px;
 font-weight:900;font-size:24px
}
.brand{text-align:center;margin-bottom:22px}
.brand h1{margin:0;font-size:25px}
.brand p{margin:7px 0 0;color:#7f8999;font-size:13px}
.card{
 background:#0d1119;border:1px solid #202836;border-radius:18px;
 padding:24px
}
.field{margin-bottom:16px}
label{display:block;margin-bottom:7px;color:#aeb7c5;font-size:13px}
input{
 width:100%;padding:13px;border-radius:10px;border:1px solid #293241;
 background:#080c13;color:#fff;outline:0;font-size:14px
}
input:focus{border-color:#66748a}
button{
 width:100%;padding:13px;border:0;border-radius:10px;background:#fff;
 color:#080b10;font-weight:800;cursor:pointer
}
.error{
 padding:11px;border-radius:10px;margin-bottom:16px;
 background:#251318;border:1px solid #5c2c35;color:#ffb8c1;font-size:13px
}
</style>
</head>
<body>
<main class="box">
<div class="logo">JP</div>
<div class="brand">
<h1>JACK Portal</h1>
<p>Administrator access</p>
</div>
<section class="card">
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
<form method="POST" action="/admin/login" autocomplete="off">
<div class="field">
<label>Username</label>
<input name="username" maxlength="64" autocomplete="username" required autofocus>
</div>
<div class="field">
<label>Password</label>
<input name="password" type="password" maxlength="128" autocomplete="current-password" required>
</div>
<button type="submit">Sign in</button>
</form>
</section>
</main>
</body>
</html>`
}

async function getDashboardData(sql) {
  let leaderboard = []
  let matches = []

  try {
    const result = await sql`
      SELECT *
      FROM chess_online_leaderboard
      ORDER BY rating DESC
      LIMIT 10
    `
    leaderboard = result
  } catch {}

  try {
    const result = await sql`
      SELECT *
      FROM chess_online_matches
      ORDER BY created_at DESC
      LIMIT 20
    `
    matches = result
  } catch {}

  return { leaderboard, matches }
}

function adminDashboard(admin, rooms, search, data, deleted = false) {
  const activePlayers = new Set()

  for (const room of rooms) {
    if (room.white_player) activePlayers.add(room.white_player)
    if (room.black_player) activePlayers.add(room.black_player)
  }

  const roomRows = rooms.length
    ? rooms.map(room => `
<tr>
<td><strong>${escapeHtml(room.room_code)}</strong></td>
<td>${escapeHtml(room.white_player || '-')}</td>
<td>${escapeHtml(room.black_player || '-')}</td>
<td>${escapeHtml(room.status || '-')}</td>
<td>${escapeHtml(room.updated_at ? new Date(room.updated_at).toLocaleString('id-ID') : '-')}</td>
<td>
<form method="POST" action="/admin/rooms/delete">
<input type="hidden" name="room_code" value="${escapeHtml(room.room_code)}">
<button class="danger" type="submit">Hapus</button>
</form>
</td>
</tr>
`).join('')
    : `<tr><td colspan="6" class="empty">Tidak ada room ditemukan.</td></tr>`

  const leaderboardRows = data.leaderboard.length
    ? data.leaderboard.map((player, index) => `
<tr>
<td>${index + 1}</td>
<td>${escapeHtml(player.username || player.player_name || player.name || '-')}</td>
<td>${escapeHtml(player.rating ?? '-')}</td>
<td>${escapeHtml(player.wins ?? '-')}</td>
<td>${escapeHtml(player.losses ?? '-')}</td>
</tr>
`).join('')
    : `<tr><td colspan="5" class="empty">Leaderboard belum tersedia.</td></tr>`

  const matchRows = data.matches.length
    ? data.matches.map(match => `
<tr>
<td>${escapeHtml(match.room_code || '-')}</td>
<td>${escapeHtml(match.white_player || '-')}</td>
<td>${escapeHtml(match.black_player || '-')}</td>
<td>${escapeHtml(match.result || match.status || '-')}</td>
<td>${escapeHtml(match.created_at ? new Date(match.created_at).toLocaleString('id-ID') : '-')}</td>
</tr>
`).join('')
    : `<tr><td colspan="5" class="empty">Match history belum tersedia.</td></tr>`

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Dashboard - JACK Portal</title>
<style>
*{box-sizing:border-box}
body{
 margin:0;background:#070a10;color:#f4f7fb;
 font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif
}
button,input{font:inherit}
.layout{display:flex;min-height:100vh}
.sidebar{
 width:250px;background:#0b0f17;border-right:1px solid #202836;
 padding:20px;position:fixed;inset:0 auto 0 0;z-index:10;
 transition:.2s
}
.logo{
 width:44px;height:44px;border-radius:12px;background:#fff;color:#080b10;
 display:flex;align-items:center;justify-content:center;font-weight:900
}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:30px}
.brand strong{font-size:17px}
.brand small{display:block;color:#697386;margin-top:3px}
.nav button{
 width:100%;border:0;background:transparent;color:#8c96a7;
 text-align:left;padding:12px;border-radius:9px;margin-bottom:5px;cursor:pointer
}
.nav button:hover,.nav button.active{background:#151b26;color:#fff}
.main{margin-left:250px;width:calc(100% - 250px);padding:22px}
.top{
 display:flex;align-items:center;justify-content:space-between;
 gap:12px;margin-bottom:22px
}
.top h1{margin:0;font-size:22px}
.top p{margin:4px 0 0;color:#707a8b;font-size:13px}
.menu{display:none;border:1px solid #293241;background:#0d1119;color:#fff;border-radius:9px;padding:9px 12px}
.logout{
 text-decoration:none;color:#aeb7c5;border:1px solid #293241;
 padding:9px 12px;border-radius:9px;font-size:13px
}
.stats{
 display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px
}
.stat{
 background:#0d1119;border:1px solid #202836;border-radius:14px;padding:17px
}
.stat span{color:#707a8b;font-size:12px}
.stat strong{display:block;font-size:25px;margin-top:7px}
.card{
 background:#0d1119;border:1px solid #202836;border-radius:14px;
 margin-bottom:16px;overflow:hidden
}
.card-head{
 display:flex;align-items:center;justify-content:space-between;
 padding:16px;border-bottom:1px solid #202836
}
.card-head h2{margin:0;font-size:15px}
.toolbar{display:flex;gap:9px}
.search{
 flex:1;min-width:0;background:#080c13;color:#fff;
 border:1px solid #293241;border-radius:9px;padding:11px
}
.search-btn{
 border:0;border-radius:9px;padding:0 16px;background:#fff;
 color:#080b10;font-weight:800;cursor:pointer
}
.table-wrap{overflow:auto}
table{width:100%;border-collapse:collapse;min-width:700px}
th,td{padding:13px 15px;border-bottom:1px solid #1b222e;text-align:left;font-size:13px}
th{color:#707a8b;font-size:11px;text-transform:uppercase}
td{color:#cbd2dd}
tr:last-child td{border-bottom:0}
.danger{
 border:1px solid #59313a;background:#211318;color:#ffb8c1;
 border-radius:7px;padding:7px 10px;cursor:pointer
}
.empty{text-align:center;color:#697386;padding:30px}
.success{
 padding:11px 13px;border:1px solid #294634;background:#101b14;
 color:#a9dfb7;border-radius:10px;margin-bottom:16px;font-size:13px
}
.page{display:none}
.page.active{display:block}
@media(max-width:800px){
 .sidebar{transform:translateX(-100%)}
 .sidebar.open{transform:translateX(0)}
 .main{margin-left:0;width:100%;padding:14px}
 .menu{display:block}
 .logout{font-size:12px}
 .stats{grid-template-columns:1fr}
 .card-head{align-items:stretch;flex-direction:column;gap:10px}
 .toolbar{width:100%}
}
</style>
</head>
<body>
<div class="layout">

<aside class="sidebar" id="sidebar">
<div class="brand">
<div class="logo">JP</div>
<div>
<strong>JACK Portal</strong>
<small>Administration</small>
</div>
</div>

<nav class="nav">
<button class="active" data-page="overview">Dashboard</button>
<button data-page="rooms">Rooms</button>
<button data-page="leaderboard">Leaderboard</button>
<button data-page="matches">Match History</button>
<button data-page="settings">Settings</button>
</nav>
</aside>

<main class="main">
<header class="top">
<div style="display:flex;align-items:center;gap:10px">
<button class="menu" id="menu">Menu</button>
<div>
<h1>Dashboard</h1>
<p>Logged in as ${escapeHtml(admin.username)}</p>
</div>
</div>
<a class="logout" href="/admin/logout">Logout</a>
</header>

${deleted ? `<div class="success">Room berhasil dihapus.</div>` : ''}

<section class="page active" id="page-overview">
<div class="stats">
<div class="stat">
<span>Total Room</span>
<strong>${rooms.length}</strong>
</div>
<div class="stat">
<span>Pemain Aktif</span>
<strong>${activePlayers.size}</strong>
</div>
<div class="stat">
<span>Leaderboard</span>
<strong>${data.leaderboard.length}</strong>
</div>
</div>

<div class="card">
<div class="card-head"><h2>Room Terbaru</h2></div>
<div class="table-wrap">
<table>
<thead><tr><th>Room</th><th>White</th><th>Black</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead>
<tbody>${roomRows}</tbody>
</table>
</div>
</div>
</section>

<section class="page" id="page-rooms">
<div class="card">
<div class="card-head">
<h2>Rooms</h2>
<form class="toolbar" method="GET" action="/admin">
<input class="search" name="search" value="${escapeHtml(search)}" placeholder="Cari room / pemain..." maxlength="100">
<button class="search-btn">Cari</button>
</form>
</div>
<div class="table-wrap">
<table>
<thead><tr><th>Room</th><th>White</th><th>Black</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead>
<tbody>${roomRows}</tbody>
</table>
</div>
</div>
</section>

<section class="page" id="page-leaderboard">
<div class="card">
<div class="card-head"><h2>Leaderboard</h2></div>
<div class="table-wrap">
<table>
<thead><tr><th>#</th><th>Pemain</th><th>Rating</th><th>Wins</th><th>Losses</th></tr></thead>
<tbody>${leaderboardRows}</tbody>
</table>
</div>
</div>
</section>

<section class="page" id="page-matches">
<div class="card">
<div class="card-head"><h2>Match History</h2></div>
<div class="table-wrap">
<table>
<thead><tr><th>Room</th><th>White</th><th>Black</th><th>Result</th><th>Waktu</th></tr></thead>
<tbody>${matchRows}</tbody>
</table>
</div>
</div>
</section>

<section class="page" id="page-settings">
<div class="card">
<div class="card-head"><h2>Settings Admin</h2></div>
<form method="POST" action="/admin/settings" style="padding:16px">
<div style="margin-bottom:14px">
<label>Username</label>
<input class="search" style="width:100%;margin-top:7px" name="username" value="${escapeHtml(admin.username)}" maxlength="64" required>
</div>
<div style="margin-bottom:14px">
<label>Password Baru</label>
<input class="search" style="width:100%;margin-top:7px" name="password" type="password" maxlength="128" placeholder="Kosongkan jika tidak ingin mengubah">
</div>
<button class="search-btn" style="padding:11px 16px" type="submit">Simpan Perubahan</button>
</form>
</div>
</section>

</main>
</div>

<script>
const sidebar=document.getElementById('sidebar')
const menu=document.getElementById('menu')

menu?.addEventListener('click',()=>sidebar.classList.toggle('open'))

document.querySelectorAll('.nav button').forEach(button=>{
 button.addEventListener('click',()=>{
  document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'))
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'))

  button.classList.add('active')
  document.getElementById('page-'+button.dataset.page)?.classList.add('active')
  sidebar.classList.remove('open')
 })
})
</script>
</body>
</html>`
}

async function handleAdminLogin(request, sql) {
  if (request.method === 'GET') return html(adminLoginPage())

  if (request.method !== 'POST') {
    return json({ok:false,error:'METHOD_NOT_ALLOWED'},405)
  }

  const form = await readForm(request)
  const username = cleanUsername(form.get('username'))
  const password = String(form.get('password') || '')

  if (!username || !password) {
    return html(adminLoginPage('Username dan password wajib diisi.'),400)
  }

  if (password.length > 128) {
    return html(adminLoginPage('Password tidak valid.'),400)
  }

  const ip = getClientIp(request)

  try {
    const attempts = await sql`
      SELECT attempts, blocked_until
      FROM portal_login_attempts
      WHERE ip = ${ip}
      LIMIT 1
    `

    if (
      attempts.length &&
      attempts[0].blocked_until &&
      new Date(attempts[0].blocked_until) > new Date()
    ) {
      return html(adminLoginPage('Terlalu banyak percobaan login. Coba lagi nanti.'),429)
    }

    const admins = await sql`
      SELECT id, username
      FROM portal_admins
      WHERE username = ${username}
        AND active = TRUE
        AND password_hash = crypt(${password}, password_hash)
      LIMIT 1
    `

    if (!admins.length) {
      await sql`
        INSERT INTO portal_login_attempts
          (ip, window_started_at, attempts, blocked_until)
        VALUES
          (${ip}, NOW(), 1, NULL)
        ON CONFLICT (ip)
        DO UPDATE SET
          attempts = CASE
            WHEN portal_login_attempts.window_started_at < NOW() - INTERVAL '15 minutes'
            THEN 1
            ELSE portal_login_attempts.attempts + 1
          END,
          window_started_at = CASE
            WHEN portal_login_attempts.window_started_at < NOW() - INTERVAL '15 minutes'
            THEN NOW()
            ELSE portal_login_attempts.window_started_at
          END,
          blocked_until = CASE
            WHEN portal_login_attempts.attempts + 1 >= 8
            THEN NOW() + INTERVAL '15 minutes'
            ELSE portal_login_attempts.blocked_until
          END
      `

      return html(adminLoginPage('Username atau password salah.'),401)
    }

    await sql`DELETE FROM portal_login_attempts WHERE ip = ${ip}`

    const token = await createAdminSession(sql,admins[0].id,request)

    return new Response(null,{
      status:303,
      headers:{
        Location:'/admin',
        'Set-Cookie':loginCookie(token),
        ...securityHeaders()
      }
    })
  } catch(error) {
    console.error('[ADMIN_LOGIN_ERROR]',error)
    return html(adminLoginPage('Login gagal karena konfigurasi server bermasalah.'),500)
  }
}

async function handleAdmin(request,sql,url) {
  const admin = await getAdmin(sql,request)

  if (!admin) return redirect('/admin/login')

  const search = cleanSearch(url.searchParams.get('search'))
  const pattern = `%${search}%`

  let rooms = []

  if (search) {
    rooms = await sql`
      SELECT room_code,white_player,black_player,status,updated_at
      FROM chess_online_rooms
      WHERE room_code ILIKE ${pattern}
         OR COALESCE(white_player,'') ILIKE ${pattern}
         OR COALESCE(black_player,'') ILIKE ${pattern}
      ORDER BY updated_at DESC
      LIMIT 100
    `
  } else {
    rooms = await sql`
      SELECT room_code,white_player,black_player,status,updated_at
      FROM chess_online_rooms
      ORDER BY updated_at DESC
      LIMIT 100
    `
  }

  const data = await getDashboardData(sql)

  return html(
    adminDashboard(
      admin,
      rooms,
      search,
      data,
      url.searchParams.get('deleted') === '1'
    )
  )
}

async function handleAdminDelete(request,sql) {
  const admin = await getAdmin(sql,request)

  if (!admin) return redirect('/admin/login')

  if (request.method !== 'POST') {
    return json({ok:false,error:'METHOD_NOT_ALLOWED'},405)
  }

  const form = await readForm(request)
  const roomCode = cleanText(form.get('room_code'),64)

  if (roomCode) {
    await sql`
      DELETE FROM chess_online_rooms
      WHERE room_code = ${roomCode}
    `
  }

  return redirect('/admin?deleted=1')
}

async function handleAdminSettings(request,sql) {
  const admin = await getAdmin(sql,request)

  if (!admin) return redirect('/admin/login')

  if (request.method !== 'POST') {
    return json({ok:false,error:'METHOD_NOT_ALLOWED'},405)
  }

  const form = await readForm(request)
  const username = cleanUsername(form.get('username'))
  const password = String(form.get('password') || '')

  if (!username) {
    return json({ok:false,error:'INVALID_USERNAME'},400)
  }

  if (password && password.length < 8) {
    return json({ok:false,error:'PASSWORD_TOO_SHORT'},400)
  }

  if (password.length > 128) {
    return json({ok:false,error:'PASSWORD_TOO_LONG'},400)
  }

  try {
    if (password) {
      await sql`
        UPDATE portal_admins
        SET
          username = ${username},
          password_hash = crypt(${password},gen_salt('bf',12)),
          updated_at = NOW()
        WHERE id = ${admin.id}
      `
    } else {
      await sql`
        UPDATE portal_admins
        SET
          username = ${username},
          updated_at = NOW()
        WHERE id = ${admin.id}
      `
    }

    await sql`
      DELETE FROM portal_admin_sessions
      WHERE admin_id = ${admin.id}
        AND id <> ${admin.session_id}
    `

    return redirect('/admin')
  } catch(error) {
    console.error('[ADMIN_SETTINGS_ERROR]',error)
    return json({ok:false,error:'SETTINGS_UPDATE_FAILED'},500)
  }
}

async function handleAdminLogout(request,sql) {
  try {
    await deleteAdminSession(sql,request)
  } catch(error) {
    console.error('[LOGOUT_ERROR]',error)
  }

  return new Response(null,{
    status:303,
    headers:{
      Location:'/admin/login',
      'Set-Cookie':clearLoginCookie(),
      ...securityHeaders()
    }
  })
}

async function handleHealth(sql) {
  try {
    await sql`SELECT 1 AS ok`

    return json({
      ok:true,
      service:'jack-portal',
      database:'connected'
    })
  } catch(error) {
    console.error('[HEALTH_ERROR]',error)

    return json({
      ok:false,
      service:'jack-portal',
      database:'error'
    },503)
  }
}

async function handleStatus(sql) {
  try {
    const [rooms, players, matches] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM chess_online_rooms WHERE status IN ('waiting','playing')`,
      sql`SELECT COUNT(*)::int AS n FROM chess_online_leaderboard`,
      sql`SELECT COUNT(*)::int AS n FROM chess_online_matches`
    ])

    return json({
      ok:true,
      total_rooms:rooms[0]?.n || 0,
      total_players:players[0]?.n || 0,
      total_matches:matches[0]?.n || 0
    })
  } catch(error) {
    console.error('[STATUS_ERROR]',error)
    return json({ok:false,error:'INTERNAL_SERVER_ERROR'},500)
  }
}

async function getPortalStats(sql) {
  try {
    const [rooms, players, matches] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM chess_online_rooms WHERE status IN ('waiting','playing')`,
      sql`SELECT COUNT(*)::int AS n FROM chess_online_leaderboard`,
      sql`SELECT COUNT(*)::int AS n FROM chess_online_matches`
    ])

    return {
      activeRooms: rooms[0]?.n || 0,
      totalPlayers: players[0]?.n || 0,
      totalMatches: matches[0]?.n || 0
    }
  } catch(error) {
    console.error('[STATS_ERROR]',error)
    return { activeRooms:0, totalPlayers:0, totalMatches:0 }
  }
}

async function getActiveChessRooms(sql, search) {
  if (search) {
    const pattern = `%${search}%`

    return sql`
      SELECT room_code,status,white_player,black_player,turn,updated_at
      FROM chess_online_rooms
      WHERE status IN ('waiting','playing')
        AND room_code ILIKE ${pattern}
      ORDER BY updated_at DESC
      LIMIT 50
    `
  }

  return sql`
    SELECT room_code,status,white_player,black_player,turn,updated_at
    FROM chess_online_rooms
    WHERE status IN ('waiting','playing')
    ORDER BY updated_at DESC
    LIMIT 50
  `
}

async function getChessLeaderboardRows(sql) {
  return sql`
    SELECT username,rating,wins,losses,draws,games
    FROM chess_online_leaderboard
    ORDER BY rating DESC, games DESC
    LIMIT 100
  `
}

async function handleRoomsApi(sql,url) {
  try {
    const rooms = await getActiveChessRooms(sql, cleanSearch(url.searchParams.get('search')))
    return json({ok:true,rooms})
  } catch(error) {
    console.error('[ROOMS_API_ERROR]',error)
    return json({ok:false,error:'INTERNAL_SERVER_ERROR'},500)
  }
}

async function handleLeaderboardApi(sql) {
  try {
    const leaderboard = await getChessLeaderboardRows(sql)
    return json({ok:true,leaderboard})
  } catch(error) {
    console.error('[LEADERBOARD_API_ERROR]',error)
    return json({ok:true,leaderboard:[]})
  }
}

/*
 * =========================================================
 * TAMPILAN PUBLIK (home / rooms / leaderboard)
 * =========================================================
 */

function timeAgo(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()

  if (!Number.isFinite(time)) return '-'

  const diff = Math.max(0, Date.now() - time)
  const sec = Math.floor(diff / 1000)

  if (sec < 60) return 'baru saja'

  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} menit lalu`

  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} jam lalu`

  return `${Math.floor(hr / 24)} hari lalu`
}

function publicPageStyles() {
  return `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
 min-height:100vh;background:
  radial-gradient(circle at top,#1b1224 0,#0a0b10 45%,#06070b 100%);
 color:#f4f2f8;
 font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
 padding:28px 18px 60px
}
a{color:inherit}
.wrap{width:100%;max-width:880px;margin:0 auto}
.topnav{
 display:flex;align-items:center;justify-content:space-between;
 gap:14px;margin-bottom:34px;flex-wrap:wrap
}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none}
.brand .mark{
 width:42px;height:42px;border-radius:13px;
 background:linear-gradient(135deg,#ff6fae,#7c4dff);
 display:flex;align-items:center;justify-content:center;
 font-weight:900;font-size:15px;color:#fff;flex-shrink:0
}
.brand strong{display:block;font-size:16px;letter-spacing:-.3px}
.brand span{display:block;color:#8b93a5;font-size:11.5px;margin-top:1px}
.navlinks{display:flex;gap:8px;flex-wrap:wrap}
.navlinks a{
 text-decoration:none;font-size:13px;font-weight:600;color:#c6cbdb;
 padding:9px 14px;border-radius:10px;border:1px solid #232433;
 background:rgba(255,255,255,.02);transition:.15s
}
.navlinks a:hover{background:rgba(255,255,255,.06);color:#fff}
.navlinks a.active{
 background:linear-gradient(135deg,#ff6fae,#7c4dff);
 border-color:transparent;color:#fff
}
.hero{text-align:center;margin-bottom:30px}
.hero h1{margin:0 0 8px;font-size:30px;letter-spacing:-.6px}
.hero p{margin:0;color:#9aa1b4;font-size:14.5px;line-height:1.6}
.stats{
 display:grid;grid-template-columns:repeat(3,1fr);gap:12px;
 margin:26px 0
}
.stat{
 background:#0f0e17;border:1px solid #24232f;border-radius:16px;
 padding:16px 14px;text-align:center
}
.stat strong{display:block;font-size:23px;font-weight:800}
.stat span{display:block;color:#8b8fa0;font-size:11px;margin-top:4px;text-transform:uppercase;letter-spacing:.4px}
.menu{display:flex;flex-direction:column;gap:12px;margin-top:8px}
a.card{
 display:flex;align-items:center;justify-content:space-between;gap:12px;
 padding:20px;border-radius:16px;text-decoration:none;font-weight:700;font-size:16px;
 background:linear-gradient(135deg,#ff5fa5,#7c4dff);color:#fff;
 box-shadow:0 16px 40px rgba(124,77,255,.22)
}
a.card.alt{background:linear-gradient(135deg,#3fb8ff,#4d6bff);box-shadow:0 16px 40px rgba(63,184,255,.18)}
a.card .arrow{font-size:20px;opacity:.85}
.note{margin-top:26px;text-align:center;font-size:12.5px;color:#6d7285;line-height:1.7}
.note b{color:#c6cbdb}
.panel{
 background:#0f0e17;border:1px solid #24232f;border-radius:18px;
 overflow:hidden;margin-top:6px
}
.panel-head{
 padding:18px 20px;border-bottom:1px solid #21212d;
 display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap
}
.panel-head h2{margin:0;font-size:16px}
.panel-head .sub{font-size:12px;color:#7d8296;margin-top:3px}
.search-form{display:flex;gap:8px}
.search-form input{
 background:#0a0a11;border:1px solid #262735;color:#fff;
 border-radius:10px;padding:9px 12px;font-size:13px;outline:none;min-width:0
}
.search-form input:focus{border-color:#7c4dff}
.search-form button{
 border:0;border-radius:10px;padding:0 15px;font-weight:700;
 background:#fff;color:#0a0a11;cursor:pointer;font-size:13px
}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:560px}
th,td{padding:13px 20px;text-align:left;font-size:13px;border-bottom:1px solid #1b1b26}
th{color:#767c90;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}
tr:last-child td{border-bottom:0}
td code{background:#191926;padding:3px 8px;border-radius:7px;font-size:12.5px;letter-spacing:.5px}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:4px 10px;border-radius:20px;font-weight:600}
.badge.playing{background:#13291d;color:#7ee6a3}
.badge.waiting{background:#332612;color:#ffcf7a}
.badge.dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.rank{font-weight:800;width:26px;height:26px;line-height:26px;border-radius:50%;display:inline-block;text-align:center;font-size:12.5px;background:#181820}
.rank.gold{color:#ffd166}
.rank.silver{color:#d9d9e3}
.rank.bronze{color:#e0a06b}
.turn{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:#c6cbdb}
.turn-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;display:inline-block}
.turn-dot.w{background:#f4f2f8;box-shadow:0 0 0 1px #3a3a48 inset}
.turn-dot.b{background:#15151d;box-shadow:0 0 0 1px #3a3a48 inset}
.you-lead{color:#fff;font-weight:700}
.win{color:#7ee6a3}
.loss{color:#ff8f9c}
.empty{text-align:center;color:#6d7285;padding:48px 20px;font-size:13.5px}
.footer-link{display:block;text-align:center;margin-top:24px;font-size:13px;color:#9aa1b4;text-decoration:none}
.footer-link:hover{color:#fff}
@media(max-width:640px){
 .stats{grid-template-columns:1fr}
 .panel-head{flex-direction:column;align-items:stretch}
 .search-form{width:100%}
 .search-form input{flex:1}
 th,td{padding:12px 14px}
 table{min-width:520px}
}
`
}

function publicTopNav(active) {
  const items = [
    { href:'/', label:'Home', key:'home' },
    { href:'/rooms', label:'Room Aktif', key:'rooms' },
    { href:'/leaderboard', label:'Leaderboard', key:'leaderboard' }
  ]

  return `
<div class="topnav">
<a class="brand" href="/">
<div class="mark">JP</div>
<div>
<strong>JACK Portal</strong>
<span>Chess Online Gateway</span>
</div>
</a>
<nav class="navlinks">
${items.map(item => `<a href="${item.href}"${item.key === active ? ' class="active"' : ''}>${item.label}</a>`).join('')}
</nav>
</div>`
}

async function handleHome(sql) {
  const stats = await getPortalStats(sql)

  return html(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JACK Portal</title>
<style>${publicPageStyles()}</style>
</head>
<body>
<main class="wrap">
${publicTopNav('home')}

<section class="hero">
<h1>JACK Portal</h1>
<p>Gateway online buat Qiro Ai Chess — main tetap di WhatsApp,<br>di sini cuma buat pantau room &amp; leaderboard.</p>
</section>

<div class="stats">
<div class="stat"><strong>${stats.activeRooms}</strong><span>Room Aktif</span></div>
<div class="stat"><strong>${stats.totalPlayers}</strong><span>Pemain Tercatat</span></div>
<div class="stat"><strong>${stats.totalMatches}</strong><span>Match Selesai</span></div>
</div>

<div class="menu">
<a class="card" href="/rooms">Room Aktif<span class="arrow">→</span></a>
<a class="card alt" href="/leaderboard">Leaderboard<span class="arrow">→</span></a>
</div>

<div class="note">Mau main? Chat bot-nya di WhatsApp, ketik <b>.chess online</b> atau <b>.catur online</b>.</div>
</main>
</body>
</html>`)
}

async function handleRoomsPage(sql, url) {
  const search = cleanSearch(url.searchParams.get('search'))
  const rows = await getActiveChessRooms(sql, search)

  const body = rows.length
    ? rows.map(r => {
        const badge = r.status === 'playing'
          ? `<span class="badge playing"><span class="badge dot"></span>Main</span>`
          : `<span class="badge waiting"><span class="badge dot"></span>Nunggu</span>`

        return `<tr>
<td><code>${escapeHtml(r.room_code)}</code></td>
<td>${badge}</td>
<td>${escapeHtml(r.white_player || '-')}</td>
<td>${escapeHtml(r.black_player || 'menunggu...')}</td>
<td>${r.turn === 'w' ? '<span class="turn"><i class="turn-dot w"></i>White</span>' : '<span class="turn"><i class="turn-dot b"></i>Black</span>'}</td>
<td>${timeAgo(r.updated_at)}</td>
</tr>`
      }).join('')
    : `<tr><td colspan="6" class="empty">Gak ada room yang lagi aktif. Ketik <b>.chess online</b> di WA buat bikin room baru.</td></tr>`

  return html(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Room Aktif - JACK Portal</title>
<style>${publicPageStyles()}</style>
</head>
<body>
<main class="wrap">
${publicTopNav('rooms')}

<section class="panel">
<div class="panel-head">
<div>
<h2>Room Aktif</h2>
<div class="sub">Auto-refresh tiap 10 detik</div>
</div>
<form class="search-form" method="GET" action="/rooms">
<input type="search" name="search" value="${escapeHtml(search)}" placeholder="Cari kode room..." maxlength="20">
<button type="submit">Cari</button>
</form>
</div>
<div class="table-wrap">
<table>
<thead><tr><th>Kode</th><th>Status</th><th>White</th><th>Black</th><th>Giliran</th><th>Update</th></tr></thead>
<tbody>${body}</tbody>
</table>
</div>
</section>

<a class="footer-link" href="/">← Kembali ke Home</a>
</main>
</body>
</html>`)
}

async function handleLeaderboardPage(sql) {
  const rows = await getChessLeaderboardRows(sql)

  const body = rows.length
    ? rows.map((r, i) => {
        const rank = i + 1
        const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : ''
        const medal = String(rank)

        return `<tr>
<td><span class="rank ${rankClass}">${medal}</span></td>
<td>${escapeHtml(r.username)}</td>
<td><strong>${r.rating}</strong></td>
<td class="win">${r.wins}</td>
<td class="loss">${r.losses}</td>
<td>${r.draws}</td>
<td>${r.games}</td>
</tr>`
      }).join('')
    : `<tr><td colspan="7" class="empty">Belum ada game yang selesai. Yuk main dulu di WhatsApp!</td></tr>`

  return html(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leaderboard - JACK Portal</title>
<style>${publicPageStyles()}</style>
</head>
<body>
<main class="wrap">
${publicTopNav('leaderboard')}

<section class="panel">
<div class="panel-head">
<div>
<h2>Chess Leaderboard</h2>
<div class="sub">Diurutin berdasarkan rating</div>
</div>
</div>
<div class="table-wrap">
<table>
<thead><tr><th>#</th><th>Pemain</th><th>Rating</th><th>W</th><th>L</th><th>D</th><th>Main</th></tr></thead>
<tbody>${body}</tbody>
</table>
</div>
</section>

<a class="footer-link" href="/">← Kembali ke Home</a>
</main>
</body>
</html>`)
}

async function router(request,env) {
  const url = new URL(request.url)
  const pathname = normalizePath(request.url)
  const method = request.method.toUpperCase()
  const sql = getSql(env)

  if (method === 'OPTIONS' && pathname.startsWith('/api/chess/')) {
    return new Response(null, {
      status: 204,
      headers: {
        ...securityHeaders(),
        ...chessCorsHeaders()
      }
    })
  }

  // Pastiin tabel chess_online_rooms/chess_online_matches/chess_online_leaderboard selalu ada
  // sebelum route manapun (termasuk admin dashboard) query ke sana.
  // Cegah "relation does not exist" pas fresh deploy / belum ada game sama sekali.
  // Dibungkus try/catch: kalau proses bikin tabel ini gagal (misal kolom bentrok
  // sama tabel lama), JANGAN sampai ikut nge-down-in seluruh portal (home/admin/dll).
  // Route yang beneran butuh tabel chess (create/join/sync/rooms/leaderboard) akan
  // gagal sendiri dengan pesan error yang jelas, bukan portal-nya total mati.
  try {
    await ensureChessTables(sql)
  } catch (error) {
    console.error('[CHESS_TABLES_ERROR]', error)
  }

  if (pathname === '/health') {
    return handleHealth(sql)
  }

  if (pathname === '/admin/login') {
    return handleAdminLogin(request,sql)
  }

  if (pathname === '/admin/logout') {
    return handleAdminLogout(request,sql)
  }

  if (pathname === '/admin') {
    if (method !== 'GET') {
      return json({ok:false,error:'METHOD_NOT_ALLOWED'},405)
    }

    return handleAdmin(request,sql,url)
  }

  if (pathname === '/admin/rooms/delete') {
    return handleAdminDelete(request,sql)
  }

  if (pathname === '/admin/settings') {
    return handleAdminSettings(request,sql)
  }

  await cleanupStaleRooms(sql)

  if (pathname === '/') {
    return handleHome(sql)
  }

  if (pathname === '/api/status') {
    return handleStatus(sql)
  }

  if (pathname === '/rooms') {
    return handleRoomsPage(sql,url)
  }

  if (pathname === '/api/rooms') {
    return handleRoomsApi(sql,url)
  }

  if (pathname === '/leaderboard') {
    return handleLeaderboardPage(sql)
  }

  if (pathname === '/api/leaderboard') {
    return handleLeaderboardApi(sql)
  }

  if (pathname === '/api/chess/create') {
    return handleChessCreate(request, sql)
  }

  if (pathname === '/api/chess/join') {
    return handleChessJoin(request, sql)
  }

  if (pathname.startsWith('/api/chess/')) {
    return handleChessRoom(request, sql, url, pathname, method)
  }

  return json({
    ok:false,
    error:'NOT_FOUND'
  },404)
}

export async function onRequest(context) {
  try {
    return await router(context.request,context.env)
  } catch(error) {
    console.error('[PORTAL_ERROR]',error)

    if (error?.message === 'BODY_TOO_LARGE') {
      return json({ok:false,error:'BODY_TOO_LARGE'},413)
    }

    if (error?.message === 'INVALID_CONTENT_TYPE') {
      return json({ok:false,error:'INVALID_CONTENT_TYPE'},415)
    }

    return json({
      ok:false,
      error:'INTERNAL_SERVER_ERROR',
      // TODO: cabut field "detail" ini kalau udah stabil, ini cuma buat debug sementara
      detail: String(error?.message || error)
    },500)
  }
}
