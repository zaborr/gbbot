import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { Lab } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { formatPrice } from '../../lib/format.js';
import { Input } from '../../components/Field.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { useShop } from '../../providers/ShopProvider.js';
import { AdminOnly, ErrorBanner, toMajor, useAdminActions } from './common.js';
import { t } from '../../i18n/index.js';

const MONEY_RE = /^\d+([.,]\d{1,2})?$/;
const cents = (text: string): number => Math.round(Number(text.trim().replace(',', '.')) * 100);

/** A test as typed. */
interface TestDraft {
  id: string;
  name: string;
  cost: string;
  vials: string;
}
const newTest = (): TestDraft => ({ id: Math.random().toString(36).slice(2, 10), name: '', cost: '', vials: '1' });

/** The labs the GB works with, and their tests with prices (used to fill a testing's tiers). */
export function AdminLabsPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <Labs />
    </AdminOnly>
  );
}

function Labs(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const list = useAsync(() => api.adminLabs(), [reloadKey]);
  const [editing, setEditing] = useState<Lab | 'new' | null>(null);
  if (list.loading && !list.data) return <Loader />;
  if (list.error) return <ErrorView message={list.error} />;
  if (editing) {
    return (
      <LabEditor
        lab={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          setReloadKey((k) => k + 1);
        }}
      />
    );
  }
  return (
    <List>
      <PageTitle title={t('labs.title')} />
      <Section footer={t('labs.footer')}>
        {(list.data ?? []).length === 0 && <Cell multiline>{t('labs.none')}</Cell>}
        {(list.data ?? []).map((lab) => (
          <Cell
            key={lab.id}
            multiline
            onClick={() => setEditing(lab)}
            after="›"
            subtitle={lab.tests.map((test) => `${test.name} ${formatPrice(test.cost, lab.currency)}`).join(' · ')}
          >
            {lab.name}
          </Cell>
        ))}
        <Cell onClick={() => setEditing('new')}>{t('labs.new')}</Cell>
      </Section>
    </List>
  );
}

function LabEditor({ lab, onDone }: { lab: Lab | null; onDone: () => void }): React.JSX.Element {
  const { shop } = useShop();
  const actions = useAdminActions(onDone);
  const [name, setName] = useState(lab?.name ?? '');
  const [currency, setCurrency] = useState(lab?.currency ?? shop.currency);
  const [notes, setNotes] = useState(lab?.notes ?? '');
  const [tests, setTests] = useState<TestDraft[]>(
    lab && lab.tests.length > 0
      ? lab.tests.map((x) => ({ id: x.id, name: x.name, cost: toMajor(x.cost), vials: String(x.vials) }))
      : [newTest()],
  );
  const patch = (index: number, change: Partial<TestDraft>): void =>
    setTests(tests.map((x, i) => (i === index ? { ...x, ...change } : x)));
  const filled = tests.filter((x) => x.name.trim() || x.cost.trim());
  const valid =
    name.trim().length > 0 &&
    currency.trim().length > 0 &&
    filled.every((x) => x.name.trim() && MONEY_RE.test(x.cost.trim()) && cents(x.cost) > 0 && /^\d+$/.test(x.vials));

  const save = (): void =>
    void actions.run(() =>
      api.adminSaveLab(lab?.id ?? null, {
        name: name.trim(),
        currency: currency.trim(),
        notes: notes.trim() || null,
        tests: filled.map((x) => ({ id: x.id, name: x.name.trim(), cost: cents(x.cost), vials: Number(x.vials) })),
      }),
    );

  return (
    <List>
      <PageTitle title={lab ? lab.name : t('labs.new')} />
      <ErrorBanner message={actions.error} />
      <Section>
        <Input header={t('labs.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <Input header={t('labs.currency')} value={currency} onChange={(e) => setCurrency(e.target.value)} />
        <Input header={t('labs.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Section>
      <Section header={t('labs.tests')} footer={t('labs.testsFooter')}>
        {tests.map((x, index) => (
          <div key={x.id} className="gb-testing-tier-row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 2 }}>
              <Input header={t('labs.testName')} value={x.name} onChange={(e) => patch(index, { name: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <Input
                header={t('labs.cost')}
                inputMode="decimal"
                value={x.cost}
                status={x.cost.trim() === '' || MONEY_RE.test(x.cost.trim()) ? 'default' : 'error'}
                onChange={(e) => patch(index, { cost: e.target.value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <Input
                header={t('labs.vials')}
                inputMode="numeric"
                value={x.vials}
                onChange={(e) => patch(index, { vials: e.target.value })}
              />
            </div>
          </div>
        ))}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Button stretched mode="bezeled" onClick={() => setTests([...tests, newTest()])}>
            {t('labs.addTest')}
          </Button>
          {tests.length > 1 && (
            <Button stretched mode="plain" onClick={() => setTests(tests.slice(0, -1))}>
              {t('labs.removeTest')}
            </Button>
          )}
        </div>
      </Section>
      <Section>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Button stretched disabled={!valid} onClick={save}>
            {t('labs.save')}
          </Button>
          <Button stretched mode="bezeled" onClick={onDone}>
            {t('labs.back')}
          </Button>
          {lab && (
            <Button
              stretched
              mode="plain"
              onClick={() => void actions.twoTap('delete', () => api.adminDeleteLab(lab.id))}
            >
              {actions.tapLabel('delete', t('labs.delete'))}
            </Button>
          )}
        </div>
      </Section>
    </List>
  );
}
