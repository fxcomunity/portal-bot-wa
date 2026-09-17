import { neon } from '@neondatabase/serverless'

const ADMIN_COOKIE = 'portal_admin'
const SESSION_TTL_SECONDS = 60 * 60 * 8
const MAX_BODY_SIZE = 256 * 1024

function getSql(env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured')
  }

  return neon(env.DATABASE_URL)
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
  const cookieHeader = request.headers.get('Cookie') || ''
  const cookies = {}

  for (const item of cookieHeader.split(';')) {
    const index = item.indexOf('=')

    if (index === -1) continue

    const key = item.slice(0, index).trim()
    const value = item.slice(index + 1).trim()

    cookies[key] = decodeURIComponent(value)
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

async function readJson(request) {
  const contentType = request.headers.get('Content-Type') || ''

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('INVALID_CONTENT_TYPE')
  }

  const text = await readRequestBody(request)

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('INVALID_JSON')
  }
}

async function readForm(request) {
  const contentType = request.headers.get('Content-Type') || ''

  if (
    !contentType.toLowerCase().includes(
      'application/x-www-form-urlencoded'
    )
  ) {
    throw new Error('INVALID_CONTENT_TYPE')
  }

  const text = await readRequestBody(request)

  return new URLSearchParams(text)
}

async function cleanupStaleRooms(sql) {
  try {
    const result = await sql`
      DELETE FROM chess_rooms
      WHERE updated_at < NOW() - INTERVAL '12 hours'
      RETURNING room_code
    `

    return result.length
  } catch (error) {
    console.error('[CLEANUP_ERROR]', error)
    return 0
  }
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
  const cookies = parseCookies(request)
  const rawToken = cookies[ADMIN_COOKIE]

  if (!rawToken || rawToken.length < 20) {
    return null
  }

  const tokenHash = await sha256(rawToken)

  const result = await sql`
    SELECT
      a.id,
      a.username,
      s.id AS session_id
    FROM portal_admin_sessions s
    INNER JOIN portal_admins a
      ON a.id = s.admin_id
    WHERE s.token_hash = ${tokenHash}
      AND s.expires_at > NOW()
      AND a.active = TRUE
    LIMIT 1
  `

  if (!result.length) {
    return null
  }

  return result[0]
}

async function deleteAdminSession(sql, request) {
  const cookies = parseCookies(request)
  const rawToken = cookies[ADMIN_COOKIE]

  if (!rawToken) {
    return
  }

  const tokenHash = await sha256(rawToken)

  await sql`
    DELETE FROM portal_admin_sessions
    WHERE token_hash = ${tokenHash}
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
  const errorHtml = error
    ? `
      <div class="error">
        ${escapeHtml(error)}
      </div>
    `
    : ''

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin Login - JACK Portal</title>

  <style>
    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      min-height: 100%;
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      background:
        radial-gradient(
          circle at top,
          #182033 0,
          #0a0d14 45%,
          #06080d 100%
        );
      color: #f4f7fb;
    }

    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .wrapper {
      width: 100%;
      max-width: 420px;
    }

    .logo {
      display: flex;
      justify-content: center;
      margin-bottom: 24px;
    }

    .logo-mark {
      width: 72px;
      height: 72px;
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        linear-gradient(135deg, #ffffff 0%, #dfe5ef 100%);
      color: #090c12;
      font-size: 26px;
      font-weight: 900;
      letter-spacing: -2px;
      box-shadow:
        0 16px 50px rgba(0, 0, 0, .35);
    }

    .brand {
      text-align: center;
      margin-bottom: 22px;
    }

    .brand h1 {
      margin: 0;
      font-size: 25px;
      letter-spacing: -.7px;
    }

    .brand p {
      margin: 7px 0 0;
      color: #8f99ab;
      font-size: 14px;
    }

    .card {
      background: rgba(14, 18, 27, .92);
      border: 1px solid #222a38;
      border-radius: 20px;
      padding: 26px;
      box-shadow:
        0 24px 80px rgba(0, 0, 0, .45);
      backdrop-filter: blur(14px);
    }

    label {
      display: block;
      margin: 0 0 8px;
      color: #c5ccd8;
      font-size: 13px;
      font-weight: 600;
    }

    input {
      width: 100%;
      border: 1px solid #2a3342;
      outline: none;
      border-radius: 12px;
      background: #090d14;
      color: #fff;
      padding: 13px 14px;
      font-size: 15px;
      transition: .15s ease;
    }

    input:focus {
      border-color: #66748a;
      box-shadow: 0 0 0 3px rgba(148, 163, 184, .08);
    }

    .field {
      margin-bottom: 17px;
    }

    button {
      width: 100%;
      border: 0;
      border-radius: 12px;
      padding: 13px 15px;
      background: #fff;
      color: #090c12;
      font-weight: 800;
      font-size: 14px;
      cursor: pointer;
    }

    button:hover {
      background: #e9edf3;
    }

    .error {
      border: 1px solid #5c2c35;
      background: #251318;
      color: #ffb8c1;
      border-radius: 11px;
      padding: 11px 12px;
      margin-bottom: 17px;
      font-size: 13px;
      line-height: 1.45;
    }

    .footer {
      text-align: center;
      margin-top: 18px;
      color: #667085;
      font-size: 12px;
    }
  </style>
</head>

<body>
  <main class="wrapper">

    <div class="logo">
      <div class="logo-mark">JP</div>
    </div>

    <div class="brand">
      <h1>JACK Portal</h1>
      <p>Administrator access</p>
    </div>

    <section class="card">
      ${errorHtml}

      <form method="POST" action="/admin/login" autocomplete="off">

        <div class="field">
          <label for="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            maxlength="64"
            autocomplete="username"
            required
            autofocus
          >
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            maxlength="128"
            autocomplete="current-password"
            required
          >
        </div>

        <button type="submit">
          Sign in
        </button>

      </form>
    </section>

    <div class="footer">
      JACK Portal Administration
    </div>

  </main>
</body>
</html>`
}

