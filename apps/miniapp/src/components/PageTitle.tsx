import { Section, Title } from '@telegram-apps/telegram-ui';

/** A screen's title: the same words as its line in the admin menu. */
export function PageTitle({ title }: { title: string }): React.JSX.Element {
  return (
    <Section>
      <div style={{ padding: '12px 16px' }}>
        <Title level="2" weight="2">
          {title}
        </Title>
      </div>
    </Section>
  );
}
