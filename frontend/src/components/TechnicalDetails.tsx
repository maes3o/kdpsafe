import { useI18n } from '../i18n/context';
import type { InspectionResult, VerifyAutofixResult } from '../engine/types';

/** Secondary layer: raw engine codes and diagnostics, untranslated. */
export function TechnicalDetails({ inspection, fix }: { inspection: InspectionResult; fix: VerifyAutofixResult | null }) {
  const { t } = useI18n();
  const data = {
    verdict: inspection.verdict,
    geometryVerdict: inspection.geometryVerdict,
    integrity: inspection.integrity ? { impact: inspection.integrity.impact, summary: inspection.integrity.summary } : undefined,
    geometry: { status: inspection.geometry.status, confidence: inspection.geometry.confidence },
    marginsStatus: inspection.categories.margins.status,
    manualReviewReasons: inspection.categories.margins.manualReview.map((e) => e.reason),
    diagnostics: inspection.categories.margins.diagnostics.map((d) => `p${d.pageIndex + 1} ${d.code}: ${d.message}`),
    verification: fix ? { verification: fix.verification, reasons: fix.reasons, after: fix.after === null ? null : fix.after.verdict } : undefined,
  };
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-ink-muted">{t('technicalDetails')}</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-panel p-2 font-mono text-xs text-ink-muted">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}
