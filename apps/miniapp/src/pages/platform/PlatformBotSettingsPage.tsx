import { useState } from 'react';
import { Button, Cell, List, Section, Switch } from '@telegram-apps/telegram-ui';
import { LANGS, type BotSettings, type Lang } from '@tma-shop/shared';
import { Input, Textarea } from '../../components/Field.js';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { ErrorBanner, formatDate, useAdminActions } from '../admin/common.js';
import { t } from '../../i18n/index.js';

/** Platform super-admin: how the bots look, and how many spares to keep. */
export function PlatformBotSettingsPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <Settings />;
}

function Settings(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const settings = useAsync(() => api.platformBotSettings(), [reloadKey]);
  if (settings.loading && !settings.data) return <Loader />;
  if (settings.error) return <ErrorView message={settings.error} />;
  if (!settings.data) return <Loader />;
  return <SettingsForm key={settings.version} settings={settings.data} onSaved={() => setReloadKey((k) => k + 1)} />;
}

const PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,20}$/;
const LANG_NAMES: Record<Lang, string> = { en: 'EN', es: 'ES', it: 'IT', pt: 'PT' };

/** A square JPEG of at most 640 px, as base64: small enough for the database and @BotFather. */
async function photoFrom(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(side, 640);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas');
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.9).replace(/^data:image\/jpeg;base64,/, '');
}

