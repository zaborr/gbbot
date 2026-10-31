import { useEffect, useState } from 'react';
import { Button } from '@telegram-apps/telegram-ui';
import { api } from '../api/client.js';
import { t } from '../i18n/index.js';

const SEEN_KEY = 'gb:how-it-works-seen';

/** Seen on this device before the mark was kept on the account. */
function seen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

/**
 * "How it works" in three steps, the first time someone opens the app. The
 * server decides when (once per account, never to customers); closing it is
 * saved on the account, so it does not come back on another device.
 */
export function HowItWorks(): React.JSX.Element | null {
  const [open, setOpen] = useState(() => !seen());
  useEffect(() => {
    // Already closed here before: just save it on the account.
    if (seen()) void api.markHowToSeen().catch(() => undefined);
  }, []);
  if (!open) return null;
  const close = (): void => {
    try {
      window.localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Storage blocked: the account keeps it anyway.
    }
    void api.markHowToSeen().catch(() => undefined);
    setOpen(false);
  };
  const steps = [
    { title: t('howTo.step1'), text: t('howTo.step1Text') },
    { title: t('howTo.step2'), text: t('howTo.step2Text') },
    { title: t('howTo.step3'), text: t('howTo.step3Text') },
  ];
  return (
    <div className="gb-sheet-backdrop" onClick={close}>
      <div
        className="gb-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('howTo.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong style={{ fontSize: 22 }}>{t('howTo.title')}</strong>
          <span className="gb-hint">{t('howTo.intro')}</span>
        </div>
        {steps.map((step, i) => (
          <div key={step.title} className="gb-sheet-step">
            <span className="gb-sheet-num">{i + 1}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <strong style={{ fontSize: 16 }}>{step.title}</strong>
              <span className="gb-hint" style={{ fontSize: 14 }}>
                {step.text}
              </span>
            </div>
          </div>
        ))}
        <Button stretched size="l" onClick={close}>
          {t('howTo.ok')}
        </Button>
      </div>
    </div>
  );
}
