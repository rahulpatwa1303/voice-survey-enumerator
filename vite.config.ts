import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Dev runs Vite and Fastify side by side; production is one Fastify process
// serving the built assets, so there is no proxy and no second port.
export default defineConfig({
  root: 'web',
  // HTTPS in dev because getUserMedia needs a secure context on a phone over LAN.
  plugins: [basicSsl()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // the AudioWorklet is loaded by URL at runtime, so it must stay a real file
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } },
  },
});
