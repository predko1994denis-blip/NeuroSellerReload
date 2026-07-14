import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Слушаем порт из env (PORT) — нужно превью-серверу для авто-назначения свободного порта.
  server: { port: process.env.PORT ? Number(process.env.PORT) : 5173 },
})
