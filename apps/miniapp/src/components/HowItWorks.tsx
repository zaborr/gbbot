import { useState } from 'react';
import { api } from '../api/client.js';
import { t } from '../i18n/index.js';

/**
 * A small "first time?" note above the GB list. The server decides when (once
 * per account, never to customers or the team); closing it is saved on the
 * account, so it does not come back on another device.
 */
export function HowItWorks(): React.JSX.Element | null {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  const close = (): void => {
    void api.markHowToSeen().catch(() => undefined);
    setOpen(false);
  };
  return (
    <div className="gb-banner gb-banner--info" role="note">
      <span style={{ fontSize: 22 }} aria-hidden="true">
        👋
      </span>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <strong>{t('howTo.title')}</strong>
        <span style={{ fontSize: 14 }}>{t('howTo.text')}</span>
      </div>
      <button type="button" className="gb-banner-close" aria-label={t('howTo.close')} onClick={close}>
        ✕
      </button>
    </div>
  );
}
