'use strict';
/** Writes small real PDFs (6x9in trim, TrimBox set) used for browser checks. */
const path = require('node:path');
const fs = require('node:fs');
const { PDFDocument, pushGraphicsState, popGraphicsState, rectangle, setFillingRgbColor, fill } = require(
  require.resolve('pdf-lib', { paths: [path.resolve(__dirname, '../../')] })
);

const rect = (x, y, w, h) => [pushGraphicsState(), setFillingRgbColor(0.2, 0.2, 0.2), rectangle(x, y, w, h), fill(), popGraphicsState()];

async function make(name, pageSpecs, { size = [432, 648], trimBox = true } = {}) {
  const doc = await PDFDocument.create();
  for (const rects of pageSpecs) {
    const page = doc.addPage(size);
    if (trimBox) page.setTrimBox(0, 0, size[0], size[1]);
    for (const r of rects) page.pushOperators(...rect(...r));
  }
  fs.writeFileSync(path.join(__dirname, 'fixtures', name), await doc.save());
}

(async () => {
  fs.mkdirSync(path.join(__dirname, 'fixtures'), { recursive: true });
  const filler = (n) => Array.from({ length: n }, () => [[100, 100, 100, 100]]);
  await make('ready.pdf', [[[100, 100, 100, 100]], ...filler(29)]);
  // top overshoot 4pt, autofixable
  await make('autofix.pdf', [[[100, 300, 100, 334]], ...filler(29)]);
  // left edge x=20: LEM_ORIENTATION_AMBIGUOUS with no direction given
  await make('ambiguous.pdf', [[[20, 200, 20, 100]], ...filler(29)]);
  // 20pt top overshoot: over autofix threshold -> manual review (+ confirmed violation)
  await make('review.pdf', [[[100, 300, 100, 340]], ...filler(29)]);
  // Typical Word/Canva export: page == 6x9, NO TrimBox (the engine alone cannot give a verdict)
  await make('notrim.pdf', [[[100, 100, 100, 100]], ...filler(29)], { trimBox: false });
  // A4, NO TrimBox: different size -> manual, never auto-resized
  await make('a4.pdf', [[[100, 100, 100, 100]], ...filler(29)], { size: [595.28, 841.89], trimBox: false });
  fs.writeFileSync(path.join(__dirname, 'fixtures', 'broken.pdf'), '%PDF-1.4\nthis is not really a pdf');
})();
