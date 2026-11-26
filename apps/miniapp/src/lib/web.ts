import { useSyncExternalStore } from 'react';
import type { AuthResponse, WebFile } from '@tma-shop/shared';

/**
 * Web mode: the app opened in a normal browser (web administrators, through
 * Tor) instead of inside Telegram. Set once at start-up.
 */
let web = false;
/** Who the web is for: the organisers (at /admin) or the customers (with a key). */
let kind: 'admin' | 'customer' = 'admin';

export function setWebMode(value: boolean, as: 'admin' | 'customer' = 'admin'): void {
  web = value;
  kind = as;
}

export function isWebMode(): boolean {
  return web;
}

/** A customer on the web (signed in with a key), not an organiser. */
export function isCustomerWeb(): boolean {
  return web && kind === 'customer';
}

const SESSION_KEY = 'gb:web-session';
const CUSTOMER_KEY = 'gb:web-customer';

/**
 * The organisers' web session lives only in this tab (closing it signs out);
 * a customer's stays in this browser until their key expires or they leave.
 */
export function webSession(): AuthResponse | null {
  try {
    const raw =
      kind === 'customer' ? window.localStorage.getItem(CUSTOMER_KEY) : window.sessionStorage.getItem(SESSION_KEY);
    const session = raw ? (JSON.parse(raw) as AuthResponse) : null;
    return session && new Date(session.expiresAt).getTime() > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function setWebSession(session: AuthResponse | null): void {
  try {
    const store = kind === 'customer' ? window.localStorage : window.sessionStorage;
    const key = kind === 'customer' ? CUSTOMER_KEY : SESSION_KEY;
    if (session) store.setItem(key, JSON.stringify(session));
    else store.removeItem(key);
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