function SettingsForm({ settings, onSaved }: { settings: BotSettings; onSaved: () => void }): React.JSX.Element {
  const actions = useAdminActions(() => undefined);
  const [prefix, setPrefix] = useState(settings.usernamePrefix);
  const [name, setName] = useState(settings.name);
  const [lang, setLang] = useState<Lang>('es');
  const [descriptions, setDescriptions] = useState(settings.descriptions);
  const [shorts, setShorts] = useState(settings.shortDescriptions);
  const [photo, setPhoto] = useState<string | null>(settings.photo);
  const [photoChanged, setPhotoChanged] = useState(false);
  const [count, setCount] = useState(String(settings.reserveCount));
  const [days, setDays] = useState(String(settings.reserveEveryDays));
  const [watch, setWatch] = useState(String(settings.watchMinutes));
  const [userCheck, setUserCheck] = useState(String(settings.userCheckMinutes));
  const [autoSwitch, setAutoSwitch] = useState(settings.autoSwitch);
  const [saved, setSaved] = useState(false);

  const countNumber = Number(count);
  const daysNumber = Number(days);
  const watchNumber = Number(watch);
  const userCheckNumber = Number(userCheck);
  const watchOk = Number.isInteger(watchNumber) && watchNumber >= 1 && watchNumber <= 60;
  const userCheckOk = Number.isInteger(userCheckNumber) && userCheckNumber >= 5 && userCheckNumber <= 720;
  const valid =
    watchOk &&
    userCheckOk &&
    PREFIX_RE.test(prefix.trim()) &&
    Number.isInteger(countNumber) &&
    countNumber >= 0 &&
    countNumber <= 5 &&
    Number.isInteger(daysNumber) &&
    daysNumber >= 1 &&
    daysNumber <= 30;

  const pick = (file: File | undefined): void => {
    if (!file) return;
    void photoFrom(file)
      .then((data) => {
        setPhoto(data);
        setPhotoChanged(true);
      })
      .catch(() => undefined);
  };

  const save = (): void =>
    void actions.run(async () => {
      await api.platformUpdateBotSettings({
        usernamePrefix: prefix.trim(),
        name: name.trim(),
        descriptions,
        shortDescriptions: shorts,
        ...(photoChanged ? { photo } : {}),
        reserveCount: countNumber,
        reserveEveryDays: daysNumber,
        watchMinutes: watchNumber,
        userCheckMinutes: userCheckNumber,
        autoSwitch,
      });
      setSaved(true);
      setPhotoChanged(false);
      onSaved();
    });

  return (
    <List>
      <ErrorBanner message={actions.error} />

      <Section header={t('botSettings.look')} footer={t('botSettings.lookFooter')}>
        <Input
          header={t('botSettings.prefix')}
          value={prefix}
          status={PREFIX_RE.test(prefix.trim()) ? 'default' : 'error'}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <Cell multiline subtitle={t('botSettings.prefixExample', { example: `${prefix.trim().toLowerCase() || 'gb'}_k7q2_bot` })}>
          {t('botSettings.prefixHint')}
        </Cell>
        <Input
          header={t('botSettings.name')}
          placeholder={t('botSettings.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Section>

      <Section header={t('botSettings.texts')} footer={t('botSettings.textsFooter')}>
        <div className="gb-chips" style={{ padding: '12px 16px 4px' }}>
          {LANGS.map((code) => (
            <Button key={code} size="s" mode={code === lang ? 'filled' : 'bezeled'} onClick={() => setLang(code)}>
              {LANG_NAMES[code]}
            </Button>
          ))}
        </div>
        <Textarea
          header={t('botSettings.description')}
          value={descriptions[lang] ?? ''}
          onChange={(e) => setDescriptions({ ...descriptions, [lang]: e.target.value })}
        />
        <Input
          header={t('botSettings.shortDescription')}
          value={shorts[lang] ?? ''}
          onChange={(e) => setShorts({ ...shorts, [lang]: e.target.value })}
        />
      </Section>

      <Section header={t('botSettings.photo')} footer={t('botSettings.photoFooter')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: 16 }}>
          {photo ? (
            <img
              src={`data:image/jpeg;base64,${photo}`}
              alt=""
              style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', flex: 'none' }}
            />
          ) : (
            <span className="gb-hint">{t('botSettings.noPhoto')}</span>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <input type="file" accept="image/jpeg,image/png" onChange={(e) => pick(e.target.files?.[0])} style={{ maxWidth: '100%' }} />
            {photo && (
              <Button
                size="s"
                mode="plain"
                onClick={() => {
                  setPhoto(null);
                  setPhotoChanged(true);
                }}
              >
                {t('botSettings.removePhoto')}
              </Button>
            )}
          </div>
        </div>
      </Section>

      <Section header={t('botSettings.reserve')} footer={t('botSettings.reserveFooter')}>
        <Input
          header={t('botSettings.reserveCount')}
          inputMode="numeric"
          value={count}
          status={Number.isInteger(countNumber) && countNumber >= 0 && countNumber <= 5 ? 'default' : 'error'}
          onChange={(e) => setCount(e.target.value)}
        />
        <Input
          header={t('botSettings.reserveDays')}
          inputMode="numeric"
          value={days}
          status={Number.isInteger(daysNumber) && daysNumber >= 1 && daysNumber <= 30 ? 'default' : 'error'}
          onChange={(e) => setDays(e.target.value)}
        />
      </Section>

      <Section header={t('botSettings.watch')} footer={t('botSettings.watchFooter')}>
        <Input
          header={t('botSettings.watchMinutes')}
          inputMode="numeric"
          value={watch}
          status={watchOk ? 'default' : 'error'}
          onChange={(e) => setWatch(e.target.value)}
        />
        <Input
          header={t('botSettings.userCheckMinutes')}
          inputMode="numeric"
          value={userCheck}
          status={userCheckOk ? 'default' : 'error'}
          onChange={(e) => setUserCheck(e.target.value)}
        />
        <Cell
          Component="label"
          multiline
          subtitle={t('botSettings.autoSwitchHint')}
          after={<Switch checked={autoSwitch} onChange={(e) => setAutoSwitch(e.target.checked)} />}
        >
          {t('botSettings.autoSwitch')}
        </Cell>
      </Section>

      {settings.lastError && (
        <Section header={t('botSettings.lastError')}>
          <Cell multiline subtitle={settings.lastErrorAt ? formatDate(settings.lastErrorAt) : undefined}>
            {settings.lastError}
          </Cell>
        </Section>
      )}

      <div style={{ padding: 16 }}>
        <Button stretched disabled={!valid} onClick={save}>
          {saved ? t('common.saved') : t('common.save')}
        </Button>
      </div>
    </List>
  );
}
