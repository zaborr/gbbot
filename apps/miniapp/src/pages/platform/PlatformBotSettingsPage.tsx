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
const CHANNEL_RE = /^(@[A-Za-z][A-Za-z0-9_]{3,31}|-100\d{5,})$/;
const LANG_NAMES: Record<Lang, string> = { en: 'EN', es: 'ES', it: 'IT', pt: 'PT' };

/** Largest photo accepted (it is kept in the database and sent to @BotFather). */
const MAX_PHOTO_BYTES = 1024 * 1024;

/**
 * The file as base64, untouched. No canvas: Tor Browser blocks reading it and
 * hands back noise instead of the picture. @BotFather crops it by itself.
 */
function photoFrom(file: File): Promise<string> {
  if (!/^image\/(jpeg|png)$/.test(file.type)) return Promise.reject(new Error(t('botSettings.photoType')));
  if (file.size > MAX_PHOTO_BYTES) return Promise.reject(new Error(t('botSettings.photoTooBig')));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:image\/\w+;base64,/, ''));
    reader.onerror = () => reject(new Error(t('error.title')));
    reader.readAsDataURL(file);
  });
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
  const [channel, setChannel] = useState(settings.noticesChannel ?? '');
  const [noticeText, setNoticeText] = useState(settings.noticeText);
  const [dmAdmins, setDmAdmins] = useState(settings.dmAdmins);
  const [saved, setSaved] = useState(false);

  const countNumber = Number(count);
  const daysNumber = Number(days);
  const watchNumber = Number(watch);
  const userCheckNumber = Number(userCheck);
  const watchOk = Number.isInteger(watchNumber) && watchNumber >= 1 && watchNumber <= 60;
  const userCheckOk = Number.isInteger(userCheckNumber) && userCheckNumber >= 5 && userCheckNumber <= 720;
  const channelOk = channel.trim() === '' || CHANNEL_RE.test(channel.trim());
  const valid =
    channelOk &&
    watchOk &&
    userCheckOk &&
    PREFIX_RE.test(prefix.trim()) &&
    Number.isInteger(countNumber) &&
    countNumber >= 0 &&
    countNumber <= 5 &&
    Number.isInteger(daysNumber) &&
    daysNumber >= 1 &&
    daysNumber <= 30;

  const [photoError, setPhotoError] = useState<string | null>(null);
  const pick = (file: File | undefined): void => {
    if (!file) return;
    setPhotoError(null);
    void photoFrom(file)
      .then((data) => {
        setPhoto(data);
        setPhotoChanged(true);
      })
      .catch((error: unknown) => setPhotoError(error instanceof Error ? error.message : t('error.title')));
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
        noticesChannel: channel.trim() || null,
        noticeText: noticeText.trim(),
        dmAdmins,
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

      <Section header={t('botSettings.photo')} footer={photoError ?? t('botSettings.photoFooter')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: 16 }}>
          {photo ? (
            <img
              src={`data:${photo.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'};base64,${photo}`}
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

      <Section header={t('botSettings.notices')} footer={t('botSettings.noticesFooter')}>
        <Input
          header={t('botSettings.channel')}
          placeholder="@canal"
          autoComplete="off"
          value={channel}
          status={channelOk ? 'default' : 'error'}
          onChange={(e) => setChannel(e.target.value)}
        />
        <Textarea
          header={t('botSettings.noticeText')}
          placeholder={t('botSettings.noticeTextPlaceholder')}
          value={noticeText}
          onChange={(e) => setNoticeText(e.target.value)}
        />
        <Cell
          Component="label"
          multiline
          subtitle={t('botSettings.dmAdminsHint')}
          after={<Switch checked={dmAdmins} onChange={(e) => setDmAdmins(e.target.checked)} />}
        >
          {t('botSettings.dmAdmins')}
        </Cell>
      </Section>

      {settings.groups.length > 0 && (
        <Section header={t('botSettings.groups')} footer={t('botSettings.groupsFooter')}>
          {settings.groups.map((group) => (
            <Cell
              key={group.chatId}
              multiline
              subtitle={group.at ? (group.ok ? formatDate(group.at) : (group.error ?? '')) : t('botSettings.groupNotYet')}
              after={
                <span className={`gb-chip ${group.ok ? 'gb-chip--info' : group.at ? 'gb-chip--warn' : ''}`}>
                  {group.ok ? t('botSettings.groupOk') : group.at ? t('botSettings.groupFailed') : '—'}
                </span>
              }
            >
              {group.title || String(group.chatId)}
            </Cell>
          ))}
          <Cell onClick={() => void actions.run(async () => {
            await api.platformRetryBotGroups();
            onSaved();
          })}>
            {t('botSettings.groupsRetry')}
          </Cell>
        </Section>
      )}

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
