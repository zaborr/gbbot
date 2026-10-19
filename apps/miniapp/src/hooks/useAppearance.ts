import { useEffect, useState } from 'react';
import { isColorDark, miniApp, themeParams, useSignal } from '@telegram-apps/sdk-react';

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  );
}

/**
 * Light or dark: Telegram's theme when it gave us one, otherwise the
 * device/browser setting (and it follows changes to either).
 */
export function useAppearance(): 'light' | 'dark' {
  const background = useSignal(themeParams.backgroundColor);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (): void => setSystemDark(query.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  if (background) return isColorDark(background) ? 'dark' : 'light';
  return systemDark ? 'dark' : 'light';
}

/**
 * Paints everything outside the React tree with the app's single background
 * colour: the page itself (`html[data-theme]`, see styles.css) and Telegram's
 * own header, background and bottom bar.
 */
export function useAppearanceChrome(appearance: 'light' | 'dark'): void {
  // The Telegram colours can only be set once the mini app is mounted.
  const mounted = useSignal(miniApp.isMounted);

  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
    if (!mounted) return;
    const color = appearance === 'dark' ? 'bg_color' : 'secondary_bg_color';
    const steps = [
      () => miniApp.setHeaderColor.isAvailable() && miniApp.setHeaderColor(color),
      () => miniApp.setBackgroundColor.isAvailable() && miniApp.setBackgroundColor(color),
      () => miniApp.setBottomBarColor.isAvailable() && miniApp.setBottomBarColor(color),
    ];
    for (const step of steps) {
      try {
        step();
      } catch {
        // Older Telegram clients: keep their default colours.
      }
    }
  }, [appearance, mounted]);
}
