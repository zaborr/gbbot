import {
  backButton,
  initData,
  init as initSDK,
  miniApp,
  setDebug,
  themeParams,
  viewport,
} from '@telegram-apps/sdk-react';

/** Runs an optional setup step; logs instead of crashing the whole app if it fails. */
function safe(name: string, fn: () => unknown): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.catch((error: unknown) => console.warn(`[tma-shop] ${name} failed`, error));
    }
  } catch (error) {
    console.warn(`[tma-shop] ${name} failed`, error);
  }
}

export function init(debug: boolean): void {
  setDebug(debug);

  // Essential: these fail only when the app is not launched from Telegram.
  initSDK();
  initData.restore();

  // Optional components: wait for async mounts before binding CSS vars.
  safe('backButton', () => {
    if (backButton.isSupported()) backButton.mount();
  });
  safe('miniApp', async () => {
    if (miniApp.mount.isAvailable()) {
      await miniApp.mount();
      miniApp.bindCssVars();
    }
  });
  safe('themeParams', async () => {
    if (themeParams.mount.isAvailable()) {
      await themeParams.mount();
      themeParams.bindCssVars();
    }
  });
  safe('viewport', async () => {
    if (viewport.mount.isAvailable()) {
      await viewport.mount();
      viewport.bindCssVars();
    }
  });
}
