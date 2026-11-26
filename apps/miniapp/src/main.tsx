import '@telegram-apps/telegram-ui/dist/styles.css';
import './styles.css';
import { StrictMode } from 'react';
import { isTMA } from '@telegram-apps/sdk-react';
import { createRoot } from 'react-dom/client';
import { mockEnvForDev } from './mockEnv.js';
import { init } from './init.js';
import { App } from './App.js';
import { EnvUnsupported } from './components/EnvUnsupported.js';
import { setWebMode } from './lib/web.js';

// Must run before init() so a browser launch has a mocked environment.
mockEnvForDev();

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root not found');
const root = createRoot(container);

// Outside Telegram the app runs in web mode (on the normal domain and the
// onion address alike): at /admin for the organisers (username, password and
// code), anywhere else for customers (with the key an organiser gave them).
const web = !isTMA();
const atAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin';
setWebMode(web, atAdmin ? 'admin' : 'customer');
// A GB's link (/s/<gb>) opens it in the app's own paths (after the #).
if (web && !atAdmin && /^\/s\/[^/]+/.test(window.location.pathname)) {
  window.history.replaceState(null, '', `/#${window.location.pathname}`);
}

try {
  if (!web) init(import.meta.env.DEV);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (error) {
  console.error('[tma-shop] init failed', error, window.location.href);
  root.render(<EnvUnsupported />);
}
