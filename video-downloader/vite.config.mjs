import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export default defineConfig({
  root, plugins: [react(), tailwind()], resolve: { alias: { '@': path.join(root, 'src') } },
  build: { outDir: 'dist', emptyOutDir: true,
    rolldownOptions: { input: path.join(root, 'index.html') } },
})
