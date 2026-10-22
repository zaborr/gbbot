import { useSyncExternalStore } from 'react';
import type { AuthResponse, WebFile } from '@tma-shop/shared';

/**
 * Web mode: the app opened in a normal browser (web administrators, through
 * Tor) instead of inside Telegram. Set once at start-up.
 */
let web = false;

export function setWebMode(value: boolean): void {
  web = value;
}

export function isWebMode(): boolean {
  return web;
}

const SESSION_KEY = 'gb:web-session';

/** The web session lives only in this tab: closing it signs out. */
export function webSession(): AuthResponse | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as AuthResponse) : null;
  } catch {
    return null;
  }
}

export function setWebSession(session: AuthResponse | null): void {
  try {
    if (session) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: the session lasts until the page is reloaded.
  }
}

/** What Telegram's bottom button would show; drawn by the page in web mode. */
export interface WebButtonState {
  text: string;
  visible: boolean;
  enabled: boolean;
  loading: boolean;
  onClick: (() => void) | null;
}

let button: WebButtonState = {
  text: '',
  visible: false,
  enabled: true,
  loading: false,
  onClick: null,
};
const listeners = new Set<() => void>();

export function setWebButton(update: Partial<WebButtonState>): void {
  button = { ...button, ...update };
  for (const listener of listeners) listener();
}

export function useWebButton(): WebButtonState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => button,
  );
}

const seenListeners = new Set<() => void>();

/** The inbox was read: the counter on the top bar goes back to zero. */
export function notifyNoticesSeen(): void {
  for (const listener of seenListeners) listener();
}

export function onNoticesSeen(listener: () => void): () => void {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
}

/** Saves a file the server returned (base64) on this device. */
export function saveBase64File(file: WebFile): void {
  const bytes = Uint8Array.from(atob(file.data), (ch) => ch.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
