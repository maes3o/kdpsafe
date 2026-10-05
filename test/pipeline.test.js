'use strict';

const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { inspectManuscript } = require('../lib/manuscript');
const { calculateSpineWidth, calculateCoverDimensions } = require('../lib/spine');

async function makeSamplePdf({ pageCount, widthIn, heightIn }) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([widthIn * 72, heightIn * 72]);
  }
  return doc.save();
}

async function main() {
  // 6x9, no-bleed, 300-page manuscript (typical text-only novel)
  const bytes = await makeSamplePdf({ pageCount: 300, widthIn: 6, heightIn: 9 });
  const inspected = await inspectManuscript(bytes);

  assert.equal(inspected.pageCount, 300, 'page count');
  assert.equal(inspected.trimWidthIn, 6, 'trim width');
  assert.equal(inspected.trimHeightIn, 9, 'trim height');
  assert.equal(inspected.pageSizeConsistent, true, 'page size consistent');

  const spine = calculateSpineWidth({ pageCount: inspected.pageCount, paperType: 'cream' });
  const cover = calculateCoverDimensions({
    trimWidthIn: inspected.trimWidthIn,
    trimHeightIn: inspected.trimHeightIn,
    spineWidthIn: spine.spineWidthIn,
  });

  console.log('Manuscript:', inspected);
  console.log('Spine:', spine);
  console.log('Cover:', cover);

  // Sanity: a 300pp 6x9 cream-paper cover should be a bit under 13" wide
  assert.ok(cover.totalWidthIn > 12.5 && cover.totalWidthIn < 13.5, 'cover width sanity range');

  // Inconsistent page sizes should be flagged
  const doc2 = await PDFDocument.create();
  doc2.addPage([6 * 72, 9 * 72]);
  doc2.addPage([6.125 * 72, 9.25 * 72]); // a bleed page mixed in with non-bleed pages
  const bytes2 = await doc2.save();
  const inspected2 = await inspectManuscript(bytes2);
  assert.equal(inspected2.pageSizeConsistent, false, 'mixed page sizes should be flagged inconsistent');

  console.log('\nAll pipeline tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
