import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import type { WebCredentials } from '@tma-shop/shared';
import { QrCode } from './QrCode.js';
import { copyText } from '../lib/clipboard.js';
import { t } from '../i18n/index.js';

/** Address of the web panel, or who to ask for it. */
export function Address({ onionUrl }: { onionUrl: string | null }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  if (!onionUrl) {
    return (
      <Cell multiline subtitle={t('webAccess.address')}>
        {t('webAccess.askAddress')}
      </Cell>
    );
  }
  return (
    <Cell
      multiline
      subtitle={t('webAccess.address')}
      description={t('webAccess.addressHint')}
      after={
        <Button
          size="s"
          mode="bezeled"
          onClick={() => void copyText(onionUrl).then((ok) => setCopied(ok))}
        >
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      }
    >
      <span style={{ wordBreak: 'break-all' }}>{onionUrl}</span>
    </Cell>
  );
}

/** Shown once, right after activating or renewing. */
export function Credentials({
  creds,
  onDone,
}: {
  creds: WebCredentials;
  onDone: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string): void => {
    void copyText(text).then((ok) => setCopied(ok ? key : null));
  };
  const copyButton = (key: string, text: string): React.JSX.Element => (
    <Button size="s" mode="bezeled" onClick={() => copy(key, text)}>
      {copied === key ? t('common.copied') : t('common.copy')}
    </Button>
  );

  return (
    <>
      <Section header={t('webAccess.onceTitle')} footer={t('webAccess.onceFooter')}>
        <Cell subtitle={t('web.username')}>{creds.username}</Cell>
        <Cell subtitle={t('web.password')} after={copyButton('password', creds.password)}>
          <code style={{ wordBreak: 'break-all' }}>{creds.password}</code>
        </Cell>
        <Address onionUrl={creds.onionUrl} />
      </Section>

      <Section header={t('webAccess.authTitle')} footer={t('webAccess.authFooter')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
          <Button
            stretched
            onClick={() => {
              window.location.href = creds.otpauth;
            }}
          >
            {t('webAccess.addToApp')}
          </Button>
          <QrCode text={creds.otpauth} />
        </div>
        <Cell
          multiline
          subtitle={t('webAccess.secret')}
          after={copyButton('secret', creds.totpSecret)}
        >
          <code style={{ wordBreak: 'break-all' }}>{creds.totpSecret}</code>
        </Cell>
      </Section>

      <Section>
        <div style={{ padding: 16 }}>
          <Button stretched mode="bezeled" onClick={onDone}>
            {t('webAccess.saved')}
          </Button>
        </div>
      </Section>
    </>
  );
}
