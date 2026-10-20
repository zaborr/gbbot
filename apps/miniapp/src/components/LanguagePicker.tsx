import { useState } from 'react';
import { Button, Section } from '@telegram-apps/telegram-ui';
import type { Lang } from '@tma-shop/shared';
import { api } from '../api/client.js';
import { lang, setLang, t } from '../i18n/index.js';

const LANGUAGES: Array<{ code: Lang; flag: string; name: string }> = [
  { code: 'es', flag: '🇪🇸', name: 'Español' },
  { code: 'en', flag: '🇬🇧', name: 'English' },
  { code: 'it', flag: '🇮🇹', name: 'Italiano' },
  { code: 'pt', flag: '🇵🇹', name: 'Português' },
];

/**
 * Flag buttons to choose the app language. The choice is saved for the user
 * (every device, and the bot's messages); until then Telegram's language is used.
 */
export function LanguagePicker(): React.JSX.Element {
  const [busy, setBusy] = useState<Lang | null>(null);
  const current = lang();

  const choose = async (code: Lang): Promise<void> => {
    if (code === current) return;
    setBusy(code);
    try {
      await api.setLanguage(code);
    } catch {
      // Not saved on the server: still switch on this device.
    }
    setBusy(null);
    setLang(code, code);
  };

  return (
    <Section header={t('language.title')}>
      <div style={{ display: 'flex', gap: 8, padding: 12 }}>
        {LANGUAGES.map((option) => (
          <Button
            key={option.code}
            size="s"
            mode={option.code === current ? 'filled' : 'bezeled'}
            loading={busy === option.code}
            title={option.name}
            onClick={() => void choose(option.code)}
          >
            <span aria-label={option.name} role="img" style={{ fontSize: 22, lineHeight: 1 }}>
              {option.flag}
            </span>
          </Button>
        ))}
      </div>
    </Section>
  );
}
