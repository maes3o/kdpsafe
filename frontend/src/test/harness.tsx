import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import App from '../App';
import { I18nProvider } from '../i18n/context';
import { ThemeProvider } from '../theme/context';
import type { EngineApi } from '../engine/api';
import type { InspectionResult, NormalizationResult, PageGeometryAssessment, PreflightOptions, VerifyAutofixResult } from '../engine/types';
import { assessment } from './fixtures';

export function makeEngine(opts: {
  preflight: (call: number) => InspectionResult | Promise<InspectionResult>;
  verify?: (call: number) => VerifyAutofixResult | Promise<VerifyAutofixResult>;
  /** Page-geometry analysis; defaults to "explicit matching TrimBox, nothing to do". */
  assess?: (call: number) => PageGeometryAssessment | Promise<PageGeometryAssessment>;
  normalize?: (call: number) => NormalizationResult | Promise<NormalizationResult>;
}) {
  let p = 0;
  let v = 0;
  let a = 0;
  let nz = 0;
  const engine = {
    runPreflight: vi.fn(async (_bytes: Uint8Array, _options: PreflightOptions) => opts.preflight(++p)),
    verifyAutofix: vi.fn(async (_bytes: Uint8Array, _options: PreflightOptions) => {
      if (!opts.verify) throw new Error('verifyAutofix not expected');
      return opts.verify(++v);
    }),
    assessPageGeometry: vi.fn(async (_bytes: Uint8Array, _options: PreflightOptions) => (opts.assess ? opts.assess(++a) : assessment())),
    normalizePageGeometry: vi.fn(async (_bytes: Uint8Array, _options: PreflightOptions) => {
      if (!opts.normalize) throw new Error('normalizePageGeometry not expected');
      return opts.normalize(++nz);
    }),
    dispose: vi.fn(),
  } satisfies EngineApi;
  return engine;
}

export function renderApp(engine: EngineApi, locale: 'en' | 'uk' = 'en') {
  const user = userEvent.setup();
  const utils = render(
    <ThemeProvider initial="light">
      <I18nProvider initial={locale}>
        <App createEngine={() => engine} />
      </I18nProvider>
    </ThemeProvider>
  );
  return { user, ...utils };
}

export const pdfFile = (name = 'book.pdf') => new File(['%PDF-1.4\nfake body for ui test'], name, { type: 'application/pdf' });

/** Upload a file, fill the manuscript settings, and run. */
export async function uploadAndRun(
  user: ReturnType<typeof userEvent.setup>,
  screen: typeof import('@testing-library/react').screen,
  settings: { w?: string; h?: string; bleed?: 'yes' | 'no' } = {}
) {
  await user.upload(screen.getByTestId('file-input'), pdfFile());
  await user.type(await screen.findByLabelText(/Trim width/), settings.w ?? '6');
  await user.type(screen.getByLabelText(/Trim height/), settings.h ?? '9');
  await user.click(screen.getByRole('radio', { name: settings.bleed === 'yes' ? /With bleed/ : /No bleed/ }));
  await user.click(screen.getByRole('button', { name: 'Check PDF' }));
}

/** Open the Details tab (where geometry, the locked download and technical info live). */
export async function openDetails(user: ReturnType<typeof userEvent.setup>, screen: typeof import('@testing-library/react').screen) {
  await user.click(screen.getByRole('tab', { name: /Details/ }));
}
