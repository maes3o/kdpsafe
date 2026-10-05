import { useI18n } from '../i18n/context';
import type { AutofixPlan, BBoxPt } from '../engine/types';
import { formatInches, objectLabel } from '../i18n/labels';
import { planId } from '../workspace/issues';
import { btnPrimary, sectionTitle } from './ui';

const EPS_PT = 0.005;

function bboxText(b: BBoxPt, f: (v: number, m?: number) => string, unit: string) {
  return `x ${f(b.minX, 1)}–${f(b.maxX, 1)} · y ${f(b.minY, 1)}–${f(b.maxY, 1)} ${unit}`;
}

/** BEFORE -> WHAT WILL CHANGE -> APPLY. Shows the engine's plans; nothing is
 * modified until the user presses Apply. */
export function AutofixPanel({
  plans,
  activeId,
  onFocusPlan,
  onApply,
  disabled,
}: {
  plans: AutofixPlan[];
  activeId: string | null;
  onFocusPlan: (id: string, plan: AutofixPlan) => void;
  onApply: () => void;
  disabled: boolean;
}) {
  const { t, formatNumber } = useI18n();
  const applyableCount = plans.filter((p) => p.applyable).length;

  function shiftText(plan: AutofixPlan): string {
    const parts: string[] = [];
    const { dx, dy } = plan.shift;
    const amt = (v: number) => formatInches(v, formatNumber, t('inchesShort'));
    if (Math.abs(dx) > EPS_PT) parts.push(t(dx > 0 ? 'shiftRight' : 'shiftLeft', { amount: amt(dx) }));
    if (Math.abs(dy) > EPS_PT) parts.push(t(dy > 0 ? 'shiftUp' : 'shiftDown', { amount: amt(dy) }));
    return parts.join(` ${t('shiftAnd')} `);
  }

  return (
    <section data-testid="autofix-panel" aria-labelledby="autofix-title" className="space-y-3 rounded-lg border border-border-strong p-4">
      <div>
        <h3 id="autofix-title" className="font-semibold">
          {t('autofixTitle')}
        </h3>
        {applyableCount > 0 && <p className="mt-1 text-sm text-ink-muted">{t('autofixIntro', { n: applyableCount })}</p>}
      </div>

      <ul className="space-y-2">
        {plans.map((plan, i) => {
          const id = planId(i);
          const active = id === activeId;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onFocusPlan(id, plan)}
                aria-pressed={active}
                className={`w-full rounded-md border p-3 text-left ${active ? 'border-accent bg-bg-hover' : 'border-border hover:bg-bg-hover'}`}
              >
                <span className="block text-sm font-medium">
                  {t('pageNumber', { page: plan.pageIndex + 1 })} · {objectLabel(t, plan.type)}
                </span>
                {plan.applyable ? (
                  <dl className="mt-2 space-y-1.5 text-sm">
                    <div>
                      <dt className={sectionTitle}>{t('autofixBefore')}</dt>
                      <dd className="text-ink-muted">
                        {t('autofixBeforeLine')}
                        <span className="block font-mono text-xs">{bboxText(plan.visibleBBoxPt, formatNumber, t('pointsShort'))}</span>
                      </dd>
                    </div>
                    <div>
                      <dt className={sectionTitle}>{t('autofixChange')}</dt>
                      <dd className="font-medium">
                        {t('autofixMove', { object: objectLabel(t, plan.type), shift: shiftText(plan) })}
                        <span className="block font-mono text-xs font-normal text-ink-muted">
                          dx {formatNumber(plan.shift.dx, 2)} · dy {formatNumber(plan.shift.dy, 2)} {t('pointsShort')}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className={sectionTitle}>{t('autofixAfter')}</dt>
                      <dd className="text-ink-muted">
                        {t('autofixAfterLine')}
                        <span className="block font-mono text-xs">{bboxText(plan.fixedBBoxPt, formatNumber, t('pointsShort'))}</span>
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <span className="mt-1 block text-sm text-ink-muted">{t('autofixNotApplicable')}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {applyableCount > 0 && (
        <>
          <p className="text-xs text-ink-muted">{t('autofixSafety')}</p>
          <button type="button" className={btnPrimary} onClick={onApply} disabled={disabled}>
            {t('autofixApply')}
          </button>
        </>
      )}
    </section>
  );
}
