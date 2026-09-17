import { neon } from '@neondatabase/serverless'

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_TTL_HOURS = 12
const ADMIN_SESSION_HOURS = 8
const MAX_BODY_BYTES = 256 * 1024
const MAX_ADMIN_LOGIN_ATTEMPTS = 8
const LOGIN_WINDOW_MINUTES = 15

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self' 'unsafe-inline'",
    'Strict-Transport-Security':
      'max-age=31536000; includeSubDomains',
    ...extra
  }
}

function corsHeaders(extra = {}) {
  return {
    ...securityHeaders(),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra
  }
}

function json(status, data, options = {}) {
  const headers = corsHeaders({
    'Content-Type': 'application/json; charset=utf-8'
  })

  if (!options.admin) {
    headers['Access-Control-Allow-Origin'] = '*'
  }

  return new Response(JSON.stringify(data), {
    status,
    headers
  })
}

function html(status, body, options = {}) {
  const headers = securityHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': options.admin ? 'no-store' : 'no-cache'
  })

  if (!options.admin) {
    headers['Access-Control-Allow-Origin'] = '*'
  }

  if (options.cookie) {
    headers['Set-Cookie'] = options.cookie
  }

  return new Response(body, {
    status,
    headers
  })
}

function redirect(location, cookie = '') {
  const headers = securityHeaders({
    Location: location,
    'Cache-Control': 'no-store'
  })

  if (cookie) {
    headers['Set-Cookie'] = cookie
  }

  return new Response(null, {
    status: 303,
    headers
  })
}

function cleanPlayer(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 100)

  return /^[A-Za-z0-9._:@+\- ]+$/.test(text) ? text : ''
}

function cleanRoom(value) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase()
    .slice(0, 20)

  return /^[A-Z2-9]+$/.test(text) ? text : ''
}

function cleanSearch(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32)
}

function newToken(bytesLength = 32) {
  const bytes = crypto.getRandomValues(
    new Uint8Array(bytesLength)
  )

  return Array.from(
    bytes,
    b => b.toString(16).padStart(2, '0')
  ).join('')
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value)

  const digest = await crypto.subtle.digest(
    'SHA-256',
    data
  )

  return Array.from(
    new Uint8Array(digest),
    b => b.toString(16).padStart(2, '0')
  ).join('')
}

function makeRoomCode() {
  const bytes = crypto.getRandomValues(
    new Uint8Array(8)
  )

  let out = ''

  for (let i = 0; i < 8; i++) {
    out += ROOM_CODE_CHARS[
      bytes[i] % ROOM_CODE_CHARS.length
    ]
  }

  return out
}

function initialBoard() {
  const back = [
    'r',
    'n',
    'b',
    'q',
    'k',
    'b',
    'n',
    'r'
  ]

  const board = Array.from(
    { length: 8 },
    () => Array(8).fill(null)
  )

  for (let c = 0; c < 8; c++) {
    board[0][c] = {
      color: 'b',
      type: back[c]
    }

    board[1][c] = {
      color: 'b',
      type: 'p'
    }

    board[6][c] = {
      color: 'w',
      type: 'p'
    }

    board[7][c] = {
      color: 'w',
      type: back[c]
    }
  }

  return board
}

