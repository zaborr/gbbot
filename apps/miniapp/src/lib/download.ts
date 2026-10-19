/**
 * Hands a file generated on this device to the user. Telegram's in-app
 * browsers differ: sharing works on most phones, a download link on desktop.
 */
export async function shareOrDownload(
  fileName: string,
  content: string,
  type = 'text/csv',
): Promise<'shared' | 'downloaded' | 'failed'> {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  try {
    const file = new File([blob], fileName, { type });
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: fileName });
      return 'shared';
    }
  } catch (error) {
    // The user closing the share sheet is not a failure worth a download.
    if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
  }
  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}

/** RFC 4180 CSV with a BOM so Excel reads accents correctly. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const quote = (value: string | number): string => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `\uFEFF${rows.map((row) => row.map(quote).join(',')).join('\n')}\n`;
}