function adminDashboard(admin, rooms, search, deleted = false) {
  const rows = rooms.length
    ? rooms.map(room => `
      <tr>
        <td>
          <strong>${escapeHtml(room.room_code)}</strong>
        </td>

        <td>
          ${escapeHtml(room.white_player || '-')}
        </td>

        <td>
          ${escapeHtml(room.black_player || '-')}
        </td>

        <td>
          ${escapeHtml(room.status || '-')}
        </td>

        <td>
          ${escapeHtml(
            room.updated_at
              ? new Date(room.updated_at).toLocaleString('id-ID')
              : '-'
          )}
        </td>

        <td>
          <form
            method="POST"
            action="/admin/rooms/delete"
            onsubmit="return confirm('Hapus room ini?')"
          >
            <input
              type="hidden"
              name="room_code"
              value="${escapeHtml(room.room_code)}"
            >

            <button class="delete" type="submit">
              Hapus
            </button>
          </form>
        </td>
      </tr>
    `).join('')
    : `
      <tr>
        <td colspan="6" class="empty">
          Tidak ada room ditemukan.
        </td>
      </tr>
    `

  const deletedHtml = deleted
    ? `
      <div class="success">
        Room berhasil dihapus.
      </div>
    `
    : ''

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">

  <title>Admin Dashboard - JACK Portal</title>

  <style>
    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      min-height: 100%;
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      background: #070a10;
      color: #f4f7fb;
    }

    body {
      padding: 24px;
    }

    .container {
      width: 100%;
      max-width: 1250px;
      margin: 0 auto;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 24px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 13px;
    }

    .logo {
      width: 46px;
      height: 46px;
      border-radius: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fff;
      color: #090c12;
      font-size: 16px;
      font-weight: 900;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      letter-spacing: -.5px;
    }

    .sub {
      margin-top: 3px;
      color: #7e8797;
      font-size: 13px;
    }

    .logout {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      color: #c8ced8;
      border: 1px solid #28303d;
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 13px;
    }

    .logout:hover {
      background: #111620;
    }

    .card {
      background: #0d1119;
      border: 1px solid #202836;
      border-radius: 16px;
      overflow: hidden;
    }

    .toolbar {
      display: flex;
      gap: 10px;
      padding: 17px;
      border-bottom: 1px solid #202836;
    }

    .search {
      flex: 1;
      min-width: 0;
      border: 1px solid #293241;
      background: #080c13;
      color: #fff;
      border-radius: 10px;
      outline: none;
      padding: 11px 13px;
      font-size: 14px;
    }

    .search:focus {
      border-color: #66748a;
    }

    .search-btn {
      border: 0;
      border-radius: 10px;
      padding: 0 18px;
      background: #fff;
      color: #080c13;
      font-weight: 800;
      cursor: pointer;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 14px 16px;
      border-bottom: 1px solid #1b222e;
      text-align: left;
      font-size: 13px;
    }

    th {
      color: #7f8999;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .5px;
    }

    td {
      color: #cbd2dd;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    strong {
      color: #fff;
    }

    .delete {
      border: 1px solid #59313a;
      background: #211318;
      color: #ffb8c1;
      border-radius: 8px;
      padding: 8px 11px;
      cursor: pointer;
      font-size: 12px;
    }

    .delete:hover {
      background: #2d171d;
    }

    .empty {
      text-align: center;
      padding: 35px;
      color: #687386;
    }

    .success {
      margin-bottom: 16px;
      padding: 11px 13px;
      border: 1px solid #294634;
      background: #101b14;
      color: #a9dfb7;
      border-radius: 10px;
      font-size: 13px;
    }

    .info {
      margin-top: 14px;
      color: #667085;
      font-size: 12px;
    }

    @media (max-width: 800px) {
      body {
        padding: 14px;
      }

      header {
        align-items: flex-start;
      }

      .toolbar {
        flex-direction: column;
      }

      .search-btn {
        padding: 11px;
      }

      .card {
        overflow-x: auto;
      }

      table {
        min-width: 850px;
      }
    }
  </style>
