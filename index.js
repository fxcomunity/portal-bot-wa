/**
 * Jack Portal — entry point
 * Web portal buat pantau room catur (waiting/playing) & leaderboard.
 * TIDAK connect ke WhatsApp. Bot WA jalan terpisah, di server lain.
 */

import { startChessServer } from './server/chess-server.js'
import 'dotenv/config'

startChessServer().catch((err) => {
  console.error('Gagal menjalankan portal server:', err)
  process.exit(1)
})
