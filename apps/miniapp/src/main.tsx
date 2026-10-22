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

// Outside Telegram, on the onion address only, the app runs in web mode
// (sign-in of web administrators); elsewhere it asks to open it in Telegram.
const web = !isTMA() && window.location.hostname.endsWith('.onion');
setWebMode(web);

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
