import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The OAuth sign-in and consent page is a second entry, served by Express at /oauth/sign-in and /oauth/consent.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        oauth: resolve(import.meta.dirname, 'oauth.html')
      }
    }
  }
});
