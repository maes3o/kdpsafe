import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import App from '../App';
import { I18nProvider } from '../i18n/context';
import { ThemeProvider } from '../theme/context';
import type { EngineApi } from '../engine/api';
import type { InspectionResult, PreflightOptions, VerifyAutofixResult } from '../engine/types';

export function makeEngine(opts: {
  preflight: (call: number) => InspectionResult | Promise<InspectionResult>;
  verify?: (call: number) => VerifyAutofixResult | Promise<VerifyAutofixResult>;
}) {
  let p = 0;
  let v = 0;
  const engine = {
    runPreflight: vi.fn(async (_bytes: Uint8Array, _options: PreflightOptions) => opts.preflight(++p)),
    verifyAutofix: vi.fn(async (_bytes: Uint8Array, _options: PreflightOptions) => {
      if (!opts.verify) throw new Error('verifyAutofix not expected');
      return opts.verify(++v);
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
  await user.selectOptions(screen.getByLabelText(/^Bleed/), settings.bleed ?? 'no');
  await user.click(screen.getByRole('button', { name: 'Run preflight' }));
}
