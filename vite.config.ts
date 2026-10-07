/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// Strict Content Security Policy for the production build: the app may only load its own files
// and talk to GitHub's API (for encrypted sync). No third-party scripts, no inline scripts.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://api.github.com",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  // Relative paths so the app works under https://<user>.github.io/<repo>/
  base: './',
  plugins: [react(), cspPlugin()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { sourcemap: false, assetsInlineLimit: 0 },
  test: { environment: 'node' },
});
