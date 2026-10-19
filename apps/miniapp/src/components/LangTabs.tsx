import { Button } from '@telegram-apps/telegram-ui';
import { t } from '../i18n/index.js';

export type TextLang = 'es' | 'en';

/**
 * 🇪🇸 | 🇬🇧 switch for texts written in both languages: only the fields of
 * the chosen one are shown. The English flag says whether it is filled in.
 */
export function LangTabs({
  value,
  onChange,
  englishDone,
}: {
  value: TextLang;
  onChange: (lang: TextLang) => void;
  englishDone: boolean;
}): React.JSX.Element {
  return (
    <div style={{ padding: '12px 16px 4px' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="s" mode={value === 'es' ? 'filled' : 'bezeled'} onClick={() => onChange('es')}>
          🇪🇸 {t('langTabs.es')}
        </Button>
        <Button size="s" mode={value === 'en' ? 'filled' : 'bezeled'} onClick={() => onChange('en')}>
          🇬🇧 {englishDone ? '✓' : '—'}
        </Button>
      </div>
      <div className="tma-field-label" style={{ padding: '6px 0 0' }}>
        {value === 'es' ? t('langTabs.esHint') : t('langTabs.enHint')}
      </div>
    </div>
  );
}
