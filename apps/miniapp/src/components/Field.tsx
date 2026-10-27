import type { ComponentProps, ReactNode } from 'react';
import { Input as TgInput, Textarea as TgTextarea } from '@telegram-apps/telegram-ui';

/**
 * Drop-in `Input` and `Textarea` that always show their `header` as a label
 * and draw a visible box (styles in styles.css, `.tma-field`). Telegram UI only
 * draws the header on Android ("base") and, on iPhone, paints the field the
 * same colour as the section, so fields had neither label nor outline there.
 */

function Label({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="tma-field-label">{children}</div>;
}

function fieldClass(className: string | undefined): string {
  return className ? `tma-field ${className}` : 'tma-field';
}

export function Input({
  header,
  className,
  ...props
}: ComponentProps<typeof TgInput>): React.JSX.Element {
  return (
    <div className="tma-field-wrap">
      {header ? <Label>{header}</Label> : null}
      <TgInput className={fieldClass(className)} {...props} />
    </div>
  );
}

export function Textarea({
  header,
  className,
  ...props
}: ComponentProps<typeof TgTextarea>): React.JSX.Element {
  return (
    <div className="tma-field-wrap">
      {header ? <Label>{header}</Label> : null}
      <TgTextarea className={fieldClass(className)} {...props} />
    </div>
  );
}