</head>

<body>

  <main class="container">

    <header>
      <div class="brand">
        <div class="logo">JP</div>

        <div>
          <h1>JACK Portal</h1>
          <div class="sub">
            Logged in as ${escapeHtml(admin.username)}
          </div>
        </div>
      </div>

      <a class="logout" href="/admin/logout">
        Logout
      </a>
    </header>

    ${deletedHtml}

    <section class="card">

      <form
        class="toolbar"
        method="GET"
        action="/admin"
      >
        <input
          class="search"
          type="search"
          name="search"
          value="${escapeHtml(search)}"
          placeholder="Cari room code..."
          maxlength="100"
        >

        <button
          class="search-btn"
          type="submit"
        >
          Cari
        </button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Room</th>
            <th>White</th>
            <th>Black</th>
            <th>Status</th>
            <th>Updated</th>
            <th>Action</th>
          </tr>
        </thead>

        <tbody>
          ${rows}
        </tbody>
      </table>

    </section>

    <div class="info">
      Room yang tidak diperbarui selama lebih dari 12 jam akan dibersihkan otomatis.
    </div>

  </main>

</body>
</html>`
}

async function handleAdminLogin(request, sql) {
  if (request.method === 'GET') {
    return html(adminLoginPage())
  }

  if (request.method !== 'POST') {
    return json(
      {
        ok: false,
        error: 'METHOD_NOT_ALLOWED'
      },
      405
    )
  }

  const form = await readForm(request)

  const username = cleanUsername(form.get('username'))
  const password = String(form.get('password') || '')

  if (!username || !password) {
    return html(
      adminLoginPage('Username dan password wajib diisi.'),
      400
    )
  }

  if (password.length > 128) {
    return html(
      adminLoginPage('Password tidak valid.'),
      400
    )
  }

  const ip = getClientIp(request)

  try {
    const attempts = await sql`
      SELECT
        attempts,
        blocked_until
      FROM portal_login_attempts
      WHERE ip = ${ip}
      LIMIT 1
    `

    if (
      attempts.length &&
      attempts[0].blocked_until &&
      new Date(attempts[0].blocked_until) > new Date()
    ) {
      return html(
        adminLoginPage(
          'Terlalu banyak percobaan login. Coba lagi nanti.'
        ),
        429
      )
    }

    const admins = await sql`
      SELECT
        id,
        username
      FROM portal_admins
      WHERE username = ${username}
        AND active = TRUE
        AND password_hash = crypt(
          ${password},
          password_hash
        )
      LIMIT 1
    `

    if (!admins.length) {
      await sql`
        INSERT INTO portal_login_attempts (
          ip,
          window_started_at,
          attempts,
          blocked_until
        )
        VALUES (
          ${ip},
          NOW(),
          1,
          NULL
        )
        ON CONFLICT (ip)
        DO UPDATE SET
          attempts = CASE
            WHEN portal_login_attempts.window_started_at
              < NOW() - INTERVAL '15 minutes'
            THEN 1
            ELSE portal_login_attempts.attempts + 1
          END,

          window_started_at = CASE
            WHEN portal_login_attempts.window_started_at
              < NOW() - INTERVAL '15 minutes'
            THEN NOW()
            ELSE portal_login_attempts.window_started_at
          END,

          blocked_until = CASE
            WHEN portal_login_attempts.attempts + 1 >= 8
            THEN NOW() + INTERVAL '15 minutes'
            ELSE portal_login_attempts.blocked_until
          END
      `

      return html(
        adminLoginPage('Username atau password salah.'),
        401
      )
    }

    await sql`
      DELETE FROM portal_login_attempts
      WHERE ip = ${ip}
    `

    const token = await createAdminSession(
      sql,
      admins[0].id,
      request
    )

    return new Response(null, {
      status: 303,
      headers: {
        Location: '/admin',
        'Set-Cookie': loginCookie(token),
        ...securityHeaders()
      }
    })
  } catch (error) {
    console.error('[ADMIN_LOGIN_ERROR]', error)

    return html(
      adminLoginPage(
        'Login gagal karena konfigurasi server bermasalah.'
      ),
      500
    )
  }
}

async function handleAdmin(request, sql, url) {
  const admin = await getAdmin(sql, request)

  if (!admin) {
    return redirect('/admin/login')
  }

  const search = cleanSearch(
    url.searchParams.get('search')
  )

  let rooms

  if (search) {
    const pattern = `%${search}%`

    rooms = await sql`
      SELECT
        room_code,
        white_player,
        black_player,
        status,
        updated_at
      FROM chess_rooms
      WHERE room_code ILIKE ${pattern}
         OR COALESCE(white_player, '') ILIKE ${pattern}
         OR COALESCE(black_player, '') ILIKE ${pattern}
      ORDER BY updated_at DESC
      LIMIT 100
    `
  } else {
    rooms = await sql`
      SELECT
        room_code,
        white_player,
        black_player,
        status,
        updated_at
      FROM chess_rooms
      ORDER BY updated_at DESC
      LIMIT 100
    `
  }

  const deleted =
    url.searchParams.get('deleted') === '1'

  return html(
    adminDashboard(
      admin,
      rooms,
      search,
      deleted
    )
  )
}

async function handleAdminDelete(request, sql) {
  const admin = await getAdmin(sql, request)

  if (!admin) {
    return redirect('/admin/login')
  }

  if (request.method !== 'POST') {
    return json(
      {
        ok: false,
        error: 'METHOD_NOT_ALLOWED'
      },
      405
    )
  }

  const form = await readForm(request)

  const roomCode = cleanText(
    form.get('room_code'),
    64
  )

  if (!roomCode) {
    return redirect('/admin')
  }

  await sql`
    DELETE FROM chess_rooms
    WHERE room_code = ${roomCode}
  `

  return redirect('/admin?deleted=1')
}

async function handleAdminLogout(request, sql) {
  try {
    await deleteAdminSession(sql, request)
  } catch (error) {
    console.error('[LOGOUT_ERROR]', error)
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: '/admin/login',
      'Set-Cookie': clearLoginCookie(),
      ...securityHeaders()
    }
  })
}

async function handleHealth(sql) {
  try {
    await sql`SELECT 1 AS ok`

    return json({
      ok: true,
      service: 'jack-portal',
      database: 'connected'
    })
  } catch (error) {
    console.error('[HEALTH_ERROR]', error)

    return json(
      {
        ok: false,
        service: 'jack-portal',
        database: 'error'
      },
      503
    )
  }
}

async function handleStatus(sql) {
  try {
    const result = await sql`
      SELECT
        COUNT(*)::int AS total_rooms
      FROM chess_rooms
    `

    return json({
      ok: true,
      total_rooms: result[0]?.total_rooms || 0
    })
  } catch (error) {
    console.error('[STATUS_ERROR]', error)

    return json(
      {
        ok: false,
        error: 'INTERNAL_SERVER_ERROR'
      },
      500
    )
  }
}

async function handleRooms(sql, url) {
  const search = cleanSearch(
    url.searchParams.get('search')
  )

  if (search) {
    const pattern = `%${search}%`

    const rooms = await sql`
      SELECT
        room_code,
        status,
        updated_at
      FROM chess_rooms
      WHERE room_code ILIKE ${pattern}
      ORDER BY updated_at DESC
      LIMIT 50
    `

    return json({
      ok: true,
      rooms
    })
  }

  const rooms = await sql`
    SELECT
      room_code,
      status,
      updated_at
    FROM chess_rooms
    ORDER BY updated_at DESC
    LIMIT 50
  `

  return json({
    ok: true,
    rooms
  })
}

async function handleLeaderboard(sql) {
  try {
    const result = await sql`
      SELECT *
      FROM chess_leaderboard
      ORDER BY rating DESC
      LIMIT 100
    `

    return json({
      ok: true,
      leaderboard: result
    })
  } catch {
    return json({
      ok: true,
      leaderboard: []
    })
  }
}

function homePage() {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">

  <title>JACK Portal</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: #070a10;
      color: #fff;
      font-family:
        Inter,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    .box {
      text-align: center;
      max-width: 520px;
    }

    .logo {
      width: 80px;
      height: 80px;
      border-radius: 22px;
      margin: 0 auto 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fff;
      color: #080b10;
      font-weight: 900;
      font-size: 27px;
      letter-spacing: -2px;
    }

    h1 {
      margin: 0;
      font-size: 30px;
    }

    p {
      color: #858fa0;
      line-height: 1.6;
    }
  </style>
</head>

<body>
  <main class="box">
    <div class="logo">JP</div>

    <h1>JACK Portal</h1>

    <p>
      Portal service is running normally.
    </p>
  </main>
</body>
</html>`
}

