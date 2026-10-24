// SPDX-License-Identifier: AGPL-3.0-only
/**
 * QR code for the user center's "scan to add" card.
 *
 * The encoding itself is the `qrcode` package (MIT) — a hand-rolled encoder is
 * not worth its maintenance or its bug surface for one card. What lives here is
 * the thin, testable wrapper the page uses:
 * - `qrSvgPath(text)` → the SVG string for a link, or `null` when the text
 *   cannot be encoded (the page then hides the card instead of showing a broken
 *   code). Never throws.
 * - `qrModules(text)` → the boolean module matrix, so tests (and any future
 *   canvas renderer) can check the code without comparing pixels.
 *
 * Client-side by design: the link on the page is built in the browser (it
 * depends on the origin and the chosen profile), so the code is rendered there
 * from the same string that is shown next to it — nothing is fetched.
 */

/** Error-correction level: `M` survives a partly obscured scan and keeps a URL small. */
export const QR_ERROR_CORRECTION = 'M' as const;

/** Quiet zone in modules; 4 is the spec minimum, 1 keeps the card compact. */
export const QR_MARGIN = 2;

/**
 * Render `text` as an SVG document string.
 *
 * The module is imported lazily inside the call so importing this file (tests,
 * SSR of the page's logic) does not pull the encoder into the server bundle
 * before it is needed. Returns `null` for empty text or any encoder error.
 */
export async function qrSvgPath(text: string | null | undefined): Promise<string | null> {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return null;
  try {
    const { default: QR } = await import('qrcode');
    return await QR.toString(value, {
      type: 'svg',
      errorCorrectionLevel: QR_ERROR_CORRECTION,
      margin: QR_MARGIN,
    });
  } catch {
    return null;
  }
}

/** Boolean module matrix of `text` (row-major), or `null` when it cannot be encoded. */
export async function qrModules(text: string | null | undefined): Promise<boolean[][] | null> {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return null;
  try {
    const { default: QR } = await import('qrcode');
    const code = QR.create(value, { errorCorrectionLevel: QR_ERROR_CORRECTION });
    const size = code.modules.size;
    const out: boolean[][] = [];
    for (let row = 0; row < size; row += 1) {
      const line: boolean[] = [];
      for (let column = 0; column < size; column += 1) line.push(Boolean(code.modules.get(row, column)));
      out.push(line);
    }
    return out;
  } catch {
    return null;
  }
}
