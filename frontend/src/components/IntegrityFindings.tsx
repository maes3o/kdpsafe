import { useI18n } from '../i18n/context';
import type { IntegrityFinding, IntegrityResult, IntegrityStatus } from '../engine/types';
import { formatPageRanges, integrityExplanation, integrityTitle } from '../i18n/labels';
import { StatusIcon } from './StatusIcon';
import { sectionTitle, type Tone } from './ui';

const TONE_OF: Record<IntegrityStatus, Tone> = { FAIL: 'error', WARNING: 'review', UNKNOWN: 'review', PASS: 'ready' };

/** Findings that need the user: deterministic blockers first, then manual-review ones. */
export function actionableFindings(integrity: IntegrityResult): IntegrityFinding[] {
  const rank = (f: IntegrityFinding) => (f.impact === 'BLOCKING' ? 0 : 1);
  return integrity.checks.filter((f) => f.impact !== 'NONE').sort((a, b) => rank(a) - rank(b));
}

function Finding({ f }: { f: IntegrityFinding }) {
  const { t } = useI18n();
  const status = t(`integrityStatus${f.status}`);
  const hasDetails = Object.keys(f.details ?? {}).length > 0 || (f.diagnostics?.length ?? 0) > 0 || !!f.evidence;
  return (
    <li
      data-testid="integrity-finding"
      data-check-id={f.id}
      data-status={f.status}
      data-impact={f.impact}
      className="rounded-2xl border border-border bg-bg p-3 shadow-card"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusIcon tone={TONE_OF[f.status]} label={status} className="text-sm font-bold" />
        <span className="text-sm font-semibold">{integrityTitle(t, f.id)}</span>
      </p>
      <p className="mt-1.5 text-sm">{integrityExplanation(t, f)}</p>
      {f.pages && f.pages.length > 0 && (
        <p className="mt-1 text-sm font-semibold">{t('integrityPages', { pages: formatPageRanges(f.pages) })}</p>
      )}
      {hasDetails && (
        <details className="mt-1.5 text-xs">
          <summary className="cursor-pointer text-ink-muted">{t('integrityTechnical')}</summary>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-panel p-2 font-mono text-[11px] text-ink-muted">
            {JSON.stringify({ code: f.code, message: f.message, details: f.details, evidence: f.evidence, diagnostics: f.diagnostics }, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

/**
 * Phase 2A: the engine's integrity findings, shown as the engine returned
 * them (status, code, pages, evidence). The UI never decides a policy and
 * never turns a finding into a pass: it only localizes and lays out.
 */
export function IntegrityFindings({ integrity }: { integrity: IntegrityResult }) {
  const { t } = useI18n();
  const actionable = actionableFindings(integrity);
  const passed = integrity.checks.filter((f) => f.impact === 'NONE');
  return (
    <section aria-labelledby="integrity-title" className="space-y-3" data-testid="integrity-section">
      <h3 id="integrity-title" className={sectionTitle}>
        {t('integrityTitle')}
      </h3>
      <p className="text-xs text-ink-muted">{t('integrityIntro')}</p>
      {actionable.length > 0 && (
        <ul className="space-y-2">
          {actionable.map((f) => (
            <Finding key={f.id} f={f} />
          ))}
        </ul>
      )}
      {passed.length > 0 && (
        <details className="rounded-2xl border border-border bg-bg p-3 text-sm shadow-card" data-testid="integrity-passed">
          <summary className="cursor-pointer font-semibold">{t('integrityPassedTitle', { n: passed.length })}</summary>
          <ul className="mt-2 space-y-1.5">
            {passed.map((f) => (
              <li key={f.id} data-testid="integrity-finding" data-check-id={f.id} data-status={f.status} className="flex flex-wrap items-baseline gap-x-2">
                <StatusIcon tone="ready" label={t('integrityStatusPASS')} className="text-xs font-bold" />
                <span className="font-medium">{integrityTitle(t, f.id)}</span>
                <span className="text-xs text-ink-muted">{integrityExplanation(t, f)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
