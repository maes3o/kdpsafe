import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/context';
import { useUnit } from '../units/context';
import type { PageGeometryAssessment } from '../engine/types';
import type { NormalizationRecord } from '../workspace/useWorkspace';
import { geometryReasonLabel, safetyCheckLabel } from '../i18n/labels';
import { btnPrimary, btnSecondary, GLYPH, TONE, sectionTitle } from './ui';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/**
 * "Page size" card: what the PDF's page boxes say versus what the user
 * selected, and the single SAFEST action for that situation. Only
 * metadata-only plans can be applied (Tier 1/2); everything else is
 * explained and left manual. Page SIZE and TRIM are shown as different
 * things on purpose.
 */
export function PageGeometryCard({
  geometry,
  normalization,
  disabled,
  onApply,
  onUndo,
}: {
  geometry: PageGeometryAssessment;
  normalization: NormalizationRecord | null;
  disabled: boolean;
  onApply: () => void;
  onUndo: () => void;
}) {
  const { t, formatNumber } = useI18n();
  const { formatPair } = useUnit();
  const [review, setReview] = useState(false);

  // ---- after an applied normalization: confirm + undo ------------------
  if (normalization) {
    return (
      <section data-testid="geometry-card" data-geometry-state="applied" className={`rounded-2xl border p-4 shadow-card ${TONE.ready.border} ${TONE.ready.soft}`}>
        <p className={`flex items-center gap-2 text-sm font-extrabold uppercase tracking-wider ${TONE.ready.text}`}>
          <span aria-hidden="true" className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white ${TONE.ready.solid}`}>
            {GLYPH.ready}
          </span>
          {t('geoApplied', { n: normalization.pagesChanged })}
        </p>
        <p className="mt-2 text-sm">{t('geoAppliedNote')}</p>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer font-medium text-accent">{t('geoChecks')}</summary>
          <ul className="mt-1.5 space-y-1 text-xs">
            {normalization.checks.map((c) => (
              <li key={c.id}>
                <span aria-hidden="true" className={c.ok ? TONE.ready.text : TONE.error.text}>
                  {c.ok ? '✓' : '×'}{' '}
                </span>
                {safetyCheckLabel(t, c.id)}
              </li>
            ))}
          </ul>
        </details>
        <button type="button" className={`${btnSecondary} mt-3`} onClick={onUndo} disabled={disabled}>
          {t('geoUndo')}
        </button>
      </section>
    );
  }

  const { tier, plan } = geometry;
  if (tier === 0) return null; // nothing to repair: explicit, matching TrimBox

  const pageSize = geometry.pageSize ? formatPair(geometry.pageSize.widthIn, geometry.pageSize.heightIn) : '–';
  const selected = formatPair(geometry.selectedTrim.widthIn, geometry.selectedTrim.heightIn);
  const trimState =
    geometry.trimBox === 'explicit' ? t('geoTrimBoxExplicit') : geometry.trimBox === 'mixed' ? t('geoTrimBoxMixed') : t('geoTrimBoxMissing');

  const summary = (
    <dl className="mt-3 space-y-1.5 rounded-xl bg-bg-panel p-3">
      <Row label={t('geoCurrent')}>{pageSize}</Row>
      <Row label={t('geoSelected')}>{selected}</Row>
      <Row label={t('geoTrimBox')}>{trimState}</Row>
    </dl>
  );

  // ---- Tier 1 / 2 with a plan: the only automatic actions ------------
  if (plan) {
    const isBleed = plan.kind === 'DEFINE_TRIM_BOX_FROM_BLEED';
    const odd = plan.changes[0];
    const even = plan.changes[1];
    return (
      <section data-testid="geometry-card" data-geometry-state="plan" data-tier={tier} aria-labelledby="geo-title" className="rounded-2xl border border-border bg-bg p-4 shadow-card">
        <h3 id="geo-title" className="font-semibold">
          {t('geoTitle')}
        </h3>
        <p className="mt-1 text-sm">{t(isBleed ? 'geoIntroBleed' : 'geoIntroMatches')}</p>
        {summary}

        <p className={`${sectionTitle} mt-4`}>{t('geoSafeAction')}</p>
        <p className="text-sm font-semibold">{t(isBleed ? 'geoActionDefineTrimBox' : 'geoActionAddTrimBox')}</p>
        <p className="mt-0.5 text-xs text-ink-muted">{t('geoSafeLine')}</p>

        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className={sectionTitle}>{t('geoWillChange')}</dt>
            <dd>{t('geoChangeText', { n: plan.changes.length })}</dd>
          </div>
          <div>
            <dt className={sectionTitle}>{t('geoWillNot')}</dt>
            <dd>{t('geoWillNotText')}</dd>
          </div>
        </dl>

        {review && (
          <div data-testid="geometry-review" className="mt-3 space-y-2 rounded-xl border border-border p-3 text-xs">
            <p>
              <span className={sectionTitle}>{t('autofixBefore')}</span>
              <span className="block font-mono">{t('geoBeforeTrim')}</span>
            </p>
            <p>
              <span className={sectionTitle}>{t('autofixAfter')}</span>
              <span className="block font-mono">{t('geoAfterTrim', { size: selected })}</span>
              {[odd, even].filter(Boolean).map((c) => (
                <span key={c.pageIndex} className="block font-mono text-ink-muted">
                  {t('geoPlanRow', { page: c.pageIndex + 1, x: formatNumber(c.set.trimBox.x, 2), y: formatNumber(c.set.trimBox.y, 2) })}
                </span>
              ))}
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={btnSecondary} onClick={() => setReview((v) => !v)} aria-expanded={review}>
            {review ? t('geoHideReview') : t('geoReview')}
          </button>
          <button type="button" className={btnPrimary} onClick={onApply} disabled={disabled}>
            {t(isBleed ? 'geoApplyDefine' : 'geoApplyAdd')}
          </button>
        </div>
      </section>
    );
  }

  // ---- everything else: explained, never auto-fixed -------------------
  const needsDirection = tier === 2 && geometry.reasons.includes('READING_DIRECTION_REQUIRED');
  const tone = needsDirection ? TONE.review : TONE.attention;
  const title =
    tier === 3 ? t('geoManualSimilarTitle') : tier === 4 ? t('geoManualDifferentTitle') : tier === 2 ? t('geoActionDefineTrimBox') : t('geoDoNotTouchTitle');
  const body = tier === 3 ? t('geoManualSimilar') : tier === 4 ? t('geoManualDifferent') : needsDirection ? t('geoNeedDirection') : null;
  const reasons = geometry.reasons.filter((r) => r !== 'READING_DIRECTION_REQUIRED');
  return (
    <section data-testid="geometry-card" data-geometry-state="manual" data-tier={tier} aria-labelledby="geo-title" className={`rounded-2xl border p-4 shadow-card ${tone.border} ${tone.soft}`}>
      <p id="geo-title" className={`flex items-center gap-2 text-sm font-extrabold ${tone.text}`}>
        <span aria-hidden="true" className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white ${tone.solid}`}>
          {needsDirection ? GLYPH.review : GLYPH.attention}
        </span>
        {title}
      </p>
      {body && <p className="mt-2 text-sm">{body}</p>}
      {reasons.length > 0 && (
        <ul className="mt-2 list-inside list-disc text-sm">
          {reasons.map((r) => (
            <li key={r}>{geometryReasonLabel(t, r)}</li>
          ))}
        </ul>
      )}
      {summary}
      {(tier === 3 || tier === 4) && <p className="mt-3 text-xs text-ink-muted">{t('geoManualHint')}</p>}
    </section>
  );
}
