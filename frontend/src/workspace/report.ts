/**
 * Report = the engine's own results, serialised. No second compliance or
 * report model: `before`/`after`/`verification` are exactly what the engine
 * returned (byte buffers excluded).
 */

import type { InspectionResult, PageGeometryAssessment, UserIntent, VerifyAutofixResult } from '../engine/types';
import type { NormalizationRecord } from './useWorkspace';

export function buildReport(args: {
  fileName: string;
  intent: UserIntent;
  inspection: InspectionResult;
  fix: VerifyAutofixResult | null;
  geometry?: PageGeometryAssessment | null;
  normalization?: NormalizationRecord | null;
}) {
  const { fileName, intent, inspection, fix, geometry = null, normalization = null } = args;
  const checks = inspection.integrity?.checks ?? [];
  return {
    tool: 'KDPSafe',
    scope: 'Margins and bleed (Phase 1) plus read-only PDF integrity checks (Phase 2A); colour and transparency are not checked',
    generatedAt: new Date().toISOString(),
    file: fileName,
    userIntent: intent,
    inspection,
    // Phase 2A, grouped by what each finding means. Manual-review findings are NOT failures:
    // KDPSafe could not decide them from the PDF alone.
    phase2a: {
      deterministicBlockers: checks.filter((c) => c.impact === 'BLOCKING'),
      manualReview: checks.filter((c) => c.impact === 'MANUAL_REVIEW'),
      informational: checks.filter((c) => c.impact === 'NONE'),
      note: 'Findings are exactly what the engine returned. Manual-review findings are not failures.',
    },
    pageGeometry: { assessment: geometry, normalization },
    autofix: fix
      ? {
          verification: fix.verification,
          reasons: fix.reasons,
          applied: fix.applied,
          skipped: fix.skipped,
          before: fix.before,
          after: fix.after,
        }
      : null,
  };
}

export function downloadBlob(data: BlobPart, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '') || 'document';
}
