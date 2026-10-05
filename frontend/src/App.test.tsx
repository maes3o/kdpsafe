import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { makeEngine, renderApp, uploadAndRun, pdfFile } from './test/harness';
import { AMBIGUOUS, MANUAL, NEEDS_ATTENTION, READY, WITH_PLAN, inspection, verifyResult, violation } from './test/fixtures';

vi.mock('./components/viewer/PdfViewer', async () => await import('./test/viewerMock'));

const verdict = () => screen.getByTestId('verdict-card');

describe('empty state', () => {
  it('shows the value proposition, an accessible dropzone and the privacy note', () => {
    renderApp(makeEngine({ preflight: () => READY }));
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a PDF' })).toBeInTheDocument();
    expect(screen.getByTestId('dropzone')).toBeInTheDocument();
    expect(screen.getByText(/not sent to a server/)).toBeInTheDocument();
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
    const run = await screen.findByRole('button', { name: 'Run preflight' });
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

    await user.selectOptions(screen.getByLabelText(/^Bleed/), 'yes');
    await waitFor(() => expect(engine.runPreflight).toHaveBeenCalledTimes(2));
    expect(engine.runPreflight.mock.calls[1][1].userIntent.bleed).toBe(true);
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
    expect(screen.getByText('Partly resolved')).toBeInTheDocument();
    expect(screen.getByText(/not a problem by itself/)).toBeInTheDocument();
    expect(screen.queryByText('PROBLEM')).not.toBeInTheDocument();

    const card = await screen.findByTestId('verification-card');
    expect(card).toHaveAttribute('data-verification', 'VERIFIED');
    expect(card).toHaveAttribute('data-after', 'null');
    expect(card).toHaveTextContent(/already READY/);
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeEnabled();
  });

  it('READY: the PDF is not downloadable until the engine reports VERIFIED', async () => {
    let release: (r: ReturnType<typeof verifyResult>) => void = () => {};
    const engine = makeEngine({ preflight: () => READY, verify: () => new Promise((res) => (release = res)) });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await screen.findByTestId('verdict-card');
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeDisabled();
    release(verifyResult({ before: READY }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeEnabled());
  });

  it('NEEDS_ATTENTION: counts, grouped issues, page, side and amount', async () => {
    const engine = makeEngine({ preflight: () => NEEDS_ATTENTION });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);

    expect(await screen.findByTestId('verdict-card')).toHaveAttribute('data-verdict', 'NEEDS_ATTENTION');
    expect(screen.getByText('2 confirmed problem(s)')).toBeInTheDocument();
    const list = screen.getByTestId('issue-list');
    expect(within(list).getByText('Page 3')).toBeInTheDocument();
    expect(within(list).getByText(/Graphic extends 0\.056 in past the safe margin \(top\)/)).toBeInTheDocument();
    expect(within(list).getByText(/Text extends 0\.139 in past the safe margin \(left\)/)).toBeInTheDocument();
    // not READY => no verified download is offered
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeDisabled();
  });

  it('MANUAL_REVIEW_REQUIRED: says it cannot decide automatically, not that the PDF is wrong', async () => {
    const engine = makeEngine({ preflight: () => MANUAL });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);

    expect(await screen.findByTestId('verdict-card')).toHaveAttribute('data-verdict', 'MANUAL_REVIEW_REQUIRED');
    expect(verdict()).toHaveTextContent(/cannot safely decide or fix this automatically/);
    expect(verdict()).toHaveTextContent(/does not necessarily mean the PDF is wrong/);
    expect(verdict()).not.toHaveTextContent(/confirmed problem/);
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
    expect(screen.getByLabelText(/^Reading direction/)).toHaveValue('rtl');
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
    await user.click(await screen.findByRole('button', { name: /Apply fix and re-check/ }));

    expect(engine.verifyAutofix).toHaveBeenCalledTimes(1);
    const card = await screen.findByTestId('verification-card');
    expect(card).toHaveAttribute('data-verification', 'VERIFIED');
    expect(card).toHaveAttribute('data-after', 'result');
    expect(card).toHaveTextContent(/checked again/);
    await waitFor(() => expect(verdict()).toHaveAttribute('data-verdict', 'READY'));
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeEnabled();
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
    await user.click(await screen.findByRole('button', { name: /Apply fix and re-check/ }));

    const card = await screen.findByTestId('verification-card');
    expect(card).toHaveAttribute('data-verification', 'MANUAL_REVIEW_REQUIRED');
    expect(card).toHaveTextContent('NOT VERIFIED');
    expect(card).toHaveTextContent(/still present after the fix/);
    expect(screen.queryByText('VERIFIED')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download verified PDF' })).toBeDisabled();
  });

  it('skipped plans are explained, not hidden', async () => {
    const engine = makeEngine({
      preflight: () => WITH_PLAN,
      verify: () => verifyResult({ before: WITH_PLAN, after: WITH_PLAN, skipped: [{ plan: WITH_PLAN.autofixPlans[0], reason: 'multi_stream_contents_unsupported' }], verification: 'MANUAL_REVIEW_REQUIRED', reasons: ['AUTOFIX_NOT_SAFELY_APPLICABLE'] }),
    });
    const { user } = renderApp(engine);
    await uploadAndRun(user, screen);
    await user.click(await screen.findByRole('button', { name: /Apply fix and re-check/ }));
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
    await user.click(await screen.findByRole('button', { name: /Apply fix and re-check/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/The fix failed/);
    expect(verdict()).toHaveAttribute('data-verdict', 'NEEDS_ATTENTION');
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
    await user.selectOptions(screen.getByLabelText(/^Bleed/), 'yes');
    expect(await screen.findByRole('alert')).toHaveTextContent(/second run failed/);
    expect(screen.queryByTestId('verdict-card')).not.toBeInTheDocument();
  });
});

describe('language and theme', () => {
  it('switches Ukrainian <-> English and persists the choice', async () => {
    const { user } = renderApp(makeEngine({ preflight: () => READY }), 'uk');
    expect(screen.getByRole('button', { name: 'Обрати PDF' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'EN' }));
    expect(screen.getByRole('button', { name: 'Choose a PDF' })).toBeInTheDocument();
    expect(localStorage.getItem('kdpsafe.locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    await user.click(screen.getByRole('button', { name: 'UA' }));
    expect(screen.getByRole('button', { name: 'Обрати PDF' })).toBeInTheDocument();
  });

  it('renders verdicts in Ukrainian without changing the engine value', async () => {
    const engine = makeEngine({ preflight: () => NEEDS_ATTENTION });
    const { user } = renderApp(engine, 'uk');
    await user.upload(screen.getByTestId('file-input'), pdfFile());
    await user.type(await screen.findByLabelText(/Ширина обрізу/), '6');
    await user.type(screen.getByLabelText(/Висота обрізу/), '9');
    await user.selectOptions(screen.getByLabelText(/^Виліт/), 'no');
    await user.click(screen.getByRole('button', { name: 'Запустити перевірку' }));
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
