import http from 'node:http'
import crypto from 'node:crypto'
import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

const PORT = Number(
  process.env.CHESS_PORT ||
  process.env.PORT ||
  3000
)

const connectionString =
  process.env.CHESS_DATABASE_URL ||
  process.env.DATABASE_URL ||
  ''

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
})

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // tanpa 0/O/1/I biar gak ketuker

function sendHtml(res, status, html) {
  const body = String(html)

  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  })

  res.end(body)
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })

  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', chunk => {
      body += chunk

      if (body.length > 1024 * 1024) {
        reject(new Error('Request terlalu besar'))
        req.destroy()
      }
    })

    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('JSON tidak valid'))
      }
    })

    req.on('error', reject)
  })
}

function cleanPlayer(value) {
  return String(value || '').trim().slice(0, 100)
}

function cleanRoom(value) {
  return String(value || '').trim().toUpperCase().slice(0, 20)
}

function newToken() {
  return crypto.randomBytes(20).toString('hex')
}

function makeRoomCode() {
  let out = ''
  const bytes = crypto.randomBytes(8)

  for (let i = 0; i < 8; i++) {
    out += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length]
  }

  return out
}

/*
 * Papan awal catur, harus sama persis format-nya
 * dengan initial() di client (plugins/game/chess.js)
 */
function initialBoard() {
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']

  const b = Array.from({ length: 8 }, () => Array(8).fill(null))

  for (let c = 0; c < 8; c++) {
    b[0][c] = { color: 'b', type: back[c] }
    b[1][c] = { color: 'b', type: 'p' }
    b[6][c] = { color: 'w', type: 'p' }
    b[7][c] = { color: 'w', type: back[c] }
  }

  return b
}

function initialState() {
  return {
    board: initialBoard(),
    castle: { w: { k: true, q: true }, b: { k: true, q: true } },
    enPassant: null,
    halfmove: 0,
    captured: { w: [], b: [] },
    moveCount: 0
  }
}

/*
 * ============================
 * RPG_USERS / CHESS_PLAYERS
 * (chess_rooms.white_player/black_player FK ke rpg_users.jid,
 *  jadi player harus ke-daftar dulu sebelum bisa dipasang)
 * ============================
 */
async function ensurePlayerExists(jid) {
  await pool.query(
    `INSERT INTO rpg_users (jid) VALUES ($1) ON CONFLICT (jid) DO NOTHING`,
    [jid]
  )

  await pool.query(
    `INSERT INTO chess_players (jid) VALUES ($1) ON CONFLICT (jid) DO NOTHING`,
    [jid]
  )
}

async function getRoom(roomCode) {
  const { rows } = await pool.query(
    `SELECT * FROM chess_rooms WHERE room_code = $1 LIMIT 1`,
    [roomCode]
  )

  return rows[0] || null
}

