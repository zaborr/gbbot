import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { mainButton } from '@telegram-apps/sdk-react';
import { isWebMode, setWebButton } from '../lib/web.js';

export interface MainButtonOptions {
  text: string;
  visible: boolean;
  enabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

type ButtonParams = NonNullable<Parameters<typeof mainButton.setParams>[0]>;

let pending: ButtonParams | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let settle: ReturnType<typeof setTimeout> | null = null;

/** Sends the button's whole current state again (the SDK keeps it). */
function resendMainButton(): void {
  settle = null;
  try {
    if (mainButton.isMounted()) mainButton.setParams({});
  } catch {
    // Not inside Telegram (or too old a client).
  }
}

/**
 * Sends button changes to Telegram a moment later, merged into one. Leaving a
 * screen hides the button and the next screen shows it again within the same
 * instant; sent separately, some Telegram clients keep the "hide" and drop the
 * "show". Merged, Telegram only gets the final state.
 */
function applyMainButton(update: ButtonParams): void {
  pending = { ...pending, ...update };
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    const params = pending;
    pending = null;
    try {
      if (params && mainButton.isMounted()) mainButton.setParams(params);
    } catch {
      // Not inside Telegram (or too old a client).
    }
    // Some clients also drop an update that comes right after another (a new
    // total while choosing shipping): the final state goes once more.
    if (settle !== null) clearTimeout(settle);
    settle = setTimeout(resendMainButton, 400);
  }, 30);
}

function hideMainButton(): void {
  if (isWebMode()) {
    setWebButton({ visible: false, loading: false, onClick: null });
    return;
  }
  applyMainButton({ isVisible: false, isLoaderVisible: false });
}

function ensureMounted(): boolean {
  if (!mainButton.mount.isAvailable()) return false;
  if (!mainButton.isMounted()) mainButton.mount();
  return true;
}

/**
 * Declaratively drives the Telegram MainButton from a component. The button is
 * hidden when the owning component unmounts.
 *
 * Changes (text, loading…) are applied in place. The button is never hidden
 * and shown again just to update it: some Telegram clients drop a "show" that
 * comes right after a "hide", which left screens without their button.
 */
export function useMainButton({
  text,
  visible,
  enabled = true,
  loading = false,
  onClick,
}: MainButtonOptions): void {
  const { pathname } = useLocation();
  const handler = useRef(onClick);
  handler.current = onClick;

  // One click listener for the life of the screen (always calls the latest handler).
  useEffect(() => {
    if (isWebMode()) {
      // In a browser the page draws the button itself.
      setWebButton({ onClick: () => handler.current() });
      return hideMainButton;
    }
    if (!ensureMounted()) return undefined;
    const off = mainButton.onClick(() => handler.current());
    return () => {
      off();
      hideMainButton();
    };
  }, []);

  // Look of the button; re-applied after every screen change, so the reset
  // of the screen change can never win over the screen we are on.
  useEffect(() => {
    if (isWebMode()) {
      setWebButton({ text, visible, enabled, loading, onClick: () => handler.current() });
      return;
    }
    if (!ensureMounted()) return;
    applyMainButton({
      text,
      isVisible: visible,
      isEnabled: enabled && !loading,
      isLoaderVisible: loading && visible,
    });
  }, [text, visible, enabled, loading, pathname]);
}

/**
 * Hides the MainButton whenever the screen changes. It runs before the new
 * screen's own `useMainButton` (layout effects run first), so only a screen
 * that wants the button shows it — going back never leaves a stale
 * "Add to cart" or "Place order" behind, even after a reload of the page.
 */
export function useMainButtonReset(): void {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    hideMainButton();
  }, [pathname]);
}
