import { Cell } from '@telegram-apps/telegram-ui';
import { parsePeopleText, type Person } from '@tma-shop/shared';
import { Input } from './Field.js';
import { t } from '../i18n/index.js';

/** How a saved list is shown in the field: @username when known, else the id; pending ones last. */
export function peopleText(people: readonly Person[], pending: readonly string[]): string {
  return [
    ...people.map((p) => (p.username ? `@${p.username}` : String(p.telegramId))),
    ...pending.map((name) => `@${name}`),
  ].join(', ');
}

/** "@ana · Ana" for someone known, the bare id otherwise. */
export function personLabel(person: Person): string {
  const name = person.username ? `@${person.username}` : String(person.telegramId);
  return person.firstName ? `${name} · ${person.firstName}` : name;
}

/**
 * A list of people typed as @usernames or Telegram ids, mixed. Below it, the
 * saved list: who is in, and who is still pending (added by @username, with
 * no permissions until they open the app).
 */
export function PeopleField({
  header,
  value,
  onChange,
  people,
  pending,
}: {
  header: string;
  value: string;
  onChange: (value: string) => void;
  people: readonly Person[];
  pending: readonly string[];
}): React.JSX.Element {
  const { invalid } = parsePeopleText(value);
  return (
    <>
      <Input
        header={
          invalid.length > 0 ? t('people.invalid', { items: invalid.join(', ') }) : header
        }
        placeholder="@ana, @luis, 123456789"
        status={invalid.length > 0 ? 'error' : 'default'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {people.map((person) => (
        <Cell
          key={person.telegramId}
          subtitle={person.firstName ? String(person.telegramId) : t('people.neverSeen')}
          multiline
        >
          {personLabel(person)}
        </Cell>
      ))}
      {pending.map((name) => (
        <Cell key={name} subtitle={t('people.pendingHint')} after={t('people.pending')} multiline>
          @{name}
        </Cell>
      ))}
    </>
  );
}

/** The typed refs, or null while something in the field is not valid. */
export function peopleRefs(value: string): string[] | null {
  const { refs, invalid } = parsePeopleText(value);
  return invalid.length > 0 ? null : refs;
}
