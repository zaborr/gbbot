import { useMemo } from 'react';
import { qrMatrix } from '../lib/qr.js';

/** A QR code drawn as SVG: dark modules on white, with the standard quiet zone. */
export function QrCode({ text, size = 220 }: { text: string; size?: number }): React.JSX.Element {
  const { path, total } = useMemo(() => {
    const modules = qrMatrix(text);
    const quiet = 4;
    let d = '';
    modules.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }),
    );
    return { path: d, total: modules.length + quiet * 2 };
  }, [text]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      role="img"
      style={{ display: 'block', margin: '0 auto', background: '#fff', borderRadius: 8 }}
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