function colorFromToken(row, token) {
  if (!token) return null
  if (row.white_token && token === row.white_token) return 'w'
  if (row.black_token && token === row.black_token) return 'b'
  return null
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toGamePayload(row) {
  const state = row.state || {}

  return {
    ok: true,
    id: row.room_code,
    roomCode: row.room_code,
    board: state.board,
    turn: row.turn,
    castle: state.castle,
    enPassant: state.enPassant ?? null,
    halfmove: state.halfmove ?? 0,
    captured: state.captured,
    moveCount: state.moveCount ?? 0,
    status: row.status,
    winner: row.winner,
    version: Number(row.version)
  }
}

/*
 * ============================
 * LEADERBOARD (pake view yang udah ada)
 * ============================
 */
async function getLeaderboard(limit = 50) {
  const { rows } = await pool.query(
    `SELECT position, jid, rating, games, wins, losses, draws, win_streak, best_win_streak
     FROM leaderboard_chess
     ORDER BY position ASC
     LIMIT $1`,
    [limit]
  )

  return rows
}

/*
 * ============================
 * ROOM AKTIF (waiting / playing)
 * ============================
 */
async function getActiveRooms(limit = 50) {
  const { rows } = await pool.query(
    `
    SELECT room_code, status, white_player, black_player, turn, updated_at
    FROM chess_rooms
    WHERE status IN ('waiting', 'playing')
    ORDER BY updated_at DESC
    LIMIT $1
    `,
    [limit]
  )

  return rows
}

function renderPortalHome() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jack Portal</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f0f14;color:#f2f2f2;display:flex;min-height:100vh;align-items:center;justify-content:center}
.wrap{max-width:420px;padding:32px;text-align:center}
h1{font-size:28px;margin-bottom:4px}
p{color:#a0a0ab;margin-top:0;font-size:14px}
.menu{display:flex;flex-direction:column;gap:12px;margin-top:24px}
a.card{display:block;padding:18px;border-radius:14px;background:linear-gradient(135deg,#ff4fd8,#7c4dff);color:#fff;text-decoration:none;font-weight:600;font-size:16px}
a.card.alt{background:linear-gradient(135deg,#4facfe,#00f2fe)}
.note{margin-top:24px;font-size:12px;color:#6b6b76}
</style>
</head>
<body>
<div class="wrap">
<h1>♟️ Jack Portal</h1>
<p>Gateway info game WhatsApp Bot — main tetap di WA, di sini cuma pantau.</p>
<div class="menu">
<a class="card alt" href="/rooms">🎮 Room Aktif</a>
<a class="card" href="/leaderboard">🏆 Leaderboard</a>
</div>
<div class="note">Mau main? Chat bot-nya, ketik <b>.chess online</b> di WhatsApp.</div>
</div>
</body>
</html>`
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diff / 1000)

  if (sec < 60) return `${sec}d lalu`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m lalu`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}j lalu`
  return `${Math.floor(hr / 24)}h lalu`
}

function renderRoomsPage(rows) {
  const items = rows.map(r => {
    const statusBadge =
      r.status === 'playing'
        ? `<span class="badge playing">🟢 Main</span>`
        : `<span class="badge waiting">🟡 Nunggu</span>`

    return `<tr>
<td><code>${escapeHtml(r.room_code)}</code></td>
<td>${statusBadge}</td>
<td>${escapeHtml(r.white_player || '-')}</td>
<td>${escapeHtml(r.black_player || 'menunggu...')}</td>
<td>${r.turn === 'w' ? '⚪' : '⚫'}</td>
<td>${timeAgo(r.updated_at)}</td>
</tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Room Aktif - Jack Portal</title>
<meta http-equiv="refresh" content="10">
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f0f14;color:#f2f2f2;padding:24px}
h1{font-size:22px;margin-bottom:4px;text-align:center}
.sub{text-align:center;color:#a0a0ab;font-size:12px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;max-width:640px;margin:0 auto;font-size:14px}
th,td{padding:10px 6px;text-align:left;border-bottom:1px solid #262631}
th{color:#a0a0ab;font-size:11px;text-transform:uppercase}
code{background:#1c1c26;padding:3px 6px;border-radius:6px;font-size:13px}
.badge{font-size:12px;padding:3px 8px;border-radius:20px;white-space:nowrap}
.badge.playing{background:#123a24;color:#7CFF9E}
.badge.waiting{background:#3a3312;color:#FFD86B}
.empty{text-align:center;color:#a0a0ab;padding:32px}
.back{display:block;text-align:center;margin-top:20px;color:#7c4dff;text-decoration:none}
</style>
</head>
<body>
<h1>🎮 Room Aktif</h1>
<div class="sub">Auto-refresh tiap 10 detik</div>
${
  rows.length
    ? `<table><thead><tr><th>Kode</th><th>Status</th><th>White</th><th>Black</th><th>Giliran</th><th>Update</th></tr></thead><tbody>${items}</tbody></table>`
    : `<div class="empty">Gak ada room yang lagi aktif.</div>`
}
<a class="back" href="/">← Kembali ke Portal</a>
</body>
</html>`
}

function renderLeaderboardPage(rows) {
  const items = rows.map(r => {
    const rank = Number(r.position)
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`

    return `<tr>
<td>${medal}</td>
<td>${escapeHtml(r.jid)}</td>
<td>${r.rating}</td>
<td>${r.wins}</td>
<td>${r.losses}</td>
<td>${r.draws}</td>
<td>${r.games}</td>
</tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leaderboard - Jack Portal</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f0f14;color:#f2f2f2;padding:24px}
h1{font-size:22px;margin-bottom:16px;text-align:center}
table{width:100%;border-collapse:collapse;max-width:620px;margin:0 auto;font-size:14px}
th,td{padding:10px 6px;text-align:left;border-bottom:1px solid #262631}
th{color:#a0a0ab;font-size:11px;text-transform:uppercase}
td:nth-child(3){color:#FFD86B}
td:nth-child(4){color:#7CFF9E}
td:nth-child(5){color:#FF7C7C}
.empty{text-align:center;color:#a0a0ab;padding:32px}
.back{display:block;text-align:center;margin-top:20px;color:#7c4dff;text-decoration:none}
</style>
</head>
<body>
<h1>🏆 Chess Leaderboard</h1>
${
  rows.length
    ? `<table><thead><tr><th>#</th><th>Pemain</th><th>Rating</th><th>W</th><th>L</th><th>D</th><th>Main</th></tr></thead><tbody>${items}</tbody></table>`
    : `<div class="empty">Belum ada game yang selesai.</div>`
}
<a class="back" href="/">← Kembali ke Portal</a>
</body>
</html>`
}

/*
 * ============================
 * CREATE ROOM
 * ============================
 */
async function createGame(player) {
  await ensurePlayerExists(player)

  let roomCode = null

  for (let i = 0; i < 10; i++) {
    const candidate = makeRoomCode()
    const existing = await getRoom(candidate)

    if (!existing) {
      roomCode = candidate
      break
    }
  }

  if (!roomCode) {
    throw new Error('Gagal membuat room code')
  }

  const token = newToken()

  const { rows } = await pool.query(
    `
    INSERT INTO chess_rooms
    (room_code, status, white_player, white_token, turn, state, version)
    VALUES ($1, 'waiting', $2, $3, 'w', $4, 0)
    RETURNING *
    `,
    [roomCode, player, token, initialState()]
  )

  const row = rows[0]

  return {
    ...toGamePayload(row),
    token,
    color: 'w',
    room_code: row.room_code
  }
}

/*
 * ============================
 * JOIN ROOM
 * ============================
 */
async function joinGame(roomCode, player) {
  const row = await getRoom(roomCode)

  if (!row) {
    return { error: 'ROOM_NOT_FOUND' }
  }

  if (row.white_player === player) {
    return {
      ...toGamePayload(row),
      token: row.white_token,
      color: 'w',
      room_code: row.room_code
    }
  }

  if (row.black_player === player) {
    return {
      ...toGamePayload(row),
      token: row.black_token,
      color: 'b',
      room_code: row.room_code
    }
  }

  if (row.black_player) {
    return { error: 'ROOM_FULL' }
  }

  await ensurePlayerExists(player)

  const token = newToken()

  const updateResult = await pool.query(
    `
    UPDATE chess_rooms
    SET black_player = $1, black_token = $2, status = 'playing', updated_at = NOW()
    WHERE room_code = $3 AND black_player IS NULL
    `,
    [player, token, roomCode]
  )

  if (updateResult.rowCount === 0) {
    const fresh = await getRoom(roomCode)

    if (fresh?.black_player === player) {
      return {
        ...toGamePayload(fresh),
        token: fresh.black_token,
        color: 'b',
        room_code: fresh.room_code
      }
    }

    return { error: 'ROOM_FULL' }
  }

  const fresh = await getRoom(roomCode)

  return {
    ...toGamePayload(fresh),
    token,
    color: 'b',
    room_code: fresh.room_code
  }
}

/*
 * ============================
 * RATING SEDERHANA + CATAT KE chess_matches
 * ============================
 */
const RATING_STEP = 20

async function finalizeMatch(row, winnerColor, resultLabel) {
  const winnerJid =
    winnerColor === 'w'
      ? row.white_player
      : winnerColor === 'b'
        ? row.black_player
        : null

  const loserJid =
    winnerColor === 'w'
      ? row.black_player
      : winnerColor === 'b'
        ? row.white_player
        : null

  await pool.query(
    `
    INSERT INTO chess_matches
    (room_code, white_player, black_player, winner, result, move_count, moves, final_state, started_at, finished_at)
    VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7, $8, NOW())
    `,
    [
      row.room_code,
      row.white_player,
      row.black_player,
      winnerJid,
      resultLabel,
      row.state?.moveCount || 0,
      row.state || {},
      row.created_at
    ]
  )

  if (winnerJid) {
    await pool.query(
      `
      UPDATE chess_players
      SET
        games = games + 1,
        wins = wins + 1,
        rating = rating + $2,
        win_streak = win_streak + 1,
        best_win_streak = GREATEST(best_win_streak, win_streak + 1),
        updated_at = NOW()
      WHERE jid = $1
      `,
      [winnerJid, RATING_STEP]
    )
  }

  if (loserJid) {
    await pool.query(
      `
      UPDATE chess_players
      SET
        games = games + 1,
        losses = losses + 1,
        rating = GREATEST(0, rating - $2),
        win_streak = 0,
        updated_at = NOW()
      WHERE jid = $1
      `,
      [loserJid, RATING_STEP]
    )
  }

  if (!winnerJid && !loserJid && (row.white_player || row.black_player)) {
    // draw
    for (const jid of [row.white_player, row.black_player].filter(Boolean)) {
      await pool.query(
        `
        UPDATE chess_players
        SET games = games + 1, draws = draws + 1, win_streak = 0, updated_at = NOW()
        WHERE jid = $1
        `,
        [jid]
      )
    }
  }
}

/*
 * ============================
 * SYNC MOVE / RESIGN
 * ============================
 */
async function syncGame(roomCode, body) {
  const row = await getRoom(roomCode)

  if (!row) {
    return { status: 404, data: { ok: false, error: 'ROOM_NOT_FOUND' } }
  }

  const playerColor = colorFromToken(row, body.token)

  if (!playerColor) {
    return { status: 403, data: { ok: false, error: 'INVALID_TOKEN' } }
  }

  /*
   * ---- RESIGN ----
   */
  if (body.resign === true) {
    if (row.status === 'finished') {
      return { status: 200, data: toGamePayload(row) }
    }

    const winnerColor = playerColor === 'w' ? 'b' : 'w'
    const nextVersion = Number(row.version) + 1

    await pool.query(
      `
      UPDATE chess_rooms
      SET status = 'finished', winner = $1, result = 'resign', version = $2, updated_at = NOW(), finished_at = NOW()
      WHERE room_code = $3 AND version = $4
      `,
      [winnerColor, nextVersion, roomCode, row.version]
    )

    const fresh = await getRoom(roomCode)
    await finalizeMatch(fresh, winnerColor, 'resign').catch(err =>
      console.error('[CHESS] finalizeMatch (resign) gagal:', err)
    )

    return { status: 200, data: toGamePayload(fresh) }
  }

  /*
   * ---- MOVE SYNC ----
   */
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
      : finished
        ? null // draw / stalemate
        : null

  const newState = {
    board: body.board ?? row.state?.board,
    castle: body.castle ?? row.state?.castle,
    enPassant: body.enPassant != null ? body.enPassant : null,
    halfmove: Number(body.halfmove || 0),
    captured: body.captured ?? row.state?.captured,
    moveCount: Number(body.moveCount || 0)
  }

  const updateResult = await pool.query(
    `
    UPDATE chess_rooms
    SET
      turn = $1,
      state = $2,
      status = $3,
      winner = $4,
      result = $5,
      version = $6,
      updated_at = NOW(),
      finished_at = CASE WHEN $3 = 'finished' THEN NOW() ELSE finished_at END
    WHERE room_code = $7 AND version = $8
    `,
    [
      nextTurn,
      newState,
      finished ? 'finished' : 'playing',
      winner,
      finished ? (winner ? 'checkmate' : 'draw') : null,
      nextVersion,
      roomCode,
      row.version
    ]
  )

  if (updateResult.rowCount === 0) {
    return { status: 409, data: { ok: false, error: 'STALE_VERSION' } }
  }

  const fresh = await getRoom(roomCode)

  if (finished) {
    await finalizeMatch(fresh, winner, winner ? 'checkmate' : 'draw').catch(err =>
      console.error('[CHESS] finalizeMatch gagal:', err)
    )
  }

  return { status: 200, data: toGamePayload(fresh) }
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })

    res.end()
    return
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  )

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, 200, renderPortalHome())
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, {
        ok: true,
        service: 'Jack Portal',
        database: 'Neon Postgres',
        status: 'online',
        time: Date.now()
      })
    }

    if (req.method === 'GET' && url.pathname === '/leaderboard') {
      const rows = await getLeaderboard(50)
      return sendHtml(res, 200, renderLeaderboardPage(rows))
    }

    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      const rows = await getLeaderboard(50)
      return sendJson(res, 200, { ok: true, leaderboard: rows })
    }

    if (req.method === 'GET' && url.pathname === '/rooms') {
      const rows = await getActiveRooms(50)
      return sendHtml(res, 200, renderRoomsPage(rows))
    }

    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      const rows = await getActiveRooms(50)
      return sendJson(res, 200, { ok: true, rooms: rows })
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      await pool.query('SELECT 1')

      return sendJson(res, 200, {
        ok: true,
        database: true,
        service: 'chess'
      })
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/api/chess/create'
    ) {
      const body = await readBody(req)

      const player = cleanPlayer(
        body.player || body.playerId || body.jid
      )

      if (!player) {
        return sendJson(res, 400, {
          ok: false,
          error: 'PLAYER_REQUIRED'
        })
      }

      const created = await createGame(player)

      return sendJson(res, 200, created)
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/api/chess/join'
    ) {
      const body = await readBody(req)

      const roomCode = cleanRoom(
        body.room || body.roomCode || body.code
      )

      const player = cleanPlayer(
        body.player || body.playerId || body.jid
      )

      if (!roomCode || !player) {
        return sendJson(res, 400, {
          ok: false,
          error: 'ROOM_AND_PLAYER_REQUIRED'
        })
      }

      const joined = await joinGame(roomCode, player)

      if (joined.error === 'ROOM_NOT_FOUND') {
        return sendJson(res, 404, {
          ok: false,
          error: 'ROOM_NOT_FOUND'
        })
      }

      if (joined.error === 'ROOM_FULL') {
        return sendJson(res, 409, {
          ok: false,
          error: 'ROOM_FULL'
        })
      }

      return sendJson(res, 200, joined)
    }

    /*
     * ============================
     * DYNAMIC GAME ENDPOINT
     * dipakai oleh papan catur (browser):
     * GET  /api/chess/:roomCode?token=...   -> ambil state
     * POST /api/chess/:roomCode             -> kirim move / resign
     * ============================
     */
    if (url.pathname.startsWith('/api/chess/')) {
      const roomCode = cleanRoom(
        decodeURIComponent(
          url.pathname.slice('/api/chess/'.length)
        )
      )

      if (!roomCode) {
        return sendJson(res, 400, {
          ok: false,
          error: 'INVALID_ROOM_CODE'
        })
      }

      if (req.method === 'GET') {
        const token = url.searchParams.get('token') || ''

        const row = await getRoom(roomCode)

        if (!row) {
          return sendJson(res, 404, {
            ok: false,
            error: 'ROOM_NOT_FOUND'
          })
        }

        if (!colorFromToken(row, token)) {
          return sendJson(res, 403, {
            ok: false,
            error: 'INVALID_TOKEN'
          })
        }

        return sendJson(res, 200, toGamePayload(row))
      }

      if (req.method === 'POST') {
        const body = await readBody(req)
        const result = await syncGame(roomCode, body)

        return sendJson(res, result.status, result.data)
      }

      return sendJson(res, 405, {
        ok: false,
        error: 'METHOD_NOT_ALLOWED'
      })
    }

    return sendJson(res, 404, {
      ok: false,
      error: 'NOT_FOUND'
    })
  } catch (error) {
    console.error('[CHESS SERVER ERROR]', error)

    return sendJson(res, 500, {
      ok: false,
      error: 'INTERNAL_SERVER_ERROR',
      message:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error'
    })
  }
}

export async function startChessServer() {
  try {
    if (!connectionString) {
      throw new Error(
        'CHESS_DATABASE_URL / DATABASE_URL belum diisi di .env'
      )
    }

    console.log('[CHESS] Checking Neon Postgres...')

    await pool.query('SELECT 1')

    console.log('[CHESS] Neon Postgres connected')

    const check = await pool.query(
      `SELECT to_regclass('public.chess_rooms') AS t`
    )

    if (!check.rows[0]?.t) {
      throw new Error(
        'Tabel chess_rooms tidak ditemukan. Pastikan schema database sudah di-import.'
      )
    }

    console.log('[CHESS] Schema chess_rooms terdeteksi, siap pakai')

    const server = http.createServer(handle)

    server.listen(PORT, '0.0.0.0', () => {
      console.log('')
      console.log('======================================')
      console.log('             JACK PORTAL')
      console.log('======================================')
      console.log(`Port     : ${PORT}`)
      console.log('Database : Neon Postgres')
      console.log('Status   : ONLINE')
      console.log('======================================')
      console.log('')
    })

    process.on('SIGTERM', async () => {
      server.close()
      await pool.end()
      process.exit(0)
    })

    process.on('SIGINT', async () => {
      server.close()
      await pool.end()
      process.exit(0)
    })

    return server
  } catch (error) {
    console.error('')
    console.error('======================================')
    console.error('       CHESS SERVER GAGAL')
    console.error('======================================')
    console.error(error)
    console.error('======================================')
    console.error('')

    throw error
  }
}
