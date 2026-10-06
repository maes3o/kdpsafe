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
  return {
    tool: 'KDPSafe',
    scope: 'Phase 1: margins and bleed only',
    generatedAt: new Date().toISOString(),
    file: fileName,
    userIntent: intent,
    inspection,
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
