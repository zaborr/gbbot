import { useState } from 'react';

/**
 * Product photo from its `imageUrl`. Renders nothing when there is no URL or
 * the image fails to load (e.g. the external host removed it), so a broken
 * link never shows a broken-image icon in the shop.
 */
export function ProductImage({
  url,
  alt,
  size,
}: {
  url: string | null;
  alt: string;
  /** Square thumbnail size in px; omit for a full, uncropped banner. */
  size?: number;
}): React.JSX.Element | null {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;

  if (size !== undefined) {
    // Square thumbnail: crop to fill.
    return (
      <img
        src={url}
        alt={alt}
        loading="lazy"
        style={{ display: 'block', width: size, height: size, objectFit: 'cover', borderRadius: 10 }}
        onError={() => setFailed(true)}
      />
    );
  }

  // Banner: show the whole photo (no cropping), fitted to the width and capped
  // in height, centred on a neutral background.
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        background: 'var(--tgui--secondary_bg_color)',
      }}
    >
      <img
        src={url}
        alt={alt}
        style={{
          display: 'block',
          maxWidth: '100%',
          maxHeight: '60vh',
          width: 'auto',
          height: 'auto',
          objectFit: 'contain',
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
