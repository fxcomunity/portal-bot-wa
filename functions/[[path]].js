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
      DELETE FROM chess_rooms
      WHERE updated_at < NOW() - INTERVAL '12 hours'
    `
  } catch (error) {
    console.error('[CLEANUP_ERROR]', error)
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
      FROM chess_leaderboard
      ORDER BY rating DESC
      LIMIT 10
    `
    leaderboard = result
  } catch {}

  try {
    const result = await sql`
      SELECT *
      FROM chess_matches
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
      FROM chess_rooms
      WHERE room_code ILIKE ${pattern}
         OR COALESCE(white_player,'') ILIKE ${pattern}
         OR COALESCE(black_player,'') ILIKE ${pattern}
      ORDER BY updated_at DESC
      LIMIT 100
    `
  } else {
    rooms = await sql`
      SELECT room_code,white_player,black_player,status,updated_at
      FROM chess_rooms
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
      DELETE FROM chess_rooms
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
    const result = await sql`
      SELECT COUNT(*)::int AS total_rooms
      FROM chess_rooms
    `

    return json({
      ok:true,
      total_rooms:result[0]?.total_rooms || 0
    })
  } catch(error) {
    console.error('[STATUS_ERROR]',error)
    return json({ok:false,error:'INTERNAL_SERVER_ERROR'},500)
  }
}

async function handleRooms(sql,url) {
  const search = cleanSearch(url.searchParams.get('search'))

  if (search) {
    const pattern = `%${search}%`

    const rooms = await sql`
      SELECT room_code,status,updated_at
      FROM chess_rooms
      WHERE room_code ILIKE ${pattern}
      ORDER BY updated_at DESC
      LIMIT 50
    `

    return json({ok:true,rooms})
  }

  const rooms = await sql`
    SELECT room_code,status,updated_at
    FROM chess_rooms
    ORDER BY updated_at DESC
    LIMIT 50
  `

  return json({ok:true,rooms})
}

async function handleLeaderboard(sql) {
  try {
    const result = await sql`
      SELECT *
      FROM chess_leaderboard
      ORDER BY rating DESC
      LIMIT 100
    `

    return json({ok:true,leaderboard:result})
  } catch {
    return json({ok:true,leaderboard:[]})
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
body{
 margin:0;min-height:100vh;display:flex;align-items:center;
 justify-content:center;background:#070a10;color:#fff;
 font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif
}
.box{text-align:center}
.logo{
 width:80px;height:80px;border-radius:22px;background:#fff;color:#080b10;
 display:flex;align-items:center;justify-content:center;
 margin:auto auto 20px;font-weight:900;font-size:27px
}
p{color:#858fa0}
</style>
</head>
<body>
<main class="box">
<div class="logo">JP</div>
<h1>JACK Portal</h1>
<p>Portal service is running normally.</p>
</main>
</body>
</html>`
}

async function router(request,env) {
  const url = new URL(request.url)
  const pathname = normalizePath(request.url)
  const method = request.method.toUpperCase()
  const sql = getSql(env)

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
    return html(homePage())
  }

  if (pathname === '/api/status') {
    return handleStatus(sql)
  }

  if (pathname === '/rooms') {
    return handleRooms(sql,url)
  }

  if (pathname === '/leaderboard') {
    return handleLeaderboard(sql)
  }

  if (
    pathname === '/api/chess/create' ||
    pathname === '/api/chess/join' ||
    pathname.startsWith('/api/chess/')
  ) {
    return json({
      ok:false,
      error:'CHESS_ROUTE_NOT_CONFIGURED'
    },501)
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
      error:'INTERNAL_SERVER_ERROR'
    },500)
  }
}
