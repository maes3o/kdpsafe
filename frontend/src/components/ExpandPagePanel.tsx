import { useState } from 'react';
import { useI18n } from '../i18n/context';
import { useUnit } from '../units/context';
import { expandReasonLabel } from '../i18n/labels';
import type { ExpandAnchor, ExpandOffer } from '../engine/types';
import { btnPrimary, btnSecondary, sectionTitle } from './ui';

/**
 * "Expand page to the selected size": a user-initiated, page-box-only
 * operation. Nothing is pre-selected: the user must choose the anchor
 * (center | keep origin), review the change and tick an explicit
 * confirmation before the button works. KDPSafe does not judge whether the
 * added white space suits the book -- it says so, and leaves that decision
 * to the user. Deliberately neutral styling (no success colours).
 */
export function ExpandPagePanel({
  offer,
  disabled,
  onExpand,
}: {
  offer: ExpandOffer;
  disabled: boolean;
  onExpand: (anchor: ExpandAnchor) => void;
}) {
  const { t } = useI18n();
  const { formatPt, formatPair } = useUnit();
  const [anchor, setAnchor] = useState<ExpandAnchor | null>(null);
  const [review, setReview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  if (!offer.eligible || !offer.previews || !offer.target || !offer.current) {
    return (
      <div data-testid="expand-panel" data-expand-state="unavailable" className="mt-3 rounded-xl border border-border bg-bg p-3 text-sm">
        <p className="font-semibold">{t('expandTitle')}</p>
        <p className="mt-1 text-ink-muted">{t('expandUnavailable')}</p>
        <ul className="mt-1 list-inside list-disc">
          {offer.reasons.map((r) => (
            <li key={r}>{expandReasonLabel(t, r)}</li>
          ))}
        </ul>
      </div>
    );
  }

  const current = formatPair(offer.current.widthPt / 72, offer.current.heightPt / 72);
  const target = formatPair(offer.target.widthPt / 72, offer.target.heightPt / 72);
  const added = (a: ExpandAnchor) => offer.previews![a].addedPt;
  const sideAmounts = (a: ExpandAnchor) => {
    const p = added(a);
    return { amount: formatPt(Math.max(p.left, p.right)), amountV: formatPt(Math.max(p.top, p.bottom)) };
  };
  const choose = (a: ExpandAnchor) => {
    setAnchor(a);
    setConfirmed(false); // a new choice needs a new confirmation
  };

  const option = (a: ExpandAnchor, title: string, body: string) => (
    <label key={a} className={`flex cursor-pointer gap-2 rounded-xl border p-3 text-sm ${anchor === a ? 'border-accent bg-accent-soft' : 'border-border bg-bg'}`}>
      <input type="radio" name="expand-anchor" value={a} checked={anchor === a} onChange={() => choose(a)} disabled={disabled} className="mt-0.5 h-4 w-4 accent-accent" />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="block text-xs text-ink-muted">{body}</span>
      </span>
    </label>
  );

  return (
    <div data-testid="expand-panel" data-expand-state="available" className="mt-3 rounded-xl border border-border bg-bg p-3">
      <p className="text-sm font-semibold">{t('expandTitle')}</p>
      <p className="mt-1 text-sm">{t('expandIntro', { current, target })}</p>
      <p className="mt-1 text-xs text-ink-muted">{t('expandWillNot')}</p>
      <p className="mt-1 text-xs font-medium">{t('expandDecision')}</p>

      <fieldset className="mt-3 space-y-2">
        <legend className={sectionTitle}>{t('expandWhere')}</legend>
        {option('center', t('expandAnchorCenter'), t('expandAnchorCenterBody', sideAmounts('center')))}
        {option('keep-origin', t('expandAnchorKeep'), t('expandAnchorKeepBody', sideAmounts('keep-origin')))}
      </fieldset>

      {anchor && (
        <div className="mt-3 space-y-2">
          <button type="button" className={btnSecondary} onClick={() => setReview((v) => !v)} aria-expanded={review}>
            {review ? t('expandHideReview') : t('expandReview')}
          </button>
          {review && (
            <div data-testid="expand-review" className="space-y-1 rounded-xl border border-border p-3 font-mono text-xs">
              <p>{t('expandReviewBefore', { current })}</p>
              <p>
                {t('expandReviewAfter', {
                  target,
                  left: formatPt(added(anchor).left),
                  right: formatPt(added(anchor).right),
                  bottom: formatPt(added(anchor).bottom),
                  top: formatPt(added(anchor).top),
                })}
              </p>
            </div>
          )}
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={disabled} className="mt-0.5 h-4 w-4 accent-accent" />
            <span>{t('expandConfirm')}</span>
          </label>
        </div>
      )}

      <div className="mt-3">
        <button type="button" className={btnPrimary} disabled={disabled || !anchor || !confirmed} onClick={() => anchor && onExpand(anchor)}>
          {t('expandApply')}
        </button>
      </div>
    </div>
  );
}
