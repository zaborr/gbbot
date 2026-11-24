/** The longest side an uploaded image keeps, and the most it may weigh once made smaller. */
const MAX_SIDE = 1600;
const MAX_BYTES = 2_400_000;
/** What the phone may hand over before making it smaller. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function load(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };
    img.src = url;
  });
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * The image made smaller on the phone (at most 1600 px on its longest side),
 * as WebP when the browser can make it (keeps transparency), else PNG for a
 * PNG and JPEG for the rest. Null if it cannot be read or stays too heavy.
 */
export async function shrinkImage(file: File): Promise<Blob | null> {
  const img = await load(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const webp = await encode(canvas, 'image/webp', 0.85);
  if (webp && webp.type === 'image/webp' && webp.size <= MAX_BYTES) return webp;
  if (file.type === 'image/png') {
    const png = await encode(canvas, 'image/png', 1);
    if (png && png.size <= MAX_BYTES) return png;
  }
  // JPEG has no transparency: white behind it.
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const fctx = flat.getContext('2d');
  if (!fctx) return null;
  fctx.fillStyle = '#ffffff';
  fctx.fillRect(0, 0, flat.width, flat.height);
  fctx.drawImage(canvas, 0, 0);
  for (const quality of [0.85, 0.7, 0.55]) {
    const jpeg = await encode(flat, 'image/jpeg', quality);
    if (jpeg && jpeg.size <= MAX_BYTES) return jpeg;
  }
  return null;
}
