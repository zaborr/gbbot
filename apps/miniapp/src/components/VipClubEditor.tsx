import { useState } from 'react';
import { PageTitle } from './PageTitle.js';
import { Button, Cell, List, Section, Switch } from '@telegram-apps/telegram-ui';
import {
  formatVipMembers,
  parseVipMembers,
  type UpdateVipClubRequest,
  type VipClub,
} from '@tma-shop/shared';
import { Input, Textarea } from './Field.js';
import { ErrorBanner, useAdminActions } from '../pages/admin/common.js';
import { t, tn } from '../i18n/index.js';

/**
 * Edits a VIP club: Telegram groups/channels whose members are VIP, plus a
 * hand-made list of @usernames and ids. Used for the platform's club and for
 * each shop's own club (which can also count the platform's members).
 */
export function VipClubEditor({
  club,
  useGlobalClub,
  onSave,
  title,
}: {
  club: VipClub;
  /** Screen title (the admin menu's words). */
  title?: string;
  /** Shops only: whether the platform's members also count. */
  useGlobalClub?: boolean;
  onSave: (input: UpdateVipClubRequest) => Promise<unknown>;
}): React.JSX.Element {
  const actions = useAdminActions(() => undefined);
  const [groups, setGroups] = useState(club.groups.map((g) => ({ ref: String(g.chatId), title: g.title })));
  const [newGroup, setNewGroup] = useState('');
  const [members, setMembers] = useState(formatVipMembers(club));
  const [global, setGlobal] = useState(useGlobalClub ?? true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const parsed = parseVipMembers(members);
  const groupRef = newGroup.trim();
  const groupValid = /^(@?[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{5,20}|https?:\/\/t\.me\/[A-Za-z0-9_]{4,32})$/.test(
    groupRef,
  );
  const total = parsed.userIds.length + parsed.usernames.length;

  const addGroup = (): void => {
    if (!groupValid || groups.some((g) => g.ref === groupRef)) return;
    setGroups((prev) => [...prev, { ref: groupRef, title: '' }]);
    setNewGroup('');
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setSaved(false);
    await actions.run(async () => {
      await onSave({
        groups: groups.map((g) => g.ref),
        userIds: parsed.userIds,
        usernames: parsed.usernames,
        ...(useGlobalClub === undefined ? {} : { useGlobalClub: global }),
      });
      setSaved(true);
    });
    setBusy(false);
  };

  return (
    <List>
      {title && <PageTitle title={title} />}
      <ErrorBanner message={actions.error} />

      <Section>
        <Cell multiline>{t('vip.intro')}</Cell>
      </Section>

      <Section header={t('vip.groups')} footer={t('vip.groupsFooter')}>
        {groups.length === 0 && <Cell multiline>{t('vip.noGroups')}</Cell>}
        {groups.map((group) => (
          <Cell
            key={group.ref}
            subtitle={group.title ? group.ref : t('vip.checkedOnSave')}
            after={
              <Button
                size="s"
                mode="bezeled"
                onClick={() => {
                  setGroups((prev) => prev.filter((g) => g.ref !== group.ref));
                  setSaved(false);
                }}
              >
                {t('common.delete')}
              </Button>
            }
          >
            {group.title || group.ref}
          </Cell>
        ))}
        <Input
          header={t('vip.addGroup')}
          placeholder="@mygroup / -1001234567890"
          status={groupRef !== '' && !groupValid ? 'error' : 'default'}
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
        />
        <div style={{ padding: '0 16px 12px' }}>
          <Button size="s" mode="bezeled" disabled={!groupValid} onClick={addGroup}>
            {t('common.add')}
          </Button>
        </div>
      </Section>

      <Section
        header={t('vip.members')}
        footer={
          parsed.invalid.length > 0
            ? t('vip.invalidMembers', { list: parsed.invalid.slice(0, 5).join(', ') })
            : t('vip.membersFooter')
        }
      >
        <Textarea
          header={tn(total, 'vip.count.one', 'vip.count.other')}
          placeholder={'@ana\n@bob\n123456789'}
          status={parsed.invalid.length > 0 ? 'error' : 'default'}
          value={members}
          onChange={(e) => {
            setMembers(e.target.value);
            setSaved(false);
          }}
        />
      </Section>

      {useGlobalClub !== undefined && (
        <Section footer={t('vip.globalFooter')}>
          <Cell
            Component="label"
            after={
              <Switch
                checked={global}
                onChange={(e) => {
                  setGlobal(e.target.checked);
                  setSaved(false);
                }}
              />
            }
            multiline
          >
            {t('vip.useGlobal')}
          </Cell>
        </Section>
      )}

      <Section>
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy}
            disabled={parsed.invalid.length > 0}
            onClick={() => void save()}
          >
            {saved ? t('common.saved') : t('common.save')}
          </Button>
        </div>
      </Section>
    </List>
  );
}
