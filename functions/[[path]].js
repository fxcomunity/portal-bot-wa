/**
 * Jack Portal — Cloudflare Pages Function
 */

import { neon } from '@neondatabase/serverless'

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra
  }
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
  })
}

function html(status, body) {
  return new Response(body, {
    status,
    headers: corsHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"
    })
  })
}

function cleanPlayer(value) {
  return String(value || '')
    .trim()
    .replace(/[<>"'`]/g, '')
    .slice(0, 100)
}

function cleanRoom(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20)
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(
    bytes,
    b => b.toString(16).padStart(2, '0')
  ).join('')
}

function makeRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let out = ''

  for (let i = 0; i < 8; i++) {
    out += ROOM_CODE_CHARS[
      bytes[i] % ROOM_CODE_CHARS.length
    ]
  }

  return out
}

function initialBoard() {
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']
  const b = Array.from(
    { length: 8 },
    () => Array(8).fill(null)
  )

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
    castle: {
      w: { k: true, q: true },
      b: { k: true, q: true }
    },
    enPassant: null,
    halfmove: 0,
    captured: {
      w: [],
      b: []
    },
    moveCount: 0
  }
}

function colorFromToken(row, token) {
  if (!token) return null

  if (
    row.white_token &&
    token === row.white_token
  ) {
    return 'w'
  }

  if (
    row.black_token &&
    token === row.black_token
  ) {
    return 'b'
  }

  return null
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
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

function timeAgo(iso) {
  if (!iso) return '-'

  const diff = Math.max(
    0,
    Date.now() - new Date(iso).getTime()
  )

  const sec = Math.floor(diff / 1000)

  if (sec < 60) return `${sec}d lalu`

  const min = Math.floor(sec / 60)

  if (min < 60) return `${min}m lalu`

  const hr = Math.floor(min / 60)

  if (hr < 24) return `${hr}j lalu`

  return `${Math.floor(hr / 24)}h lalu`
}

function renderPortalHome() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jack Portal</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  font-family:system-ui,sans-serif;
  background:#0f0f14;
  color:#f2f2f2;
  display:flex;
  min-height:100vh;
  align-items:center;
  justify-content:center
}
.wrap{
  width:100%;
  max-width:420px;
  padding:32px;
  text-align:center
}
h1{
  font-size:28px;
  margin:0 0 6px
}
p{
  color:#a0a0ab;
  margin:0;
  font-size:14px
}
.menu{
  display:flex;
  flex-direction:column;
  gap:12px;
  margin-top:24px
}
a.card{
  display:block;
  padding:18px;
  border-radius:14px;
  background:linear-gradient(135deg,#ff4fd8,#7c4dff);
  color:#fff;
  text-decoration:none;
  font-weight:600;
  font-size:16px
}
a.card.alt{
  background:linear-gradient(135deg,#4facfe,#00f2fe)
}
.note{
  margin-top:24px;
  font-size:12px;
  color:#6b6b76
}
</style>
</head>
<body>
<div class="wrap">
<h1>Jack Portal</h1>
<p>Gateway info game WhatsApp Bot — main tetap di WA.</p>

<div class="menu">
<a class="card alt" href="/rooms">Room Aktif</a>
<a class="card" href="/leaderboard">Leaderboard</a>
</div>

<div class="note">
Mau main? Chat bot-nya, ketik <b>.chess online</b> di WhatsApp.
</div>
</div>
</body>
</html>`
}

function renderRoomsPage(rows) {
  const items = rows.map(r => {
    const statusBadge =
      r.status === 'playing'
        ? `<span class="badge playing">Main</span>`
        : `<span class="badge waiting">Nunggu</span>`

    return `<tr>
<td><code>${escapeHtml(r.room_code)}</code></td>
<td>${statusBadge}</td>
<td>${escapeHtml(r.white_player || '-')}</td>
<td>${escapeHtml(r.black_player || 'menunggu...')}</td>
<td>${r.turn === 'w' ? 'White' : 'Black'}</td>
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
*{box-sizing:border-box}
body{
  margin:0;
  font-family:system-ui,sans-serif;
  background:#0f0f14;
  color:#f2f2f2;
  padding:24px
}
h1{
  font-size:22px;
  margin-bottom:4px;
  text-align:center
}
.sub{
  text-align:center;
  color:#a0a0ab;
  font-size:12px;
  margin-bottom:16px
}
table{
  width:100%;
  border-collapse:collapse;
  max-width:640px;
  margin:0 auto;
  font-size:14px
}
th,td{
  padding:10px 6px;
  text-align:left;
  border-bottom:1px solid #262631
}
th{
  color:#a0a0ab;
  font-size:11px;
  text-transform:uppercase
}
code{
  background:#1c1c26;
  padding:3px 6px;
  border-radius:6px;
  font-size:13px
}
.badge{
  font-size:12px;
  padding:3px 8px;
  border-radius:20px;
  white-space:nowrap
}
.badge.playing{
  background:#123a24;
  color:#7CFF9E
}
.badge.waiting{
  background:#3a3312;
  color:#FFD86B
}
.empty{
  text-align:center;
  color:#a0a0ab;
  padding:32px
}
.back{
  display:block;
  text-align:center;
  margin-top:20px;
  color:#7c4dff;
  text-decoration:none
}
</style>
</head>
<body>
<h1>Room Aktif</h1>
<div class="sub">Auto-refresh tiap 10 detik</div>

${
  rows.length
    ? `<table>
<thead>
<tr>
<th>Kode</th>
<th>Status</th>
<th>White</th>
<th>Black</th>
<th>Giliran</th>
<th>Update</th>
</tr>
</thead>
<tbody>${items}</tbody>
</table>`
    : `<div class="empty">Gak ada room yang lagi aktif.</div>`
}

<a class="back" href="/">Kembali ke Portal</a>
</body>
</html>`
}

function renderLeaderboardPage(rows) {
  const items = rows.map(r => {
    const rank = Number(r.position)

    return `<tr>
<td>#${rank}</td>
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
*{box-sizing:border-box}
body{
  margin:0;
  font-family:system-ui,sans-serif;
  background:#0f0f14;
  color:#f2f2f2;
  padding:24px
}
h1{
  font-size:22px;
  margin-bottom:16px;
  text-align:center
}
table{
  width:100%;
  border-collapse:collapse;
  max-width:620px;
  margin:0 auto;
  font-size:14px
}
th,td{
  padding:10px 6px;
  text-align:left;
  border-bottom:1px solid #262631
}
th{
  color:#a0a0ab;
  font-size:11px;
  text-transform:uppercase
}
.empty{
  text-align:center;
  color:#a0a0ab;
  padding:32px
}
.back{
  display:block;
  text-align:center;
  margin-top:20px;
  color:#7c4dff;
  text-decoration:none
}
</style>
</head>
<body>
<h1>Chess Leaderboard</h1>

${
  rows.length
    ? `<table>
<thead>
<tr>
<th>#</th>
<th>Pemain</th>
<th>Rating</th>
<th>W</th>
<th>L</th>
<th>D</th>
<th>Main</th>
</tr>
</thead>
<tbody>${items}</tbody>
</table>`
    : `<div class="empty">Belum ada game yang selesai.</div>`
}

<a class="back" href="/">Kembali ke Portal</a>
</body>
</html>`
}

const RATING_STEP = 20

async function finalizeMatch(
  sql,
  row,
  winnerColor,
  resultLabel
) {
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

  await sql`
    INSERT INTO chess_matches
    (
      room_code,
      white_player,
      black_player,
      winner,
      result,
      move_count,
      moves,
      final_state,
      started_at,
      finished_at
    )
    VALUES (
      ${row.room_code},
      ${row.white_player},
      ${row.black_player},
      ${winnerJid},
      ${resultLabel},
      ${row.state?.moveCount || 0},
      '[]'::jsonb,
      ${JSON.stringify(row.state || {})},
      ${row.created_at},
      NOW()
    )
  `

  if (winnerJid) {
    await sql`
      UPDATE chess_players
      SET
        games = games + 1,
        wins = wins + 1,
        rating = rating + ${RATING_STEP},
        win_streak = win_streak + 1,
        best_win_streak =
          GREATEST(
            best_win_streak,
            win_streak + 1
          ),
        updated_at = NOW()
      WHERE jid = ${winnerJid}
    `
  }

  if (loserJid) {
    await sql`
      UPDATE chess_players
      SET
        games = games + 1,
        losses = losses + 1,
        rating =
          GREATEST(
            0,
            rating - ${RATING_STEP}
          ),
        win_streak = 0,
        updated_at = NOW()
      WHERE jid = ${loserJid}
    `
  }

  if (!winnerJid && !loserJid) {
    for (
      const jid of
      [row.white_player, row.black_player]
        .filter(Boolean)
    ) {
      await sql`
        UPDATE chess_players
        SET
          games = games + 1,
          draws = draws + 1,
          win_streak = 0,
          updated_at = NOW()
        WHERE jid = ${jid}
      `
    }
  }
}

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    })
  }

  const connectionString =
    env.CHESS_DATABASE_URL ||
    env.DATABASE_URL ||
    ''

  if (!connectionString) {
    return json(500, {
      ok: false,
      error: 'DATABASE_URL_NOT_CONFIGURED'
    })
  }

  const sql = neon(connectionString, {
    fullResults: true
  })

  const url = new URL(request.url)
  const pathname = url.pathname

  try {
    /*
     * HEALTH
     *
     * Sengaja diletakkan sebelum query lain.
     * Endpoint ini hanya menguji koneksi Neon.
     */
    if (
      request.method === 'GET' &&
      pathname === '/health'
    ) {
      await sql`SELECT 1`

      return json(200, {
        ok: true,
        database: true,
        service: 'chess'
      })
    }

    if (
      request.method === 'GET' &&
      pathname === '/'
    ) {
      return html(
        200,
        renderPortalHome()
      )
    }

    if (
      request.method === 'GET' &&
      pathname === '/api/status'
    ) {
      return json(200, {
        ok: true,
        service: 'Jack Portal',
        database: 'Neon Postgres',
        status: 'online',
        time: Date.now()
      })
    }

    /*
     * LEADERBOARD
     */
    if (
      pathname === '/leaderboard' ||
      pathname === '/api/leaderboard'
    ) {
      const { rows } = await sql`
        SELECT
          position,
          jid,
          rating,
          games,
          wins,
          losses,
          draws,
          win_streak,
          best_win_streak
        FROM leaderboard_chess
        ORDER BY position ASC
        LIMIT 50
      `

      return pathname === '/leaderboard'
        ? html(
            200,
            renderLeaderboardPage(rows)
          )
        : json(200, {
            ok: true,
            leaderboard: rows
          })
    }

    /*
     * ROOM AKTIF
     */
    if (
      pathname === '/rooms' ||
      pathname === '/api/rooms'
    ) {
      const { rows } = await sql`
        SELECT
          room_code,
          status,
          white_player,
          black_player,
          turn,
          updated_at
        FROM chess_rooms
        WHERE status IN ('waiting', 'playing')
        ORDER BY updated_at DESC
        LIMIT 50
      `

      return pathname === '/rooms'
        ? html(
            200,
            renderRoomsPage(rows)
          )
        : json(200, {
            ok: true,
            rooms: rows
          })
    }

    /*
     * CREATE ROOM
     */
    if (
      request.method === 'POST' &&
      pathname === '/api/chess/create'
    ) {
      let body = {}

      try {
        body = await request.json()
      } catch {}

      const player = cleanPlayer(
        body.player ||
        body.playerId ||
        body.jid
      )

      if (!player) {
        return json(400, {
          ok: false,
          error: 'PLAYER_REQUIRED'
        })
      }

      await sql`
        INSERT INTO rpg_users (jid)
        VALUES (${player})
        ON CONFLICT (jid) DO NOTHING
      `

      await sql`
        INSERT INTO chess_players (jid)
        VALUES (${player})
        ON CONFLICT (jid) DO NOTHING
      `

      let roomCode = null

      for (let i = 0; i < 10; i++) {
        const candidate = makeRoomCode()

        const { rows: existing } = await sql`
          SELECT 1
          FROM chess_rooms
          WHERE room_code = ${candidate}
          LIMIT 1
        `

        if (!existing.length) {
          roomCode = candidate
          break
        }
      }

      if (!roomCode) {
        return json(500, {
          ok: false,
          error: 'ROOM_CODE_GEN_FAILED'
        })
      }

      const token = newToken()
      const state = JSON.stringify(
        initialState()
      )

      const { rows } = await sql`
        INSERT INTO chess_rooms
        (
          room_code,
          status,
          white_player,
          white_token,
          turn,
          state,
          version
        )
        VALUES (
          ${roomCode},
          'waiting',
          ${player},
          ${token},
          'w',
          ${state}::jsonb,
          0
        )
        RETURNING *
      `

      const row = rows[0]

      return json(200, {
        ...toGamePayload(row),
        token,
        color: 'w',
        room_code: row.room_code
      })
    }

    /*
     * JOIN ROOM
     */
    if (
      request.method === 'POST' &&
      pathname === '/api/chess/join'
    ) {
      let body = {}

      try {
        body = await request.json()
      } catch {}

      const roomCode = cleanRoom(
        body.room ||
        body.roomCode ||
        body.code
      )

      const player = cleanPlayer(
        body.player ||
        body.playerId ||
        body.jid
      )

      if (!roomCode || !player) {
        return json(400, {
          ok: false,
          error: 'ROOM_AND_PLAYER_REQUIRED'
        })
      }

      const { rows: found } = await sql`
        SELECT *
        FROM chess_rooms
        WHERE room_code = ${roomCode}
        LIMIT 1
      `

      const row = found[0]

      if (!row) {
        return json(404, {
          ok: false,
          error: 'ROOM_NOT_FOUND'
        })
      }

      if (row.white_player === player) {
        return json(200, {
          ...toGamePayload(row),
          token: row.white_token,
          color: 'w',
          room_code: row.room_code
        })
      }

      if (row.black_player === player) {
        return json(200, {
          ...toGamePayload(row),
          token: row.black_token,
          color: 'b',
          room_code: row.room_code
        })
      }

      if (row.black_player) {
        return json(409, {
          ok: false,
          error: 'ROOM_FULL'
        })
      }

      await sql`
        INSERT INTO rpg_users (jid)
        VALUES (${player})
        ON CONFLICT (jid) DO NOTHING
      `

      await sql`
        INSERT INTO chess_players (jid)
        VALUES (${player})
        ON CONFLICT (jid) DO NOTHING
      `

      const token = newToken()

      const { rows: updated } = await sql`
        UPDATE chess_rooms
        SET
          black_player = ${player},
          black_token = ${token},
          status = 'playing',
          updated_at = NOW()
        WHERE
          room_code = ${roomCode}
          AND black_player IS NULL
        RETURNING *
      `

      if (!updated.length) {
        const { rows: fresh } = await sql`
          SELECT *
          FROM chess_rooms
          WHERE room_code = ${roomCode}
          LIMIT 1
        `

        if (
          fresh[0]?.black_player === player
        ) {
          return json(200, {
            ...toGamePayload(fresh[0]),
            token: fresh[0].black_token,
            color: 'b',
            room_code: fresh[0].room_code
          })
        }

        return json(409, {
          ok: false,
          error: 'ROOM_FULL'
        })
      }

      const fresh = updated[0]

      return json(200, {
        ...toGamePayload(fresh),
        token,
        color: 'b',
        room_code: fresh.room_code
      })
    }

    /*
     * CHESS STATE / MOVE / RESIGN
     */
    if (
      pathname.startsWith('/api/chess/')
    ) {
      const roomCode = cleanRoom(
        decodeURIComponent(
          pathname.slice(
            '/api/chess/'.length
          )
        )
      )

      if (!roomCode) {
        return json(400, {
          ok: false,
          error: 'INVALID_ROOM_CODE'
        })
      }

      /*
       * GET STATE
       */
      if (request.method === 'GET') {
        const token =
          url.searchParams.get('token') || ''

        const { rows } = await sql`
          SELECT *
          FROM chess_rooms
          WHERE room_code = ${roomCode}
          LIMIT 1
        `

        const row = rows[0]

        if (!row) {
          return json(404, {
            ok: false,
            error: 'ROOM_NOT_FOUND'
          })
        }

        if (!colorFromToken(row, token)) {
          return json(403, {
            ok: false,
            error: 'INVALID_TOKEN'
          })
        }

        return json(
          200,
          toGamePayload(row)
        )
      }

      /*
       * POST MOVE / RESIGN
       */
      if (request.method === 'POST') {
        let body = {}

        try {
          body = await request.json()
        } catch {}

        const { rows } = await sql`
          SELECT *
          FROM chess_rooms
          WHERE room_code = ${roomCode}
          LIMIT 1
        `

        const row = rows[0]

        if (!row) {
          return json(404, {
            ok: false,
            error: 'ROOM_NOT_FOUND'
          })
        }

        const playerColor =
          colorFromToken(
            row,
            body.token
          )

        if (!playerColor) {
          return json(403, {
            ok: false,
            error: 'INVALID_TOKEN'
          })
        }

        /*
         * RESIGN
         */
        if (body.resign === true) {
          if (row.status === 'finished') {
            return json(
              200,
              toGamePayload(row)
            )
          }

          const winnerColor =
            playerColor === 'w'
              ? 'b'
              : 'w'

          const nextVersion =
            Number(row.version) + 1

          const { rows: updated } = await sql`
            UPDATE chess_rooms
            SET
              status = 'finished',
              winner = ${winnerColor},
              result = 'resign',
              version = ${nextVersion},
              updated_at = NOW(),
              finished_at = NOW()
            WHERE
              room_code = ${roomCode}
              AND version = ${row.version}
            RETURNING *
          `

          if (!updated.length) {
            return json(409, {
              ok: false,
              error: 'STALE_VERSION'
            })
          }

          await finalizeMatch(
            sql,
            updated[0],
            winnerColor,
            'resign'
          ).catch(error => {
            console.error(
              '[FINALIZE MATCH ERROR]',
              error
            )
          })

          return json(
            200,
            toGamePayload(updated[0])
          )
        }

        /*
         * MOVE VALIDATION
         */
        if (row.status === 'finished') {
          return json(409, {
            ok: false,
            error: 'GAME_FINISHED'
          })
        }

        if (row.status !== 'playing') {
          return json(409, {
            ok: false,
            error: 'WAITING_FOR_PLAYER'
          })
        }

        if (row.turn !== playerColor) {
          return json(409, {
            ok: false,
            error: 'NOT_YOUR_TURN'
          })
        }

        const clientVersion =
          Number(body.version)

        if (
          Number.isFinite(clientVersion) &&
          clientVersion !== Number(row.version)
        ) {
          return json(409, {
            ok: false,
            error: 'STALE_VERSION'
          })
        }

        const nextTurn =
          playerColor === 'w'
            ? 'b'
            : 'w'

        const nextVersion =
          Number(row.version) + 1

        const finished =
          body.status === 'finished'

        const winner =
          finished &&
          (
            body.winner === 'w' ||
            body.winner === 'b'
          )
            ? body.winner
            : null

        const newState =
          JSON.stringify({
            board:
              body.board ??
              row.state?.board,

            castle:
              body.castle ??
              row.state?.castle,

            enPassant:
              body.enPassant != null
                ? body.enPassant
                : null,

            halfmove:
              Number(
                body.halfmove || 0
              ),

            captured:
              body.captured ??
              row.state?.captured,

            moveCount:
              Number(
                body.moveCount || 0
              )
          })

        const nextStatus =
          finished
            ? 'finished'
            : 'playing'

        const nextResult =
          finished
            ? (
                winner
                  ? 'checkmate'
                  : 'draw'
              )
            : null

        const { rows: updated } = await sql`
          UPDATE chess_rooms
          SET
            turn = ${nextTurn},
            state = ${newState}::jsonb,
            status = ${nextStatus},
            winner = ${winner},
            result = ${nextResult},
            version = ${nextVersion},
            updated_at = NOW(),
            finished_at =
              CASE
                WHEN ${nextStatus} = 'finished'
                  THEN NOW()
                ELSE finished_at
              END
          WHERE
            room_code = ${roomCode}
            AND version = ${row.version}
          RETURNING *
        `

        if (!updated.length) {
          return json(409, {
            ok: false,
            error: 'STALE_VERSION'
          })
        }

        if (finished) {
          await finalizeMatch(
            sql,
            updated[0],
            winner,
            winner
              ? 'checkmate'
              : 'draw'
          ).catch(error => {
            console.error(
              '[FINALIZE MATCH ERROR]',
              error
            )
          })
        }

        return json(
          200,
          toGamePayload(updated[0])
        )
      }

      return json(405, {
        ok: false,
        error: 'METHOD_NOT_ALLOWED'
      })
    }

    return json(404, {
      ok: false,
      error: 'NOT_FOUND'
    })

  } catch (error) {
    console.error(
      '[CHESS PORTAL ERROR]',
      error
    )

    return json(500, {
      ok: false,
      error: 'INTERNAL_SERVER_ERROR'
    })
  }
}
