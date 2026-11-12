import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Section } from '@telegram-apps/telegram-ui';
import { Input } from './Field.js';
import { ApiClientError } from '../api/client.js';
import { useSecurityPhrase } from '../lib/securityPhrase.js';
import { t } from '../i18n/index.js';

/**
 * The customer's phrase, where the official bot shows it (on opening the app
 * and when paying). Without one, a nudge to choose it.
 */
export function SecurityPhraseBadge({ paying = false }: { paying?: boolean }): React.JSX.Element | null {
  const { phrase } = useSecurityPhrase();
  const navigate = useNavigate();
  if (phrase === undefined) return null;
  if (phrase === null) {
    return (
      <div className="gb-banner gb-banner--info gb-phrase">
        <span style={{ flex: 1 }}>{t('phrase.nudge')}</span>
        <Button size="s" onClick={() => navigate('/security-phrase')}>
          {t('phrase.choose')}
        </Button>
      </div>
    );
  }
  return (
    <div className="gb-phrase gb-phrase--shown" role="note">
      <span className="gb-phrase-value">🔐 {phrase}</span>
      <span className="gb-hint">{paying ? t('phrase.payingHint') : t('phrase.shownHint')}</span>
    </div>
  );
}

/** Choosing (or changing) the phrase, with what it is for, in the user's language. */
export function SecurityPhraseSetup({
  required = false,
  onSaved,
}: {
  /** Shown in the cart: no order without it. */
  required?: boolean;
  onSaved?: () => void;
}): React.JSX.Element {
  const { phrase, save } = useSecurityPhrase();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = value.trim();
  const valid = clean.length >= 3 && clean.length <= 40;

  const submit = (): void => {
    setBusy(true);
    setError(null);
    void save(clean)
      .then(() => {
        setValue('');
        onSaved?.();
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : t('error.title')))
      .finally(() => setBusy(false));
  };

  return (
    <Section
      header={required ? t('phrase.requiredTitle') : t('phrase.title')}
      footer={error ?? t('phrase.rules')}
    >
      <div className="gb-phrase-explain">
        <p>{t('phrase.what')}</p>
        <p>
          <strong>{t('phrase.fake')}</strong>
        </p>
        {phrase && <p className="gb-hint">{t('phrase.current', { phrase })}</p>}
      </div>
      <Input
        header={phrase ? t('phrase.newLabel') : t('phrase.label')}
        placeholder={t('phrase.placeholder')}
        autoComplete="off"
        maxLength={40}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div style={{ padding: 16 }}>
        <Button stretched disabled={!valid} loading={busy} onClick={submit}>
          {phrase ? t('phrase.change') : t('phrase.save')}
        </Button>
      </div>
    </Section>
  );
}
