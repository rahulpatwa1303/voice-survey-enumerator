import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS in dev because getUserMedia needs a secure context on a phone over LAN.
export default defineConfig({
  root: 'web',
  plugins: [basicSsl()],
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } },
  },
});
