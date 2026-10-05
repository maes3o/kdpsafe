import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context';
import type { UserIntent } from '../engine/types';
import type { DocInfo } from '../workspace/useWorkspace';
import { btnPrimary, btnGhost, inputCls, sectionTitle } from './ui';

type Direction = 'unspecified' | 'ltr' | 'rtl';

interface Draft {
  width: string;
  height: string;
  bleed: '' | 'yes' | 'no';
  direction: Direction;
}

function toDraft(intent: UserIntent | null): Draft {
  return {
    width: intent ? String(intent.trimSize.widthIn) : '',
    height: intent ? String(intent.trimSize.heightIn) : '',
    bleed: intent ? (intent.bleed ? 'yes' : 'no') : '',
    direction: intent?.readingDirection ?? 'unspecified',
  };
}

function parseNumber(s: string): number | null {
  const n = Number(s.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Draft -> UserIntent, or null while anything required is missing. Nothing
 * is defaulted: trim and bleed must be stated by the user. */
export function draftToIntent(d: Draft): UserIntent | null {
  const widthIn = parseNumber(d.width);
  const heightIn = parseNumber(d.height);
  if (widthIn === null || heightIn === null || d.bleed === '') return null;
  const intent: UserIntent = { trimSize: { widthIn, heightIn }, bleed: d.bleed === 'yes' };
  if (d.direction !== 'unspecified') intent.readingDirection = d.direction;
  return intent;
}

const sameIntent = (a: UserIntent | null, b: UserIntent | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Manuscript settings -> engine `userIntent`.
 *  - Before the first run (`current === null`): explicit "Run preflight".
 *  - Afterwards: every committed change (select/radio immediately, numbers on
 *    blur/Enter) re-runs the real preflight.
 */
export function SettingsForm({
  current,
  docInfo,
  onSubmit,
}: {
  current: UserIntent | null;
  docInfo: DocInfo | null;
  onSubmit: (intent: UserIntent) => void;
}) {
  const { t, formatNumber } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => toDraft(current));
  const live = current !== null;

  // Keep the draft in step when the intent changes from elsewhere (e.g. the
  // reading-direction question was answered in the results panel).
  useEffect(() => {
    if (current && !sameIntent(current, draftToIntent(draft))) setDraft(toDraft(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  function commit(next: Draft) {
    const intent = draftToIntent(next);
    if (intent && !sameIntent(intent, current)) onSubmit(intent);
  }
  function update(patch: Partial<Draft>, commitNow: boolean) {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (live && commitNow) commit(next);
  }

  const intent = draftToIntent(draft);
  const numberProps = (key: 'width' | 'height') => ({
    value: draft[key],
    inputMode: 'decimal' as const,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => update({ [key]: e.target.value }, false),
    onBlur: () => live && commit(draft),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && live) commit(draft);
    },
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (intent) onSubmit(intent);
      }}
    >
      {!live && <p className="text-sm text-ink-muted">{t('settingsIntro')}</p>}

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={sectionTitle}>{t('trimWidth')} ({t('inchesShort')})</span>
          <input className={`${inputCls} mt-1`} {...numberProps('width')} />
        </label>
        <label className="block">
          <span className={sectionTitle}>{t('trimHeight')} ({t('inchesShort')})</span>
          <input className={`${inputCls} mt-1`} {...numberProps('height')} />
        </label>
      </div>

      {docInfo && (
        <p className="text-xs text-ink-muted">
          {t('detectedPageSize', {
            width: formatNumber(docInfo.firstPageWidthIn, 3),
            height: formatNumber(docInfo.firstPageHeightIn, 3),
          })}{' '}
          <button
            type="button"
            className={btnGhost}
            onClick={() =>
              update(
                { width: String(Number(docInfo.firstPageWidthIn.toFixed(3))), height: String(Number(docInfo.firstPageHeightIn.toFixed(3))) },
                true
              )
            }
          >
            {t('useDetectedSize')}
          </button>
        </p>
      )}

      <label className="block">
        <span className={sectionTitle}>{t('bleedLabel')}</span>
        <select
          className={`${inputCls} mt-1 font-sans`}
          value={draft.bleed}
          onChange={(e) => update({ bleed: e.target.value as Draft['bleed'] }, true)}
        >
          <option value="" disabled>
            {t('bleedChoose')}
          </option>
          <option value="no">{t('bleedNo')}</option>
          <option value="yes">{t('bleedYes')}</option>
        </select>
      </label>

      <label className="block">
        <span className={sectionTitle}>{t('readingDirection')}</span>
        <select
          className={`${inputCls} mt-1 font-sans`}
          value={draft.direction}
          onChange={(e) => update({ direction: e.target.value as Direction }, true)}
        >
          <option value="unspecified">{t('readingUnspecified')}</option>
          <option value="ltr">{t('readingLtr')}</option>
          <option value="rtl">{t('readingRtl')}</option>
        </select>
        <span className="mt-1 block text-xs text-ink-muted">{t('readingHelp')}</span>
      </label>

      {live ? (
        <p className="text-xs text-ink-muted">{t('settingsRerunNote')}</p>
      ) : (
        <>
          {!intent && <p className="text-xs text-ink-muted">{t('settingsInvalid')}</p>}
          <button type="submit" className={btnPrimary} disabled={!intent}>
            {t('runPreflight')}
          </button>
        </>
      )}
    </form>
  );
}
