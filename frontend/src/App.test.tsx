import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { makeEngine, openDetails, renderApp, uploadAndRun, pdfFile } from './test/harness';
import { AMBIGUOUS, EXPANDABLE, MANUAL, bbox, expandApplied, expandOffer, NEEDS_ATTENTION, READY, TIER1, TIER4, TIER5_SIGNED, UNRESOLVED_30, WITH_PLAN, assessment, inspection, normalizationResult, verifyResult, violation } from './test/fixtures';

vi.mock('./components/viewer/PdfViewer', async () => await import('./test/viewerMock'));

const verdict = () => screen.getByTestId('verdict-card');

describe('empty state', () => {
  it('shows the value proposition, an accessible dropzone and the privacy note', () => {
    renderApp(makeEngine({ preflight: () => READY }));
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeInTheDocument();
    expect(screen.getByTestId('dropzone')).toBeInTheDocument();
    expect(screen.getByText(/does not send your file to a server/)).toBeInTheDocument();
  });

  it('rejects a non-PDF without calling the engine', async () => {
    const engine = makeEngine({ preflight: () => READY });
    const { user } = renderApp(engine);
    await user.upload(screen.getByTestId('file-input'), new File(['hello'], 'x.pdf', { type: 'application/pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not look like a PDF/);
    expect(engine.runPreflight).not.toHaveBeenCalled();
  });
});

describe('manuscript settings', () => {
  it('never runs the engine until trim and bleed are stated', async () => {
    const engine = makeEngine({ preflight: () => READY, verify: () => verifyResult({ before: READY }) });
    const { user } = renderApp(engine);
    await user.upload(screen.getByTestId('file-input'), pdfFile());
    const run = await screen.findByRole('button', { name: 'Check PDF' });
    expect(run).toBeDisabled();
    expect(engine.runPreflight).not.toHaveBeenCalled();
  });

  it('passes the user-entered intent to the engine and re-runs when a setting changes', async () => {
    const engine = makeEngine({ preflight: () => READY, verify: () => verifyResult({ before: READY }) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen, { w: '5.5', h: '8.5', bleed: 'no' });
    await screen.findByTestId('verdict-card');
    expect(engine.runPreflight).toHaveBeenCalledTimes(1);
    expect(engine.runPreflight.mock.calls[0][1]).toEqual({ userIntent: { trimSize: { widthIn: 5.5, heightIn: 8.5 }, bleed: false } });

    await user.click(screen.getByRole('radio', { name: /With bleed/ }));
    await waitFor(() => expect(engine.runPreflight).toHaveBeenCalledTimes(2));
    expect(engine.runPreflight.mock.calls[1][1].userIntent.bleed).toBe(true);
  });
});

describe('size help', () => {
  it('a KDP preset fills the size; switching to mm shows the same size and still sends inches', async () => {
    const engine = makeEngine({ preflight: () => NEEDS_ATTENTION });
    const { user } = renderApp(engine);
    await user.upload(screen.getByTestId('file-input'), pdfFile());
    await user.selectOptions(await screen.findByLabelText('KDP trim size'), '6x9');
    expect(screen.getByLabelText(/Trim width/)).toHaveValue('6');
    await user.click(screen.getByRole('button', { name: 'Millimetres' }));
    expect(screen.getByLabelText(/Trim width/)).toHaveValue('152.4');
    expect(screen.getByLabelText(/Trim height/)).toHaveValue('228.6');
    await user.click(screen.getByRole('radio', { name: /No bleed/ }));
    await user.click(screen.getByRole('button', { name: 'Check PDF' }));
    await screen.findByTestId('verdict-card');
    expect(engine.runPreflight.mock.calls[0][1].userIntent.trimSize).toEqual({ widthIn: 6, heightIn: 9 });
    // results are shown in the chosen unit
    expect(screen.getByText(/Graphic extends 1\.4 mm past the safe margin/)).toBeInTheDocument();
  });

  it('suggests a preset (and bleed) from the PDF page size, but only applies it when asked', async () => {
    const engine = makeEngine({ preflight: () => READY, verify: () => verifyResult({ before: READY }) });
    const { user } = renderApp(engine);
    await user.upload(screen.getByTestId('file-input'), pdfFile());
    expect(await screen.findByText(/matches 6 × 9 in with bleed/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Trim width/)).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Use this' }));
    expect(screen.getByLabelText(/Trim width/)).toHaveValue('6');
    expect(screen.getByRole('radio', { name: /With bleed/ })).toBeChecked();
    expect(engine.runPreflight).not.toHaveBeenCalled();
  });
});

describe('verdict states', () => {
  it('READY with partial geometry: strong READY, geometry shown as information, VERIFIED with after:null, download enabled', async () => {
    const engine = makeEngine({
      preflight: () => READY,
      verify: () => verifyResult({ before: READY, after: null, verification: 'VERIFIED' }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);

    expect(await screen.findByTestId('verdict-card')).toHaveAttribute('data-verdict', 'READY');
    expect(verdict()).toHaveTextContent('READY');
    await openDetails(user, screen);
    expect(screen.getByText('Partly resolved')).toBeInTheDocument();
    expect(screen.getByText(/not a problem by itself/)).toBeInTheDocument();
    expect(screen.queryByText('PROBLEM')).not.toBeInTheDocument();

    const card = await screen.findByTestId('verification-card');
    expect(card).toHaveAttribute('data-verification', 'VERIFIED');
    expect(card).toHaveAttribute('data-after', 'null');
    expect(card).toHaveTextContent(/already READY/);
    expect(screen.getAllByRole('button', { name: 'Download verified PDF' })[0]).toBeEnabled();
  });

  it('READY: the PDF is not downloadable until the engine reports VERIFIED', async () => {
    let release: (r: ReturnType<typeof verifyResult>) => void = () => {};
    const engine = makeEngine({ preflight: () => READY, verify: () => new Promise((res) => (release = res)) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('verdict-card');
    await openDetails(user, screen);
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeDisabled();
    release(verifyResult({ before: READY }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Download verified PDF' })[0]).toBeEnabled());
  });

  it('NEEDS_ATTENTION: counts, grouped issues, page, side and amount', async () => {
    const engine = makeEngine({ preflight: () => NEEDS_ATTENTION });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);

    expect(await screen.findByTestId('verdict-card')).toHaveAttribute('data-verdict', 'NEEDS_ATTENTION');
    const headline = screen.getByTestId('verdict-headline');
    expect(headline).toHaveTextContent('2');
    expect(headline).toHaveTextContent('problems found');
    const list = screen.getByTestId('issue-list');
    expect(within(list).getByText('Page 3')).toBeInTheDocument();
    expect(within(list).getByText(/Graphic extends 0\.056 in past the safe margin \(top\)/)).toBeInTheDocument();
    expect(within(list).getByText(/Text extends 0\.139 in past the safe margin \(left\)/)).toBeInTheDocument();
    // not READY => no verified download is offered
    await openDetails(user, screen);
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeDisabled();
  });

  it('MANUAL_REVIEW_REQUIRED: says it cannot decide automatically, not that the PDF is wrong', async () => {
    const engine = makeEngine({ preflight: () => MANUAL });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);

    expect(await screen.findByTestId('verdict-card')).toHaveAttribute('data-verdict', 'MANUAL_REVIEW_REQUIRED');
    expect(screen.getByTestId('verdict-headline')).toHaveTextContent('1');
    expect(screen.getByTestId('verdict-headline')).toHaveTextContent('item needs your attention');
    expect(verdict()).toHaveTextContent(/cannot safely confirm these automatically/);
    expect(verdict()).toHaveTextContent(/does not mean the PDF is wrong/);
    expect(verdict()).not.toHaveTextContent(/Also confirmed problems/);
    expect(screen.getByText(/never moves text automatically/)).toBeInTheDocument();
  });
});

describe('orientation ambiguity', () => {
  it('asks for reading direction and re-runs the REAL preflight with it; the engine decides the outcome', async () => {
    const engine = makeEngine({ preflight: (n) => (n === 1 ? AMBIGUOUS : NEEDS_ATTENTION) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);

    const resolver = await screen.findByTestId('orientation-resolver');
    expect(screen.getAllByText(/LEM_ORIENTATION_AMBIGUOUS/).length).toBeGreaterThan(0); // raw code only in the secondary/technical lines
    await user.click(within(resolver).getByRole('button', { name: 'Right to left' }));

    await waitFor(() => expect(engine.runPreflight).toHaveBeenCalledTimes(2));
    expect(engine.runPreflight.mock.calls[1][1].userIntent).toEqual({
      trimSize: { widthIn: 6, heightIn: 9 },
      bleed: false,
      readingDirection: 'rtl',
    });
    // The UI shows what the engine returned, not what the choice implies.
    await waitFor(() => expect(verdict()).toHaveAttribute('data-verdict', 'NEEDS_ATTENTION'));
    expect(screen.queryByTestId('orientation-resolver')).not.toBeInTheDocument();
    // and the settings form reflects the chosen direction
    expect(screen.getByLabelText(/Reading direction/)).toHaveValue('rtl');
  });

  it('keeps asking if the engine still reports ambiguity', async () => {
    const engine = makeEngine({ preflight: () => AMBIGUOUS });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(within(await screen.findByTestId('orientation-resolver')).getByRole('button', { name: 'Left to right' }));
    await waitFor(() => expect(engine.runPreflight).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('orientation-resolver')).toBeInTheDocument();
  });
});

describe('issue -> page navigation', () => {
  it('clicking an issue sends the viewer to that page and marks it active', async () => {
    const engine = makeEngine({ preflight: () => NEEDS_ATTENTION });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('issue-list');
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-focus-page', '');

    await user.click(within(screen.getByTestId('issue-list')).getAllByRole('button')[0]);
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-focus-page', '2'); // pageIndex 2 = page 3
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-active', 'v-0');
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-marks', '2');
  });
});

describe('verdict hierarchy + mobile navigation', () => {
  it('READY states the answer first, then what was checked', async () => {
    const engine = makeEngine({ preflight: () => READY, verify: () => verifyResult({ before: READY }) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('verdict-card');
    expect(screen.getByTestId('verdict-headline')).toHaveTextContent('No problems found.');
    expect(verdict()).toHaveTextContent('Checked: margins and bleed.');
  });

  it('uses correct Ukrainian plural forms next to the number', async () => {
    const engine = makeEngine({ preflight: () => NEEDS_ATTENTION });
    const { user } = renderApp(engine, 'uk');
    await user.upload(screen.getByTestId('file-input'), pdfFile());
    await user.type(await screen.findByLabelText(/Ширина обрізу/), '6');
    await user.type(screen.getByLabelText(/Висота обрізу/), '9');
    await user.click(screen.getByRole('radio', { name: /Без вильоту/ }));
    await user.click(screen.getByRole('button', { name: 'Перевірити PDF' }));
    expect(await screen.findByTestId('verdict-headline')).toHaveTextContent(/2\s*проблеми знайдено/);
  });

  it('on narrow screens the PDF preview has an explicit way back to the results', async () => {
    const engine = makeEngine({ preflight: () => NEEDS_ATTENTION });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('issue-list');
    await user.click(within(screen.getByTestId('issue-list')).getAllByRole('button')[0]);
    expect(screen.queryByTestId('issue-list')).not.toBeInTheDocument(); // now in the Preview tab
    await user.click(screen.getByRole('button', { name: 'Back to results' }));
    expect(await screen.findByTestId('issue-list')).toBeInTheDocument();
  });
});

describe('page geometry (TrimBox normalization)', () => {
  const ORIGINAL_LEN = pdfFile().size;

  function engineForTier1() {
    return makeEngine({
      preflight: (n) => (n === 1 ? UNRESOLVED_30 : READY),
      assess: (n) => (n === 1 ? TIER1 : assessment()),
      normalize: () => normalizationResult({ after: READY }),
      verify: () => verifyResult({ before: READY }),
    });
  }

  it('R. review -> apply -> real re-preflight -> actual result; nothing is written before approval', async () => {
    const engine = engineForTier1();
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);

    const card = await screen.findByTestId('geometry-card');
    expect(card).toHaveAttribute('data-geometry-state', 'plan');
    expect(card).toHaveTextContent(/page size matches the selected trim/i);
    expect(card).toHaveTextContent('Add missing TrimBox');
    expect(card).toHaveTextContent(/Nothing is scaled, moved, cropped or rotated/);
    expect(engine.normalizePageGeometry).not.toHaveBeenCalled();
    expect(verdict()).toHaveAttribute('data-verdict', 'MANUAL_REVIEW_REQUIRED');

    await user.click(within(card).getByRole('button', { name: 'Review change' }));
    expect(screen.getByTestId('geometry-review')).toHaveTextContent('TrimBox: missing');
    expect(screen.getByTestId('geometry-review')).toHaveTextContent('TrimBox: 6 × 9 in');
    expect(engine.normalizePageGeometry).not.toHaveBeenCalled();

    await user.click(within(card).getByRole('button', { name: 'Add TrimBox' }));
    await waitFor(() => expect(engine.normalizePageGeometry).toHaveBeenCalledTimes(1));
    expect(engine.normalizePageGeometry.mock.calls[0][0].length).toBe(ORIGINAL_LEN);

    // The shown verdict is the engine's AFTER result, not an inference.
    await waitFor(() => expect(verdict()).toHaveAttribute('data-verdict', 'READY'));
    expect(screen.getByTestId('geometry-card')).toHaveAttribute('data-geometry-state', 'applied');
    expect(screen.getByTestId('geometry-card')).toHaveTextContent('TrimBox written on 30 page(s)');
    // neutral: writing a TrimBox is not a verdict, so the card carries no success (green) styling
    expect(screen.getByTestId('geometry-card').outerHTML).not.toMatch(/status-ready/);
    expect(screen.getByTestId('geometry-card')).not.toHaveTextContent('✓');
    // VERIFIED comes from the engine's verification of the NEW bytes
    await screen.findByTestId('verification-card');
    expect(engine.verifyAutofix.mock.calls[0][0].length).toBe(5);
    expect(screen.getAllByRole('button', { name: 'Download verified PDF' })[0]).toBeEnabled();
  });

  it('shows the real engine result even when it is not READY after normalization', async () => {
    const engine = makeEngine({
      preflight: (n) => (n === 1 ? UNRESOLVED_30 : NEEDS_ATTENTION),
      assess: (n) => (n === 1 ? TIER1 : assessment()),
      normalize: () => normalizationResult({ after: NEEDS_ATTENTION }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(await screen.findByRole('button', { name: 'Add TrimBox' }));
    await waitFor(() => expect(verdict()).toHaveAttribute('data-verdict', 'NEEDS_ATTENTION'));
    expect(screen.queryByTestId('verification-card')).not.toBeInTheDocument();
  });

  it('undo restores the ORIGINAL bytes and re-analyses from scratch', async () => {
    const engine = engineForTier1();
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(await screen.findByRole('button', { name: 'Add TrimBox' }));
    await screen.findByText('TrimBox written on 30 page(s)');
    const callsBefore = engine.runPreflight.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Restore original file' }));
    await waitFor(() => expect(engine.runPreflight.mock.calls.length).toBe(callsBefore + 1));
    expect(engine.runPreflight.mock.calls.at(-1)![0].length).toBe(ORIGINAL_LEN);
  });

  it('changing a setting after normalization drops it and analyses the original again', async () => {
    const engine = engineForTier1();
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(await screen.findByRole('button', { name: 'Add TrimBox' }));
    await screen.findByText('TrimBox written on 30 page(s)');
    await user.click(screen.getByRole('radio', { name: /With bleed/ }));
    await waitFor(() => expect(engine.runPreflight.mock.calls.at(-1)![1].userIntent.bleed).toBe(true));
    expect(engine.runPreflight.mock.calls.at(-1)![0].length).toBe(ORIGINAL_LEN);
  });

  it('a failed safety check shows an error and keeps the original file and result', async () => {
    const engine = makeEngine({
      preflight: () => UNRESOLVED_30,
      assess: () => TIER1,
      normalize: () =>
        normalizationResult({ applied: false, after: null, safety: { ok: false, checks: [{ id: 'CONTENT_STREAMS_CHANGED', ok: false }], failure: 'CONTENT_STREAMS_CHANGED' } }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(await screen.findByRole('button', { name: 'Add TrimBox' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Page boxes could not be changed/);
    expect(screen.getByRole('alert')).toHaveTextContent(/Your file was not modified/);
    expect(verdict()).toHaveAttribute('data-verdict', 'MANUAL_REVIEW_REQUIRED');
    expect(engine.runPreflight).toHaveBeenCalledTimes(1);
  });

  it('30 identical per-page "unresolved" entries become ONE grouped item (and one count)', async () => {
    const engine = makeEngine({ preflight: () => UNRESOLVED_30, assess: () => TIER1 });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    expect(await screen.findByTestId('verdict-headline')).toHaveTextContent('1');
    expect(screen.getByTestId('verdict-headline')).toHaveTextContent('item needs your attention');
    const list = screen.getByTestId('issue-list');
    expect(within(list).getByText('Pages: 1–30')).toBeInTheDocument();
    expect(within(list).getByText(/no explicit TrimBox/)).toBeInTheDocument();
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });

  it('a different page size (A4 -> 6x9) is explained, never offered as an automatic fix', async () => {
    const engine = makeEngine({ preflight: () => UNRESOLVED_30, assess: () => TIER4 });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    const card = await screen.findByTestId('geometry-card');
    expect(card).toHaveAttribute('data-geometry-state', 'manual');
    expect(card).toHaveTextContent(/cannot safely determine which part of the page to keep/);
    expect(card).toHaveTextContent('8.268 × 11.693 in');
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    expect(engine.normalizePageGeometry).not.toHaveBeenCalled();
  });

  it('a signed (or encrypted) PDF is DO NOT TOUCH with the specific reason', async () => {
    const engine = makeEngine({ preflight: () => UNRESOLVED_30, assess: () => TIER5_SIGNED });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    const card = await screen.findByTestId('geometry-card');
    expect(card).toHaveTextContent('KDPSafe will not modify this file');
    expect(card).toHaveTextContent(/digitally signed/);
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });

  it('trim+bleed without a reading direction asks for it instead of guessing', async () => {
    const engine = makeEngine({
      preflight: () => UNRESOLVED_30,
      assess: () => assessment({ category: 'EXACT_PAGE_WITH_BLEED', tier: 2, bleed: true, trimBox: 'missing', reasons: ['READING_DIRECTION_REQUIRED'], pageSize: { widthIn: 6.125, heightIn: 9.25 } }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen, { bleed: 'yes' });
    const card = await screen.findByTestId('geometry-card');
    expect(card).toHaveTextContent(/Choose a reading direction/);
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });

  it('page size and trim are different things: stats say "Page size", Details show selected trim and TrimBox', async () => {
    const engine = makeEngine({ preflight: () => UNRESOLVED_30, assess: () => TIER1 });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('verdict-card');
    expect(screen.getByText('Page size')).toBeInTheDocument();
    // the only "Trim size" is the settings legend (the user's selection), never a measured value
    for (const dl of document.querySelectorAll('dl')) expect(dl.textContent).not.toContain('Trim size');
    await openDetails(user, screen);
    const d = screen.getByTestId('geometry-details');
    expect(d).toHaveTextContent('Selected trim');
    expect(d).toHaveTextContent('TrimBox');
    expect(d).toHaveTextContent('Missing');
  });
});

describe('autofix', () => {
  const fixedAfter = inspection({ verdict: 'READY' });
  const original = new Uint8Array([1, 2, 3]);

  it('shows before / what will change / after and does NOT modify anything until Apply', async () => {
    const engine = makeEngine({ preflight: () => WITH_PLAN, verify: () => verifyResult({ before: WITH_PLAN }) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);

    const panel = await screen.findByTestId('autofix-panel');
    expect(within(panel).getByText('Before')).toBeInTheDocument();
    expect(within(panel).getByText('What will change')).toBeInTheDocument();
    expect(within(panel).getByText('After')).toBeInTheDocument();
    expect(within(panel).getByText(/Move Graphic 0\.056 in down/)).toBeInTheDocument();
    expect(engine.verifyAutofix).not.toHaveBeenCalled();
    await openDetails(user, screen);
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeDisabled();
  });

  it('Apply runs the engine autofix once; VERIFIED comes only from the engine verification result', async () => {
    const engine = makeEngine({
      preflight: () => WITH_PLAN,
      verify: () =>
        verifyResult({
          before: WITH_PLAN,
          after: fixedAfter,
          outputBytes: original,
          applied: [{ plan: WITH_PLAN.autofixPlans[0], patch: { before: { x: 0, y: 0 }, after: { x: 0, y: -4 }, dx: 0, dy: -4 } }],
          verification: 'VERIFIED',
        }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(await screen.findByRole('button', { name: /Fix automatically and re-check/ }));

    expect(engine.verifyAutofix).toHaveBeenCalledTimes(1);
    const card = await screen.findByTestId('verification-card');
    expect(card).toHaveAttribute('data-verification', 'VERIFIED');
    expect(card).toHaveAttribute('data-after', 'result');
    expect(card).toHaveTextContent(/checked again/);
    await waitFor(() => expect(verdict()).toHaveAttribute('data-verdict', 'READY'));
    expect(screen.getAllByRole('button', { name: 'Download verified PDF' })[0]).toBeEnabled();
    // viewer now shows the engine's fixed bytes
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-bytes', '3');
    expect(screen.queryByTestId('autofix-panel')).not.toBeInTheDocument();
  });

  it('a patch that is not verified is NOT presented as verified and the file stays locked', async () => {
    const stillBad = inspection({ verdict: 'NEEDS_ATTENTION', violations: [violation()] });
    const engine = makeEngine({
      preflight: () => WITH_PLAN,
      verify: () =>
        verifyResult({
          before: WITH_PLAN,
          after: stillBad,
          applied: [{ plan: WITH_PLAN.autofixPlans[0], patch: { before: { x: 0, y: 0 }, after: { x: 0, y: -4 }, dx: 0, dy: -4 } }],
          verification: 'MANUAL_REVIEW_REQUIRED',
          reasons: ['ISSUE_REMAINS'],
        }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(await screen.findByRole('button', { name: /Fix automatically and re-check/ }));

    const card = await screen.findByTestId('verification-card');
    expect(card).toHaveAttribute('data-verification', 'MANUAL_REVIEW_REQUIRED');
    expect(card).toHaveTextContent('NOT VERIFIED');
    expect(card).toHaveTextContent(/still present after the fix/);
    expect(screen.queryByText('VERIFIED')).not.toBeInTheDocument();
    await openDetails(user, screen);
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeDisabled();
  });

  it('skipped plans are explained, not hidden', async () => {
    const engine = makeEngine({
      preflight: () => WITH_PLAN,
      verify: () => verifyResult({ before: WITH_PLAN, after: WITH_PLAN, skipped: [{ plan: WITH_PLAN.autofixPlans[0], reason: 'multi_stream_contents_unsupported' }], verification: 'MANUAL_REVIEW_REQUIRED', reasons: ['AUTOFIX_NOT_SAFELY_APPLICABLE'] }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(await screen.findByRole('button', { name: /Fix automatically and re-check/ }));
    expect(await screen.findByText(/cannot edit safely/)).toBeInTheDocument();
  });

  it('autofix failure shows an error, keeps the original verdict, and never READY', async () => {
    const engine = makeEngine({
      preflight: () => WITH_PLAN,
      verify: () => {
        throw new Error('boom: rewrite failed');
      },
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(await screen.findByRole('button', { name: /Fix automatically and re-check/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/The fix failed/);
    expect(verdict()).toHaveAttribute('data-verdict', 'NEEDS_ATTENTION');
    await openDetails(user, screen);
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeDisabled();
  });
});

describe('errors', () => {
  it('an engine error shows a problem state and never READY or an empty result', async () => {
    const engine = makeEngine({
      preflight: () => {
        throw new Error('Invalid PDF structure');
      },
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('PROBLEM');
    expect(alert).toHaveTextContent(/No result is shown/);
    expect(screen.queryByTestId('verdict-card')).not.toBeInTheDocument();
    expect(screen.queryByText('READY')).not.toBeInTheDocument();
    await user.click(within(alert).getByText('Technical details'));
    expect(within(alert).getByText(/Invalid PDF structure/)).toBeVisible();
  });

  it('a failed re-run does not leave the previous READY on screen', async () => {
    const engine = makeEngine({
      preflight: (n) => {
        if (n === 1) return READY;
        throw new Error('second run failed');
      },
      verify: () => verifyResult({ before: READY }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('verdict-card');
    await user.click(screen.getByRole('radio', { name: /With bleed/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/second run failed/);
    expect(screen.queryByTestId('verdict-card')).not.toBeInTheDocument();
  });
});

describe('language and theme', () => {
  it('switches Ukrainian <-> English and persists the choice', async () => {
    const { user } = renderApp(makeEngine({ preflight: () => READY }), 'uk');
    expect(screen.getByRole('button', { name: 'Завантажити PDF' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'EN' }));
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeInTheDocument();
    expect(localStorage.getItem('kdpsafe.locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    await user.click(screen.getByRole('button', { name: 'UA' }));
    expect(screen.getByRole('button', { name: 'Завантажити PDF' })).toBeInTheDocument();
  });

  it('renders verdicts in Ukrainian without changing the engine value', async () => {
    const engine = makeEngine({ preflight: () => NEEDS_ATTENTION });
    const { user } = renderApp(engine, 'uk');
    await user.upload(screen.getByTestId('file-input'), pdfFile());
    await user.type(await screen.findByLabelText(/Ширина обрізу/), '6');
    await user.type(screen.getByLabelText(/Висота обрізу/), '9');
    await user.click(screen.getByRole('radio', { name: /Без вильоту/ }));
    await user.click(screen.getByRole('button', { name: 'Перевірити PDF' }));
    const card = await screen.findByTestId('verdict-card');
    expect(card).toHaveTextContent('ПОТРІБНА УВАГА');
    expect(card).toHaveAttribute('data-verdict', 'NEEDS_ATTENTION');
  });

  it('toggles the dark theme class on <html> and persists it', async () => {
    const { user } = renderApp(makeEngine({ preflight: () => READY }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('kdpsafe.theme')).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('acceptance-pack UX fixes', () => {
  const trimPage = (pageIndex: number, width: number, height: number) => ({
    pageIndex,
    pageNumber: pageIndex + 1,
    parity: (pageIndex % 2 === 0 ? 'odd' : 'even') as 'odd' | 'even',
    category: 'CONFLICTING_BOXES' as const,
    reasons: ['TRIM_BOX_MISMATCH'],
    rotationDeg: 0,
    effectiveSizePt: { widthPt: 432, heightPt: 648 },
    mediaBox: { x: 0, y: 0, width: 432, height: 648 },
    cropBox: { explicit: false, x: 0, y: 0, width: 432, height: 648 },
    trimBox: { explicit: true, x: 16, y: 24, width, height },
    bleedBox: { explicit: false },
  });

  it('an incorrect TrimBox shows the ACTUAL TrimBox size next to the selected trim (never the selected value as the actual one)', async () => {
    const engine = makeEngine({
      preflight: () => UNRESOLVED_30,
      assess: () =>
        assessment({
          category: 'CONFLICTING_BOXES',
          tier: 5,
          reasons: ['TRIM_BOX_MISMATCH'],
          pageSize: { widthIn: 6, heightIn: 9 },
          pages: Array.from({ length: 30 }, (_, i) => trimPage(i, 400, 600)),
        }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    const card = await screen.findByTestId('geometry-card');
    const actual = within(card).getByTestId('geometry-actual-trim');
    expect(actual).toHaveTextContent('5.556 × 8.333 in'); // 400x600 pt, from the file
    expect(actual).not.toHaveTextContent('6 × 9');
    expect(card).toHaveTextContent('Selected trim');
    expect(card).toHaveTextContent('6 × 9 in'); // the selected trim is still shown, separately
    expect(card).toHaveTextContent('TrimBox in the file');
  });

  it('TrimBox sizes that differ between pages are reported as differing, not as one made-up size', async () => {
    const engine = makeEngine({
      preflight: () => UNRESOLVED_30,
      assess: () => assessment({ category: 'CONFLICTING_BOXES', tier: 5, reasons: ['TRIM_BOX_MISMATCH'], pages: [trimPage(0, 400, 600), trimPage(1, 410, 610)] }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    expect(await screen.findByTestId('geometry-actual-trim')).toHaveTextContent('differs between pages');
  });

  it('no TrimBox in the file -> no "TrimBox in the file" size row', async () => {
    const engine = makeEngine({ preflight: () => UNRESOLVED_30, assess: () => TIER4 });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    expect(screen.queryByTestId('geometry-actual-trim')).not.toBeInTheDocument();
  });

  // crop marks: many LEM violations, each completely outside the page's explicit TrimBox
  const outsideTrim = (i: number, pageIndex: number) =>
    violation({ side: i % 2 ? 'left' : 'bottom', amountPt: 30 + i, pageIndex, rawBBoxPt: bbox(8, 100 + i, 26, 100.5 + i), visibleBBoxPt: bbox(8, 100 + i, 26, 100.5 + i), severity: 'error' });
  const markPage = (pageIndex: number) => ({ ...trimPage(pageIndex, 432, 648), trimBox: { explicit: true, x: 36, y: 36, width: 432, height: 648 } });

  it('repeated crop-mark / slug violations are shown as ONE clear message while every raw violation stays in the result and the viewer', async () => {
    const raw = [...Array.from({ length: 12 }, (_, i) => outsideTrim(i, i % 3)), violation({ pageIndex: 1, rawBBoxPt: bbox(100, 300, 200, 640), visibleBBoxPt: bbox(100, 300, 200, 640) })];
    const result = inspection({ verdict: 'MANUAL_REVIEW_REQUIRED', violations: raw });
    const engine = makeEngine({
      preflight: () => result,
      assess: () => assessment({ pages: [markPage(0), markPage(1), markPage(2)] }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    const group = await screen.findByTestId('outside-trim-group');
    expect(group).toHaveTextContent('Objects completely outside the trim area: 12 (pages 1–3)');
    expect(group).toHaveTextContent(/crop marks, registration marks or slug/);
    expect(group).toHaveTextContent(/export the PDF again without printer's marks/);
    // the 12 repeats are not listed one by one; the one object that overlaps the trim keeps its own row
    const list = screen.getByTestId('issue-list');
    expect(within(list).getAllByText(/extends .* past the safe margin/)).toHaveLength(1);
    expect(within(list).getByText(/Confirmed problems \(2\)/)).toBeInTheDocument();
    // nothing is dropped: the viewer still gets a mark for every raw violation, and the engine result is untouched
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-marks', String(raw.length));
    expect(result.violations).toHaveLength(raw.length);
    expect(verdict()).toHaveAttribute('data-verdict', 'MANUAL_REVIEW_REQUIRED');
  });

  it('a hairline mark straddling the trim edge by <= 0.5pt is grouped; an object reaching 3pt into the trim is not', async () => {
    const hair = (i: number) => violation({ pageIndex: 0, amountPt: 30, severity: 'error', rawBBoxPt: bbox(35.75, 40 + i, 36.25, 58 + i), visibleBBoxPt: bbox(35.75, 40 + i, 36.25, 58 + i) });
    const into = violation({ pageIndex: 0, amountPt: 30, severity: 'error', rawBBoxPt: bbox(33, 200, 39, 210), visibleBBoxPt: bbox(33, 200, 39, 210) });
    const result = inspection({ verdict: 'MANUAL_REVIEW_REQUIRED', violations: [hair(0), hair(1), hair(2), hair(3), into] });
    const engine = makeEngine({ preflight: () => result, assess: () => assessment({ pages: [markPage(0)] }) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    expect(await screen.findByTestId('outside-trim-group')).toHaveTextContent('Objects completely outside the trim area: 4');
    expect(within(screen.getByTestId('issue-list')).getAllByText(/extends .* past the safe margin/)).toHaveLength(1);
  });

  it('a few outside-trim objects, or no explicit TrimBox, are NOT aggregated', async () => {
    const result = inspection({ verdict: 'MANUAL_REVIEW_REQUIRED', violations: [outsideTrim(0, 0), outsideTrim(1, 0)] });
    const engine = makeEngine({ preflight: () => result, assess: () => assessment({ pages: [markPage(0)] }) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('issue-list');
    expect(screen.queryByTestId('outside-trim-group')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('issue-list')).getAllByText(/extends .* past the safe margin/)).toHaveLength(2);
  });

  it('without an explicit TrimBox nothing is called "outside the trim"', async () => {
    const result = inspection({ verdict: 'MANUAL_REVIEW_REQUIRED', violations: Array.from({ length: 6 }, (_, i) => outsideTrim(i, 0)) });
    const engine = makeEngine({ preflight: () => result, assess: () => assessment({ pages: [{ ...markPage(0), trimBox: { explicit: false } }] }) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('issue-list');
    expect(screen.queryByTestId('outside-trim-group')).not.toBeInTheDocument();
  });
});

describe('expand page (advanced repair #1)', () => {
  const ORIGINAL = pdfFile();
  const engineFor = (over: Partial<Parameters<typeof makeEngine>[0]> = {}) =>
    makeEngine({
      preflight: (n) => (n === 1 ? UNRESOLVED_30 : READY),
      assess: (n) => (n === 1 ? EXPANDABLE : assessment()),
      normalize: () => expandApplied('keep-origin', READY),
      verify: () => verifyResult({ before: READY }),
      ...over,
    });
  const panel = () => screen.getByTestId('expand-panel');
  const applyBtn = () => within(panel()).getByRole('button', { name: 'Expand page' });

  it('offers the operation with NOTHING pre-selected; nothing is written before explicit anchor + confirmation', async () => {
    const engine = engineFor();
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    expect(panel()).toHaveAttribute('data-expand-state', 'available');
    expect(panel()).toHaveTextContent('5.5 × 8.5 in');
    expect(panel()).toHaveTextContent(/does not know whether this extra white space is acceptable/);
    expect(panel()).toHaveTextContent(/not moved, scaled, cropped or rewritten/);
    for (const r of within(panel()).getAllByRole('radio')) expect(r).not.toBeChecked();
    expect(applyBtn()).toBeDisabled();

    await user.click(within(panel()).getByRole('radio', { name: /Keep existing origin/ }));
    expect(applyBtn()).toBeDisabled(); // anchor alone is not confirmation
    await user.click(within(panel()).getByRole('checkbox'));
    expect(applyBtn()).toBeEnabled();
    expect(engine.normalizePageGeometry).not.toHaveBeenCalled();
  });

  it('KEEP-ORIGIN: calls the engine with the explicit anchor + confirmation, shows the engine AFTER READY, neutral card, original kept for undo', async () => {
    const engine = engineFor();
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    await user.click(within(panel()).getByRole('radio', { name: /Keep existing origin/ }));
    await user.click(within(panel()).getByRole('button', { name: 'Review change' }));
    expect(screen.getByTestId('expand-review')).toHaveTextContent('After: 6 × 9 in');
    expect(screen.getByTestId('expand-review')).toHaveTextContent('Before: 5.5 × 8.5 in');
    await user.click(within(panel()).getByRole('checkbox'));
    await user.click(applyBtn());

    await waitFor(() => expect(engine.normalizePageGeometry).toHaveBeenCalledTimes(1));
    const [bytes, options] = engine.normalizePageGeometry.mock.calls[0];
    expect(bytes.length).toBe(new Uint8Array(await ORIGINAL.arrayBuffer()).length);
    expect(options.expandPage).toEqual({ anchor: 'keep-origin', confirmed: true });
    expect(options.userIntent.trimSize).toEqual({ widthIn: 6, heightIn: 9 });

    await waitFor(() => expect(verdict()).toHaveAttribute('data-verdict', 'READY'));
    const card = screen.getByTestId('geometry-card');
    expect(card).toHaveAttribute('data-geometry-state', 'applied');
    expect(card).toHaveTextContent('Pages expanded to 6 × 9 in on 30 page(s); the existing origin was kept');
    expect(card.outerHTML).not.toMatch(/status-ready/);
    expect(card).not.toHaveTextContent('✓');
    expect(card).toHaveTextContent(/Only page boxes were changed/);
    await screen.findByTestId('verification-card');
    // the engine verified the NEW bytes
    expect(engine.verifyAutofix.mock.calls[0][0].length).toBe(5);

    // undo: back to the user's original bytes, re-analysed from scratch
    await user.click(within(card).getByRole('button', { name: 'Restore original file' }));
    await waitFor(() => expect(engine.runPreflight).toHaveBeenCalledTimes(2));
    expect(engine.runPreflight.mock.calls[1][0].length).toBe(engine.runPreflight.mock.calls[0][0].length);
  });

  it('keep-origin is the ONLY anchor offered: no centered option, and the copy says the origin is kept and nothing is moved or scaled', async () => {
    const { user } = renderApp(engineFor());
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    expect(within(panel()).getAllByRole('radio')).toHaveLength(1);
    expect(within(panel()).getByRole('radio', { name: /Keep existing origin/ })).toBeInTheDocument();
    expect(panel()).not.toHaveTextContent(/center|centre/i);
    expect(panel()).toHaveTextContent(/existing origin \(lower-left corner\) is kept/);
    expect(panel()).toHaveTextContent(/not moved, scaled, cropped or rewritten/);
    expect(panel()).toHaveTextContent(/added on the right and .* at the top/);
    expect(panel()).toHaveTextContent(/Nothing is moved or scaled/);
  });

  it('a negative MediaBox origin is reported as unsupported and cannot be applied', async () => {
    const offer = expandOffer({ eligible: false, reasons: ['NEGATIVE_MEDIA_BOX_ORIGIN'], previews: null });
    const engine = engineFor({ assess: () => assessment({ ...EXPANDABLE, expand: offer }) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    expect(panel()).toHaveAttribute('data-expand-state', 'unavailable');
    expect(panel()).toHaveTextContent(/negative MediaBox origin, which is not supported/);
    expect(within(panel()).queryByRole('button')).not.toBeInTheDocument();
    expect(engine.normalizePageGeometry).not.toHaveBeenCalled();
  });

  it('AFTER not READY (engine fails closed): no success, original stays, the real reason is shown', async () => {
    const engine = engineFor({
      normalize: () => ({
        ...expandApplied('keep-origin', NEEDS_ATTENTION),
        applied: false,
        outputBytes: new Uint8Array([1, 2, 3, 4, 5]),
        safety: { ok: false, checks: [{ id: 'AFTER_PREFLIGHT_READY', ok: false }], failure: 'AFTER_NOT_READY' },
        expand: undefined,
      }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    await user.click(within(panel()).getByRole('radio', { name: /Keep existing origin/ }));
    await user.click(within(panel()).getByRole('checkbox'));
    await user.click(applyBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The expanded file is not READY');
    expect(alert).toHaveTextContent(/nothing was applied and your original file is still in use/);
    expect(alert).toHaveTextContent('AFTER_NOT_READY');
    // still the ORIGINAL working file: manual verdict, the card offers the operation again, no applied state, no download
    expect(verdict()).toHaveAttribute('data-verdict', 'MANUAL_REVIEW_REQUIRED');
    expect(screen.getByTestId('geometry-card')).toHaveAttribute('data-geometry-state', 'manual');
    expect(screen.queryByRole('button', { name: 'Download verified PDF' })).not.toBeInTheDocument();
    expect(engine.verifyAutofix).not.toHaveBeenCalled();
  });

  it('defense in depth: even if the engine claimed success, a non-READY AFTER is never adopted', async () => {
    const engine = engineFor({ normalize: () => expandApplied('keep-origin', NEEDS_ATTENTION) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    await user.click(within(panel()).getByRole('radio', { name: /Keep existing origin/ }));
    await user.click(within(panel()).getByRole('checkbox'));
    await user.click(applyBtn());
    await screen.findByRole('alert');
    expect(screen.getByTestId('geometry-card')).toHaveAttribute('data-geometry-state', 'manual');
    expect(verdict()).toHaveAttribute('data-verdict', 'MANUAL_REVIEW_REQUIRED');
  });

  it('a safety failure inside the engine is shown as an error; the file is not modified', async () => {
    const engine = engineFor({
      normalize: () => ({ ...expandApplied('keep-origin', READY), applied: false, after: null, expand: undefined, safety: { ok: false, checks: [{ id: 'CONTENT_STREAMS_CHANGED', ok: false }], failure: 'CONTENT_STREAMS_CHANGED' } }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    await user.click(within(panel()).getByRole('radio', { name: /Keep existing origin/ }));
    await user.click(within(panel()).getByRole('checkbox'));
    await user.click(applyBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your file was not modified.');
    expect(alert).toHaveTextContent('CONTENT_STREAMS_CHANGED');
    expect(screen.getByTestId('geometry-card')).toHaveAttribute('data-geometry-state', 'manual');
  });

  it('not eligible: the reasons are listed, there is no way to apply', async () => {
    const offer = expandOffer({ eligible: false, reasons: ['SIGNED', 'HAS_FORMS', 'ROTATED_PAGE', 'MIXED_PAGE_SIZES'], previews: null });
    const engine = engineFor({ assess: () => assessment({ ...EXPANDABLE, expand: offer }) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    expect(panel()).toHaveAttribute('data-expand-state', 'unavailable');
    expect(panel()).toHaveTextContent('Expand page is not available for this file');
    expect(panel()).toHaveTextContent(/digitally signed/);
    expect(panel()).toHaveTextContent(/form fields/);
    expect(panel()).toHaveTextContent(/rotated/);
    expect(panel()).toHaveTextContent(/different sizes/);
    expect(within(panel()).queryByRole('button')).not.toBeInTheDocument();
    expect(within(panel()).queryByRole('radio')).not.toBeInTheDocument();
    expect(engine.normalizePageGeometry).not.toHaveBeenCalled();
  });

  it('no offer when no page is smaller than the selected size (A4 stays a plain explanation)', async () => {
    const engine = engineFor({ assess: () => TIER4 });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('geometry-card');
    expect(screen.queryByTestId('expand-panel')).not.toBeInTheDocument();
  });

  it('is available in Ukrainian', async () => {
    const { user } = renderApp(engineFor(), 'uk');
    await user.upload(screen.getByTestId('file-input'), pdfFile());
    await user.type(await screen.findByLabelText(/Ширина/), '6');
    await user.type(screen.getByLabelText(/Висота/), '9');
    await user.click(screen.getByRole('radio', { name: /Без вильоту/ }));
    await user.click(screen.getByRole('button', { name: 'Перевірити PDF' }));
    await screen.findByTestId('geometry-card');
    expect(panel()).toHaveTextContent('Розширити сторінку до вибраного розміру');
    expect(panel()).not.toHaveTextContent(/центр/i);
    expect(panel()).toHaveTextContent('Це ваше рішення.');
    expect(within(panel()).getByRole('radio', { name: /Зберегти наявний початок координат/ })).toBeInTheDocument();
  });
});
