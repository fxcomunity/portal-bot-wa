# Jack Portal (Cloudflare Pages Functions)

Web portal buat pantau game catur bot WA — leaderboard & room yang lagi
aktif. Gak ada tempat main di sini, main tetap di WhatsApp (`.chess online`).

## Kenapa struktur beda dari versi Node biasa
Cloudflare Pages TIDAK bisa jalanin server Node.js yang `listen()` terus
(seperti `http.createServer`). Yang didukung adalah **Pages Functions**:
tiap request masuk lewat file di folder `functions/`, dieksekusi sendiri,
selesai, tanpa proses yang nyala terus. Makanya:

- `functions/[[path]].js` — satu file "catch-all", nangkep semua route
  (`/`, `/leaderboard`, `/rooms`, `/api/chess/*`, dll) dan routing manual
  di dalamnya.
- Pakai `@neondatabase/serverless` (bukan `pg`), karena `pg` butuh koneksi
  TCP biasa yang gak didukung runtime Cloudflare. Driver ini connect ke
  Neon lewat HTTP.
- `public/` cuma placeholder — Cloudflare Pages tetap minta folder output
  build walau isinya kosong/gak dipakai (semua request ditangkap Functions).

## Setup di Cloudflare Pages dashboard
Buka project → Settings → Builds & deployments:
- **Build command**: kosongin (atau `echo skip`)
- **Build output directory**: `public`
- **Root directory**: `/` (biarin default, sesuai repo)

Environment variables (Settings → Environment variables), buat Production
DAN Preview:
- `CHESS_DATABASE_URL` = connection string Neon (`postgresql://...`)

## Database
Server ini TIDAK bikin tabel sendiri. Tabel `chess_rooms`, `chess_players`,
`chess_matches`, view `leaderboard_chess`, `rpg_users` harus udah ada
(dipakai bareng sama bot WA).

## Routes
- `/` — halaman utama
- `/leaderboard`, `/api/leaderboard` — ranking pemain
- `/rooms`, `/api/rooms` — room waiting/playing, auto-refresh 10 detik
- `/api/chess/create`, `/api/chess/join`, `/api/chess/:room` — dipakai bot
  WA & papan interaktif buat sync data game
