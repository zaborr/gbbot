const breakAll: React.CSSProperties = { wordBreak: 'break-all', whiteSpace: 'normal' };

/** A shipment tracking number, or a link when it is one. */
export function TrackingText({ value }: { value: string }): React.JSX.Element {
  return /^https?:\/\//i.test(value) ? (
    <a href={value} target="_blank" rel="noreferrer" style={breakAll}>
      {value}
    </a>
  ) : (
    <span style={breakAll}>{value}</span>
  );
}
