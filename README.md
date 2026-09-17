# Jack Portal

Web portal buat pantau game catur bot WA — leaderboard & room yang lagi aktif.
Gak ada tempat main di sini, main tetap di WhatsApp (`.chess online`).

Repo ini KHUSUS buat web portal. Bot WA (yang connect ke WhatsApp, command
`.chess`/`.catur`, dll) ada di project/server terpisah — tidak ada
hubungannya dengan repo ini.

## Struktur
- `index.js` — entry point, cuma nyalain HTTP server
- `server/chess-server.js` — semua logic portal (routes + API)

## Routes
- `/` — halaman utama
- `/leaderboard` — ranking pemain (dari view `leaderboard_chess`)
- `/rooms` — room yang lagi waiting/playing, auto-refresh 10 detik
- `/api/leaderboard`, `/api/rooms` — versi JSON
- `/api/chess/create`, `/api/chess/join`, `/api/chess/:room` — dipakai bot
  WA & papan interaktif buat sync data game

## Database
Pakai Neon Postgres. Server ini TIDAK bikin tabel sendiri — tabel
(`chess_rooms`, `chess_players`, `chess_matches`, view `leaderboard_chess`,
`rpg_users`) harus udah ada duluan di database yang sama dipakai bot.

## Setup
1. `npm install`
2. Copy `.env.example` jadi `.env`, isi `CHESS_DATABASE_URL`
3. `npm start`