async function router(request, env) {
  const url = new URL(request.url)
  const pathname = normalizePath(request.url)
  const method = request.method.toUpperCase()

  const sql = getSql(env)

  /*
   * HEALTH CHECK
   *
   * Sengaja dijalankan sebelum cleanup.
   * Jadi kalau cleanup/schema chess bermasalah,
   * /health tetap bisa memberi diagnosis database.
   */
  if (pathname === '/health') {
    return handleHealth(sql)
  }

  /*
   * ADMIN ROUTER
   */
  if (pathname === '/admin/login') {
    return handleAdminLogin(request, sql)
  }

  if (pathname === '/admin/logout') {
    return handleAdminLogout(request, sql)
  }

  if (pathname === '/admin') {
    if (method !== 'GET') {
      return json(
        {
          ok: false,
          error: 'METHOD_NOT_ALLOWED'
        },
        405
      )
    }

    return handleAdmin(request, sql, url)
  }

  if (pathname === '/admin/rooms/delete') {
    return handleAdminDelete(request, sql)
  }

  /*
   * CLEANUP
   *
   * Error cleanup tidak boleh membuat API utama
   * menjadi INTERNAL_SERVER_ERROR.
   */
  await cleanupStaleRooms(sql)

  /*
   * PUBLIC ROUTER
   */
  if (pathname === '/') {
    return html(homePage())
  }

  if (pathname === '/api/status') {
    return handleStatus(sql)
  }

  if (pathname === '/rooms') {
    return handleRooms(sql, url)
  }

  if (pathname === '/leaderboard') {
    return handleLeaderboard(sql)
  }

  /*
   * CHESS ROUTER
   *
   * Route chess utama tetap bisa dipasang di bawah sini.
   * Bagian ini sengaja tidak mengarang struktur payload
   * project lama yang belum terlihat di file terbaru.
   */

  if (
    pathname === '/api/chess/create' ||
    pathname === '/api/chess/join' ||
    pathname.startsWith('/api/chess/')
  ) {
    return json(
      {
        ok: false,
        error: 'CHESS_ROUTE_NOT_CONFIGURED'
      },
      501
    )
  }

  return json(
    {
      ok: false,
      error: 'NOT_FOUND'
    },
    404
  )
}

export async function onRequest(context) {
  try {
    return await router(
      context.request,
      context.env
    )
  } catch (error) {
    console.error('[PORTAL_ERROR]', error)

    if (error?.message === 'BODY_TOO_LARGE') {
      return json(
        {
          ok: false,
          error: 'BODY_TOO_LARGE'
        },
        413
      )
    }

    if (error?.message === 'INVALID_JSON') {
      return json(
        {
          ok: false,
          error: 'INVALID_JSON'
        },
        400
      )
    }

    if (error?.message === 'INVALID_CONTENT_TYPE') {
      return json(
        {
          ok: false,
          error: 'INVALID_CONTENT_TYPE'
        },
        415
      )
    }

    return json(
      {
        ok: false,
        error: 'INTERNAL_SERVER_ERROR'
      },
      500
    )
  }
}