function initialState() {
  return {
    board: initialBoard(),
    castle: {
      w: {
        k: true,
        q: true
      },
      b: {
        k: true,
        q: true
      }
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
    .replace(/'/g, '&#39;')
}

function escapeAttr(value) {
  return escapeHtml(value)
    .replace(/`/g, '&#96;')
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
  const diff = Math.max(
    0,
    Date.now() - new Date(iso).getTime()
  )

  const sec = Math.floor(diff / 1000)

  if (sec < 60) {
    return `${sec}d lalu`
  }

  const min = Math.floor(sec / 60)

  if (min < 60) {
    return `${min}m lalu`
  }

  const hr = Math.floor(min / 60)

  if (hr < 24) {
    return `${hr}j lalu`
  }

  return `${Math.floor(hr / 24)}h lalu`
}

function pageShell(title, body, admin = false) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${admin ? '' : '<meta http-equiv="refresh" content="10">'}
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{
margin:0;
font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
background:#0d0f12;
color:#eef0f2;
padding:24px
}
a{color:#9aa7ff}
button,input{font:inherit}
button,.btn{
border:0;
border-radius:10px;
padding:10px 14px;
background:#e8eaed;
color:#111;
text-decoration:none;
font-weight:600;
cursor:pointer
}
.btn.danger,button.danger{
background:#d9534f;
color:#fff
}
.wrap{
max-width:980px;
margin:0 auto
}
.top{
display:flex;
gap:12px;
align-items:center;
justify-content:space-between;
flex-wrap:wrap;
margin-bottom:20px
}
.muted{
color:#9299a1;
font-size:13px
}
.card{
background:#15181c;
border:1px solid #252a30;
border-radius:14px;
padding:18px;
margin-bottom:16px
}
table{
width:100%;
border-collapse:collapse
}
th,td{
padding:11px 8px;
border-bottom:1px solid #252a30;
text-align:left;
vertical-align:middle
}
th{
font-size:12px;
color:#9299a1;
text-transform:uppercase
}
code{
background:#20242a;
border-radius:6px;
padding:3px 6px
}
.badge{
display:inline-block;
border-radius:999px;
padding:3px 8px;
font-size:12px
}
.playing{
background:#163321;
color:#8be8a8
}
.waiting{
background:#3b3216;
color:#f3d77b
}
.danger-text{
color:#ff8c88
}
.grid{
display:grid;
grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
gap:12px
}
.stat strong{
display:block;
font-size:24px
}
.form{
display:flex;
gap:8px;
flex-wrap:wrap
}
.form input{
min-width:0;
flex:1;
background:#0e1114;
border:1px solid #30363d;
border-radius:10px;
color:#fff;
padding:10px
}
.center{
max-width:420px;
margin:8vh auto
}
.error{
background:#3a1717;
color:#ffb3b0;
padding:10px;
border-radius:10px;
margin-bottom:12px
}
.ok{
background:#163321;
color:#a6edbb;
padding:10px;
border-radius:10px;
margin-bottom:12px
}
.small{
font-size:12px
}
.actions{
display:flex;
gap:6px;
flex-wrap:wrap
}
.nowrap{
white-space:nowrap
}
@media(max-width:700px){
body{padding:14px}
table{font-size:13px}
.hide-mobile{display:none}
}
</style>
</head>
<body>
<div class="wrap">${body}</div>
</body>
</html>`
}

function renderPortalHome() {
  return pageShell(
    'Jack Portal',
    `
<div class="center">
<div class="card">
<h1>Jack Portal</h1>
<p class="muted">
Portal informasi game WhatsApp Bot.
</p>

<div class="actions" style="margin-top:18px">
<a class="btn" href="/rooms">Room Aktif</a>
<a class="btn" href="/leaderboard">Leaderboard</a>
</div>

<p class="muted small" style="margin-top:18px">
Game dimainkan melalui WhatsApp.
Portal ini hanya menangani data dan sinkronisasi.
</p>
</div>
</div>
`
  )
}

function renderRoomsPage(rows, search = '') {
  const items = rows.map(r => {
    const badge =
      r.status === 'playing'
        ? '<span class="badge playing">Main</span>'
        : '<span class="badge waiting">Menunggu</span>'

    return `<tr>
<td><code>${escapeHtml(r.room_code)}</code></td>
<td>${badge}</td>
<td>${escapeHtml(r.white_player || '-')}</td>
<td>${escapeHtml(r.black_player || 'menunggu')}</td>
<td>${r.turn === 'w' ? 'White' : 'Black'}</td>
<td class="nowrap">${escapeHtml(timeAgo(r.updated_at))}</td>
</tr>`
  }).join('')

  return pageShell(
    'Room Aktif - Jack Portal',
    `
<div class="top">
<div>
<h1>Room Aktif</h1>
<div class="muted">
Room yang tidak diperbarui selama 12 jam
akan dibersihkan otomatis.
</div>
</div>
<a href="/">Kembali</a>
</div>

<div class="card">
<form class="form" method="GET" action="/rooms">
<input
name="q"
maxlength="32"
value="${escapeAttr(search)}"
placeholder="Cari kode room atau pemain"
autocomplete="off">
<button type="submit">Cari</button>
</form>
</div>

<div class="card">
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
    : '<div class="muted">Tidak ada room yang sesuai.</div>'
}
</div>
`
  )
}

function renderLeaderboardPage(rows) {
  const items = rows.map(r => {
    return `<tr>
<td>${Number(r.position)}</td>
<td>${escapeHtml(r.jid)}</td>
<td>${Number(r.rating)}</td>
<td>${Number(r.wins)}</td>
<td>${Number(r.losses)}</td>
<td>${Number(r.draws)}</td>
<td>${Number(r.games)}</td>
</tr>`
  }).join('')

  return pageShell(
    'Leaderboard - Jack Portal',
    `
<div class="top">
<div>
<h1>Chess Leaderboard</h1>
<div class="muted">Statistik pemain.</div>
</div>
<a href="/">Kembali</a>
</div>

<div class="card">
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
    : '<div class="muted">Belum ada game yang selesai.</div>'
}
</div>
`
  )
}

function renderAdminLogin(error = '') {
  return pageShell(
    'Admin Login - Jack Portal',
    `
<div class="center">
<div class="card">
<h1>Admin Login</h1>
<p class="muted">Masuk untuk mengelola room.</p>

${
  error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : ''
}

<form method="POST" action="/admin/login">

<label class="small">Username</label>

<input
name="username"
maxlength="64"
autocomplete="username"
required
style="width:100%;margin:6px 0 12px;background:#0e1114;border:1px solid #30363d;border-radius:10px;color:#fff;padding:10px">

<label class="small">Password</label>

<input
type="password"
name="password"
maxlength="256"
autocomplete="current-password"
required
style="width:100%;margin:6px 0 16px;background:#0e1114;border:1px solid #30363d;border-radius:10px;color:#fff;padding:10px">

<button type="submit">Masuk</button>

</form>
</div>
</div>
`,
    true
  )
}

function renderAdminDashboard(
  stats,
  rooms,
  search = '',
  message = ''
) {
  const items = rooms.map(r => {
    const badge =
      r.status === 'playing'
        ? '<span class="badge playing">Main</span>'
        : '<span class="badge waiting">Menunggu</span>'

    return `<tr>
<td><code>${escapeHtml(r.room_code)}</code></td>
<td>${badge}</td>
<td>${escapeHtml(r.white_player || '-')}</td>
<td>${escapeHtml(r.black_player || '-')}</td>
<td>${escapeHtml(timeAgo(r.updated_at))}</td>
<td>
<form method="POST" action="/admin/rooms/delete">
<input
type="hidden"
name="room"
value="${escapeAttr(r.room_code)}">
<button class="danger" type="submit">
Hapus
</button>
</form>
</td>
</tr>`
  }).join('')

  return pageShell(
    'Admin Dashboard - Jack Portal',
    `
<div class="top">
<div>
<h1>Admin Dashboard</h1>
<div class="muted">
Kontrol room dan pembersihan data.
</div>
</div>

<form method="POST" action="/admin/logout">
<button type="submit">Keluar</button>
</form>
</div>

${
  message
    ? `<div class="ok">${escapeHtml(message)}</div>`
    : ''
}

<div class="grid">

<div class="card stat">
<span class="muted">Room aktif</span>
<strong>${Number(stats.active)}</strong>
</div>

<div class="card stat">
<span class="muted">Room waiting</span>
<strong>${Number(stats.waiting)}</strong>
</div>

<div class="card stat">
<span class="muted">Room playing</span>
<strong>${Number(stats.playing)}</strong>
</div>

<div class="card stat">
<span class="muted">Room lebih dari 12 jam</span>
<strong>${Number(stats.stale)}</strong>
</div>

</div>

<div class="card">
<form class="form" method="GET" action="/admin">

<input
name="q"
maxlength="32"
value="${escapeAttr(search)}"
placeholder="Cari kode room atau pemain"
autocomplete="off">

<button type="submit">Cari</button>

</form>
</div>

<div class="card">

<div class="top">
<h2 style="margin:0">Room</h2>

<span class="muted">
Penghapusan manual langsung permanen.
</span>
</div>

${
  rooms.length
    ? `<table>
<thead>
<tr>
<th>Kode</th>
<th>Status</th>
<th>White</th>
<th>Black</th>
<th>Update</th>
<th>Aksi</th>
</tr>
</thead>
<tbody>${items}</tbody>
</table>`
    : '<div class="muted">Tidak ada room.</div>'
}

</div>

<div class="card">
<p class="muted small">
Pembersihan otomatis dilakukan saat ada request
ke portal. Untuk cleanup yang tetap berjalan
tanpa traffic, gunakan pg_cron jika tersedia.
</p>
</div>
`,
    true
  )
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
    VALUES
    (
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
      const jid of [
        row.white_player,
        row.black_player
      ].filter(Boolean)
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

async function cleanupStaleRooms(sql) {
  const { rows } = await sql`
    DELETE FROM chess_rooms
    WHERE updated_at <
      NOW() - INTERVAL '12 hours'
    RETURNING room_code
  `

  return rows.length
}

async function requireAdmin(sql, request) {
  const cookie =
    request.headers.get('Cookie') || ''

  const match = cookie.match(
    /(?:^|;\s*)portal_admin=([^;]+)/
  )

  if (!match) return null

  let token

  try {
    token = decodeURIComponent(match[1])
  } catch {
    return null
  }

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return null
  }

  const tokenHash =
    await sha256Hex(token)

  const { rows } = await sql`
    SELECT
      s.id,
      s.admin_id,
      a.username
    FROM portal_admin_sessions s
    JOIN portal_admins a
      ON a.id = s.admin_id
    WHERE
      s.token_hash = ${tokenHash}
      AND s.expires_at > NOW()
      AND a.active = TRUE
    LIMIT 1
  `

  return rows[0] || null
}

async function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  )
    .split(',')[0]
    .trim()
    .slice(0, 80)
}

async function isLoginBlocked(sql, ip) {
  const { rows } = await sql`
    SELECT blocked_until
    FROM portal_login_attempts
    WHERE ip = ${ip}
    LIMIT 1
  `

  return (
    rows[0]?.blocked_until &&
    new Date(
      rows[0].blocked_until
    ).getTime() > Date.now()
  )
}

async function recordLoginFailure(sql, ip) {
  await sql`
    INSERT INTO portal_login_attempts
    (
      ip,
      window_started_at,
      attempts,
      blocked_until
    )
    VALUES
    (
      ${ip},
      NOW(),
      1,
      NULL
    )
    ON CONFLICT (ip)
    DO UPDATE SET
      attempts =
        CASE
          WHEN
            portal_login_attempts.window_started_at
              < NOW() - INTERVAL '15 minutes'
          THEN 1
          ELSE
            portal_login_attempts.attempts + 1
        END,

      window_started_at =
        CASE
          WHEN
            portal_login_attempts.window_started_at
              < NOW() - INTERVAL '15 minutes'
          THEN NOW()
          ELSE
            portal_login_attempts.window_started_at
        END,

      blocked_until =
        CASE
          WHEN
            portal_login_attempts.window_started_at
              >= NOW() - INTERVAL '15 minutes'
            AND
            portal_login_attempts.attempts + 1
              >= ${MAX_ADMIN_LOGIN_ATTEMPTS}
          THEN
            NOW() + INTERVAL '15 minutes'
          ELSE NULL
        END
  `
}

async function resetLoginAttempts(sql, ip) {
  await sql`
    DELETE FROM portal_login_attempts
    WHERE ip = ${ip}
  `
}

async function parseJsonBody(request) {
  const length = Number(
    request.headers.get('content-length') || 0
  )

  if (length > MAX_BODY_BYTES) {
    throw new Error('REQUEST_TOO_LARGE')
  }

  const type =
    request.headers.get('content-type') || ''

  if (
    !type
      .toLowerCase()
      .includes('application/json')
  ) {
    throw new Error('INVALID_CONTENT_TYPE')
  }

  return request.json()
}

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders({
        'Access-Control-Allow-Origin': '*'
      })
    })
  }

  const connectionString =
    env.CHESS_DATABASE_URL ||
    env.DATABASE_URL ||
    ''

  if (!connectionString) {
    return json(500, {
      ok: false,
      error:
        'CHESS_DATABASE_URL belum diset di environment variables'
    })
  }

  const sql = neon(connectionString)
  const url = new URL(request.url)
  const pathname = url.pathname

  try {
    await cleanupStaleRooms(sql)

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

    if (
      pathname === '/rooms' ||
      pathname === '/api/rooms'
    ) {
      const search =
        cleanSearch(
          url.searchParams.get('q')
        )

      const pattern =
        `%${search.replace(
          /[%_\\]/g,
          '\\$&'
        )}%`

      const { rows } = search
        ? await sql`
            SELECT
              room_code,
              status,
              white_player,
              black_player,
              turn,
              updated_at
            FROM chess_rooms
            WHERE
              status IN ('waiting', 'playing')
              AND (
                room_code ILIKE ${pattern}
                  ESCAPE '\\'
                OR
                COALESCE(
                  white_player,
                  ''
                ) ILIKE ${pattern}
                  ESCAPE '\\'
                OR
                COALESCE(
                  black_player,
                  ''
                ) ILIKE ${pattern}
                  ESCAPE '\\'
              )
            ORDER BY updated_at DESC
            LIMIT 50
          `
        : await sql`
            SELECT
              room_code,
              status,
              white_player,
              black_player,
              turn,
              updated_at
            FROM chess_rooms
            WHERE
              status IN ('waiting', 'playing')
            ORDER BY updated_at DESC
            LIMIT 50
          `

      return pathname === '/rooms'
        ? html(
            200,
            renderRoomsPage(
              rows,
              search
            )
          )
        : json(200, {
            ok: true,
            rooms: rows
          })
    }

    if (
      pathname === '/admin/login'
    ) {
      if (request.method === 'GET') {
        return html(
          200,
          renderAdminLogin(),
          { admin: true }
        )
      }

      if (request.method !== 'POST') {
        return json(
          405,
          {
            ok: false,
            error: 'METHOD_NOT_ALLOWED'
          },
          { admin: true }
        )
      }

      const ip =
        await getClientIp(request)

      if (
        await isLoginBlocked(
          sql,
          ip
        )
      ) {
        return html(
          429,
          renderAdminLogin(
            'Terlalu banyak percobaan. Coba lagi dalam beberapa menit.'
          ),
          { admin: true }
        )
      }

      const form =
        await request.formData()

      const username =
        String(
          form.get('username') || ''
        )
          .trim()
          .slice(0, 64)

      const password =
        String(
          form.get('password') || ''
        )

      if (
        !/^[A-Za-z0-9_.-]{3,64}$/.test(
          username
        ) ||
        password.length < 12 ||
        password.length > 256
      ) {
        await recordLoginFailure(
          sql,
          ip
        )

        return html(
          401,
          renderAdminLogin(
            'Username atau password salah.'
          ),
          { admin: true }
        )
      }

      const { rows } = await sql`
        SELECT id, username
        FROM portal_admins
        WHERE
          username = ${username}
          AND active = TRUE
        LIMIT 1
      `

      if (!rows.length) {
        await recordLoginFailure(
          sql,
          ip
        )

        return html(
          401,
          renderAdminLogin(
            'Username atau password salah.'
          ),
          { admin: true }
        )
      }

      const { rows: verify } =
        await sql`
          SELECT id
          FROM portal_admins
          WHERE
            id = ${rows[0].id}
            AND password_hash =
              crypt(
                ${password},
                password_hash
              )
          LIMIT 1
        `

      if (!verify.length) {
        await recordLoginFailure(
          sql,
          ip
        )

        return html(
          401,
          renderAdminLogin(
            'Username atau password salah.'
          ),
          { admin: true }
        )
      }

      await resetLoginAttempts(
        sql,
        ip
      )

      const token =
        newToken(32)

      const tokenHash =
        await sha256Hex(token)

      await sql`
        INSERT INTO portal_admin_sessions
        (
          admin_id,
          token_hash,
          expires_at,
          ip_address,
          user_agent
        )
        VALUES
        (
          ${rows[0].id},
          ${tokenHash},
          NOW() + INTERVAL '8 hours',
          ${ip},
          ${request.headers.get(
            'User-Agent'
          ) || ''}
        )
      `

      const cookie =
        `portal_admin=${encodeURIComponent(token)}; Max-Age=${ADMIN_SESSION_HOURS * 3600}; Path=/; HttpOnly; Secure; SameSite=Strict`

      return redirect(
        '/admin',
        cookie
      )
    }

    if (
      pathname === '/admin/logout'
    ) {
      if (request.method !== 'POST') {
        return json(
          405,
          {
            ok: false,
            error: 'METHOD_NOT_ALLOWED'
          },
          { admin: true }
        )
      }

      const admin =
        await requireAdmin(
          sql,
          request
        )

      if (admin) {
        const cookieHeader =
          request.headers.get(
            'Cookie'
          ) || ''

        const match =
          cookieHeader.match(
            /(?:^|;\s*)portal_admin=([^;]+)/
          )

        if (match) {
          let token

          try {
            token =
              decodeURIComponent(
                match[1]
              )
          } catch {
            token = null
          }

          if (token) {
            await sql`
              DELETE FROM portal_admin_sessions
              WHERE token_hash =
                ${await sha256Hex(token)}
            `
          }
        }
      }

      return redirect(
        '/admin/login',
        'portal_admin=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict'
      )
    }

    if (
      pathname === '/admin' ||
      pathname === '/admin/'
    ) {
      const admin =
        await requireAdmin(
          sql,
          request
        )

      if (!admin) {
        return redirect(
          '/admin/login'
        )
      }

      const search =
        cleanSearch(
          url.searchParams.get('q')
        )

      const pattern =
        `%${search.replace(
          /[%_\\]/g,
          '\\$&'
        )}%`

      const { rows: statsRows } =
        await sql`
          SELECT
            COUNT(*) FILTER (
              WHERE status IN (
                'waiting',
                'playing'
              )
            ) AS active,

            COUNT(*) FILTER (
              WHERE status = 'waiting'
            ) AS waiting,

            COUNT(*) FILTER (
              WHERE status = 'playing'
            ) AS playing,

            COUNT(*) FILTER (
              WHERE
                status IN (
                  'waiting',
                  'playing'
                )
                AND updated_at <
                  NOW() - INTERVAL '12 hours'
            ) AS stale

          FROM chess_rooms
        `

      const { rows: rooms } =
        search
          ? await sql`
              SELECT
                room_code,
                status,
                white_player,
                black_player,
                updated_at
              FROM chess_rooms
              WHERE
                room_code ILIKE ${pattern}
                  ESCAPE '\\'
                OR
                COALESCE(
                  white_player,
                  ''
                ) ILIKE ${pattern}
                  ESCAPE '\\'
                OR
                COALESCE(
                  black_player,
                  ''
                ) ILIKE ${pattern}
                  ESCAPE '\\'
              ORDER BY updated_at DESC
              LIMIT 100
            `
          : await sql`
              SELECT
                room_code,
                status,
                white_player,
                black_player,
                updated_at
              FROM chess_rooms
              ORDER BY updated_at DESC
              LIMIT 100
            `

      return html(
        200,
        renderAdminDashboard(
          statsRows[0],
          rooms,
          search,
          url.searchParams.get('msg') || ''
        ),
        { admin: true }
      )
    }

    if (
      pathname ===
      '/admin/rooms/delete'
    ) {
      const admin =
        await requireAdmin(
          sql,
          request
        )

      if (!admin) {
        return redirect(
          '/admin/login'
        )
      }

      if (request.method !== 'POST') {
        return json(
          405,
          {
            ok: false,
            error: 'METHOD_NOT_ALLOWED'
          },
          { admin: true }
        )
      }

      const form =
        await request.formData()

      const roomCode =
        cleanRoom(
          form.get('room')
        )

      if (!roomCode) {
        return redirect(
          '/admin?msg=Kode%20room%20tidak%20valid'
        )
      }

      const { rows } = await sql`
        DELETE FROM chess_rooms
        WHERE room_code = ${roomCode}
        RETURNING room_code
      `

      return redirect(
        `/admin?msg=${encodeURIComponent(
          rows.length
            ? `Room ${roomCode} dihapus.`
            : 'Room tidak ditemukan.'
        )}`
      )
    }

    if (
      request.method === 'POST' &&
      pathname === '/api/chess/create'
    ) {
      let body

      try {
        body =
          await parseJsonBody(
            request
          )
      } catch (e) {
        return json(400, {
          ok: false,
          error:
            e.message ===
            'REQUEST_TOO_LARGE'
              ? e.message
              : 'INVALID_JSON'
        })
      }

      const player =
        cleanPlayer(
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
        ON CONFLICT (jid)
        DO NOTHING
      `

      await sql`
        INSERT INTO chess_players (jid)
        VALUES (${player})
        ON CONFLICT (jid)
        DO NOTHING
      `

      let roomCode = null

      for (let i = 0; i < 10; i++) {
        const candidate =
          makeRoomCode()

        const { rows: existing } =
          await sql`
            SELECT 1
            FROM chess_rooms
            WHERE room_code = ${candidate}
            LIMIT 1
          `

        if (!existing.length) {
          roomCode =
            candidate
          break
        }
      }

      if (!roomCode) {
        return json(500, {
          ok: false,
          error:
            'ROOM_CODE_GEN_FAILED'
        })
      }

      const token =
        newToken(20)

      const { rows } =
        await sql`
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
          VALUES
          (
            ${roomCode},
            'waiting',
            ${player},
            ${token},
            'w',
            ${JSON.stringify(
              initialState()
            )}::jsonb,
            0
          )
          RETURNING *
        `

      const row =
        rows[0]

      return json(200, {
        ...toGamePayload(row),
        token,
        color: 'w',
        room_code:
          row.room_code
      })
    }

    if (
      request.method === 'POST' &&
      pathname === '/api/chess/join'
    ) {
      let body

      try {
        body =
          await parseJsonBody(
            request
          )
      } catch (e) {
        return json(400, {
          ok: false,
          error:
            e.message ===
            'REQUEST_TOO_LARGE'
              ? e.message
              : 'INVALID_JSON'
        })
      }

      const roomCode =
        cleanRoom(
          body.room ||
          body.roomCode ||
          body.code
        )

      const player =
        cleanPlayer(
          body.player ||
          body.playerId ||
          body.jid
        )

      if (
        !roomCode ||
        !player
      ) {
        return json(400, {
          ok: false,
          error:
            'ROOM_AND_PLAYER_REQUIRED'
        })
      }

      const { rows: found } =
        await sql`
          SELECT *
          FROM chess_rooms
          WHERE room_code = ${roomCode}
          LIMIT 1
        `

      const row =
        found[0]

      if (!row) {
        return json(404, {
          ok: false,
          error:
            'ROOM_NOT_FOUND'
        })
      }

      if (
        row.white_player ===
        player
      ) {
        return json(200, {
          ...toGamePayload(row),
          token:
            row.white_token,
          color: 'w',
          room_code:
            row.room_code
        })
      }

      if (
        row.black_player ===
        player
      ) {
        return json(200, {
          ...toGamePayload(row),
          token:
            row.black_token,
          color: 'b',
          room_code:
            row.room_code
        })
      }

      if (row.black_player) {
        return json(409, {
          ok: false,
          error:
            'ROOM_FULL'
        })
      }

      await sql`
        INSERT INTO rpg_users (jid)
        VALUES (${player})
        ON CONFLICT (jid)
        DO NOTHING
      `

      await sql`
        INSERT INTO chess_players (jid)
        VALUES (${player})
        ON CONFLICT (jid)
        DO NOTHING
      `

      const token =
        newToken(20)

      const { rows: updated } =
        await sql`
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
        const { rows: fresh } =
          await sql`
            SELECT *
            FROM chess_rooms
            WHERE room_code = ${roomCode}
            LIMIT 1
          `

        if (
          fresh[0]?.black_player ===
          player
        ) {
          return json(200, {
            ...toGamePayload(
              fresh[0]
            ),
            token:
              fresh[0].black_token,
            color: 'b',
            room_code:
              fresh[0].room_code
          })
        }

        return json(409, {
          ok: false,
          error:
            'ROOM_FULL'
        })
      }

      return json(200, {
        ...toGamePayload(
          updated[0]
        ),
        token,
        color: 'b',
        room_code:
          updated[0].room_code
      })
    }

    if (
      pathname.startsWith(
        '/api/chess/'
      )
    ) {
      const roomCode =
        cleanRoom(
          decodeURIComponent(
            pathname.slice(
              '/api/chess/'.length
            )
          )
        )

      if (!roomCode) {
        return json(400, {
          ok: false,
          error:
            'INVALID_ROOM_CODE'
        })
      }

      if (
        request.method === 'GET'
      ) {
        const token =
          url.searchParams.get(
            'token'
          ) || ''

        const { rows } =
          await sql`
            SELECT *
            FROM chess_rooms
            WHERE room_code = ${roomCode}
            LIMIT 1
          `

        const row =
          rows[0]

        if (!row) {
          return json(404, {
            ok: false,
            error:
              'ROOM_NOT_FOUND'
          })
        }

        if (
          !colorFromToken(
            row,
            token
          )
        ) {
          return json(403, {
            ok: false,
            error:
              'INVALID_TOKEN'
          })
        }

        return json(
          200,
          toGamePayload(row)
        )
      }

      if (
        request.method === 'POST'
      ) {
        let body

        try {
          body =
            await parseJsonBody(
              request
            )
        } catch (e) {
          return json(400, {
            ok: false,
            error:
              e.message ===
              'REQUEST_TOO_LARGE'
                ? e.message
                : 'INVALID_JSON'
          })
        }

        const { rows } =
          await sql`
            SELECT *
            FROM chess_rooms
            WHERE room_code = ${roomCode}
            LIMIT 1
          `

        const row =
          rows[0]

        if (!row) {
          return json(404, {
            ok: false,
            error:
              'ROOM_NOT_FOUND'
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
            error:
              'INVALID_TOKEN'
          })
        }

        if (
          body.resign === true
        ) {
          if (
            row.status ===
            'finished'
          ) {
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
            Number(row.version) +
            1

          const { rows: updated } =
            await sql`
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
              error:
                'STALE_VERSION'
            })
          }

          await finalizeMatch(
            sql,
            updated[0],
            winnerColor,
            'resign'
          ).catch(() => {})

          return json(
            200,
            toGamePayload(
              updated[0]
            )
          )
        }

        if (
          row.status ===
          'finished'
        ) {
          return json(409, {
            ok: false,
            error:
              'GAME_FINISHED'
          })
        }

        if (
          row.status !==
          'playing'
        ) {
          return json(409, {
            ok: false,
            error:
              'WAITING_FOR_PLAYER'
          })
        }

        if (
          row.turn !==
          playerColor
        ) {
          return json(409, {
            ok: false,
            error:
              'NOT_YOUR_TURN'
          })
        }

        const clientVersion =
          Number(
            body.version
          )

        if (
          Number.isFinite(
            clientVersion
          ) &&
          clientVersion !==
            Number(row.version)
        ) {
          return json(409, {
            ok: false,
            error:
              'STALE_VERSION'
          })
        }

        const nextTurn =
          playerColor === 'w'
            ? 'b'
            : 'w'

        const nextVersion =
          Number(row.version) +
          1

        const finished =
          body.status ===
          'finished'

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
            ? winner
              ? 'checkmate'
              : 'draw'
            : null

        const { rows: updated } =
          await sql`
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
            error:
              'STALE_VERSION'
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
          ).catch(() => {})
        }

        return json(
          200,
          toGamePayload(
            updated[0]
          )
        )
      }

      return json(405, {
        ok: false,
        error:
          'METHOD_NOT_ALLOWED'
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

    const safe =
      error?.message ===
      'REQUEST_TOO_LARGE'
        ? 'REQUEST_TOO_LARGE'
        : 'INTERNAL_SERVER_ERROR'

    return json(500, {
      ok: false,
      error: safe
    })
  }
}
