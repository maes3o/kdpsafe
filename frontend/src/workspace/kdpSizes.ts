/**
 * Input assistance only -- NOT compliance logic. Common KDP paperback trim
 * sizes (inches) so users who don't know their size can pick one, plus a
 * hint matcher that compares the PDF's page size to those sizes. The engine
 * still receives only what the user confirms in `userIntent`.
 */

export interface TrimPreset {
  id: string;
  widthIn: number;
  heightIn: number;
}

export const TRIM_PRESETS: TrimPreset[] = [
  [5, 8],
  [5.25, 8],
  [5.5, 8.5],
  [6, 9],
  [6.14, 9.21],
  [6.69, 9.61],
  [7, 10],
  [7.5, 9.25],
  [8, 10],
  [8.5, 8.5],
  [8.5, 11],
].map(([widthIn, heightIn]) => ({ id: `${widthIn}x${heightIn}`, widthIn, heightIn }));

/** Published KDP bleed: +0.125 in on the outside edge and top/bottom, so a
 * with-bleed page is 0.125 in wider and 0.25 in taller than trim. */
const BLEED_EXTRA_W_IN = 0.125;
const BLEED_EXTRA_H_IN = 0.25;
const TOL_IN = 0.02;

export interface SizeSuggestion {
  preset: TrimPreset;
  bleed: boolean;
}

const near = (a: number, b: number) => Math.abs(a - b) <= TOL_IN;

/** "This PDF's pages look like preset X (with/without bleed)", or null. */
export function suggestFromPageSize(pageWidthIn: number, pageHeightIn: number): SizeSuggestion | null {
  for (const preset of TRIM_PRESETS) {
    if (near(pageWidthIn, preset.widthIn) && near(pageHeightIn, preset.heightIn)) return { preset, bleed: false };
  }
  for (const preset of TRIM_PRESETS) {
    if (near(pageWidthIn, preset.widthIn + BLEED_EXTRA_W_IN) && near(pageHeightIn, preset.heightIn + BLEED_EXTRA_H_IN)) {
      return { preset, bleed: true };
    }
  }
  return null;
}

export function matchPreset(widthIn: number, heightIn: number): TrimPreset | null {
  return TRIM_PRESETS.find((p) => Math.abs(p.widthIn - widthIn) < 0.0005 && Math.abs(p.heightIn - heightIn) < 0.0005) ?? null;
}
