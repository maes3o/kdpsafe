import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context';
import { inToUnit, unitToIn, useUnit, type Unit } from '../units/context';
import type { UserIntent } from '../engine/types';
import type { DocInfo } from '../workspace/useWorkspace';
import { TRIM_PRESETS, matchPreset, suggestFromPageSize } from '../workspace/kdpSizes';
import { btnGhost, btnPrimary, inputCls, sectionTitle } from './ui';

type Direction = 'unspecified' | 'ltr' | 'rtl';

interface Draft {
  /** Width/height as typed, in the CURRENT display unit. */
  width: string;
  height: string;
  bleed: '' | 'yes' | 'no';
  direction: Direction;
}

const roundTo = (v: number, digits: number) => Number(v.toFixed(digits));
const digitsFor = (unit: Unit) => (unit === 'mm' ? 1 : 3);

function toDraft(intent: UserIntent | null, unit: Unit): Draft {
  return {
    width: intent ? String(roundTo(inToUnit(intent.trimSize.widthIn, unit), digitsFor(unit))) : '',
    height: intent ? String(roundTo(inToUnit(intent.trimSize.heightIn, unit), digitsFor(unit))) : '',
    bleed: intent ? (intent.bleed ? 'yes' : 'no') : '',
    direction: intent?.readingDirection ?? 'unspecified',
  };
}

function parseNumber(s: string): number | null {
  const n = Number(s.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Draft -> UserIntent (always inches, the engine's unit), or null while
 * anything required is missing. Nothing is defaulted. */
export function draftToIntent(d: Draft, unit: Unit): UserIntent | null {
  const w = parseNumber(d.width);
  const h = parseNumber(d.height);
  if (w === null || h === null || d.bleed === '') return null;
  const intent: UserIntent = {
    trimSize: { widthIn: roundTo(unitToIn(w, unit), 4), heightIn: roundTo(unitToIn(h, unit), 4) },
    bleed: d.bleed === 'yes',
  };
  if (d.direction !== 'unspecified') intent.readingDirection = d.direction;
  return intent;
}

const sameIntent = (a: UserIntent | null, b: UserIntent | null) => JSON.stringify(a) === JSON.stringify(b);

/** Tiny diagram: trim edge, bleed beyond it, safe margin inside. */
function PageDiagram({ bleed }: { bleed: boolean }) {
  return (
    <svg width="44" height="56" viewBox="0 0 44 56" aria-hidden="true" className="shrink-0">
      {bleed && <rect x="1" y="1" width="42" height="54" className="fill-none stroke-ink-muted" strokeDasharray="4 2" />}
      <rect x="6" y="6" width="32" height="44" className="fill-bg stroke-ink" strokeWidth="1.5" />
      <rect x="11" y="11" width="22" height="34" className="fill-none stroke-ink-muted" strokeDasharray="1.5 2.5" />
    </svg>
  );
}

function BleedOption({
  value,
  checked,
  title,
  body,
  onSelect,
}: {
  value: 'yes' | 'no';
  checked: boolean;
  title: string;
  body: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${
        checked ? 'border-ink bg-bg-panel' : 'border-border hover:bg-bg-hover'
      }`}
    >
      <input type="radio" name="bleed" value={value} checked={checked} onChange={onSelect} className="mt-1 accent-ink" />
      <PageDiagram bleed={value === 'yes'} />
      <span className="block text-sm">
        <span className="block font-medium">{title}</span>
        <span className="block text-ink-muted">{body}</span>
      </span>
    </label>
  );
}

/**
 * Book settings -> engine `userIntent`.
 *  - Before the first run (`current === null`): explicit "Run preflight".
 *  - Afterwards: every committed change (choices immediately, numbers on
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
  const { t } = useI18n();
  const { unit, setUnit, unitLabel, formatPair } = useUnit();
  const [draft, setDraft] = useState<Draft>(() => toDraft(current, unit));
  const live = current !== null;

  // Keep the draft in step when the intent changes from elsewhere (e.g. the
  // reading-direction question answered in the results panel).
  useEffect(() => {
    if (current && !sameIntent(current, draftToIntent(draft, unit))) setDraft(toDraft(current, unit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  function commit(next: Draft) {
    const intent = draftToIntent(next, unit);
    if (intent && !sameIntent(intent, current)) onSubmit(intent);
  }
  function update(patch: Partial<Draft>, commitNow: boolean) {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (live && commitNow) commit(next);
  }

  function changeUnit(next: Unit) {
    if (next === unit) return;
    const w = parseNumber(draft.width);
    const h = parseNumber(draft.height);
    setUnit(next);
    // Same size, shown in the other unit.
    setDraft((d) => ({
      ...d,
      width: w === null ? d.width : String(roundTo(inToUnit(unitToIn(w, unit), next), digitsFor(next))),
      height: h === null ? d.height : String(roundTo(inToUnit(unitToIn(h, unit), next), digitsFor(next))),
    }));
  }

  const intent = draftToIntent(draft, unit);
  const preset = intent ? matchPreset(intent.trimSize.widthIn, intent.trimSize.heightIn) : null;
  const presetValue = preset ? preset.id : draft.width === '' && draft.height === '' ? '' : 'custom';
  const suggestion = docInfo ? suggestFromPageSize(docInfo.firstPageWidthIn, docInfo.firstPageHeightIn) : null;
  const sizeName = formatPair;

  function applyPreset(id: string) {
    if (id === 'custom' || id === '') return;
    const p = TRIM_PRESETS.find((x) => x.id === id);
    if (!p) return;
    update(
      {
        width: String(roundTo(inToUnit(p.widthIn, unit), digitsFor(unit))),
        height: String(roundTo(inToUnit(p.heightIn, unit), digitsFor(unit))),
      },
      true
    );
  }

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
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (intent) onSubmit(intent);
      }}
    >
      {!live && <p className="text-sm text-ink-muted">{t('settingsIntro')}</p>}

      {/* ---- trim size ---- */}
      <fieldset className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <legend className={sectionTitle}>{t('sizeLabel')}</legend>
          <div role="group" aria-label={t('unitsLabel')} className="inline-flex overflow-hidden rounded-md border border-border-strong text-xs">
            {(['in', 'mm'] as const).map((u) => (
              <button
                key={u}
                type="button"
                aria-pressed={unit === u}
                onClick={() => changeUnit(u)}
                className={`px-2.5 py-1 font-medium ${unit === u ? 'bg-accent text-accent-ink' : 'bg-bg hover:bg-bg-hover'}`}
              >
                {u === 'in' ? t('unitIn') : t('unitMm')}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="sr-only">{t('sizePresetLabel')}</span>
          <select
            className={`${inputCls} font-sans`}
            value={presetValue}
            onChange={(e) => applyPreset(e.target.value)}
            aria-label={t('sizePresetLabel')}
          >
            <option value="" disabled>
              {t('sizeChoose')}
            </option>
            {TRIM_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {sizeName(p.widthIn, p.heightIn)}
              </option>
            ))}
            <option value="custom">{t('sizeCustom')}</option>
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-ink-muted">
              {t('trimWidth')} ({unitLabel})
            </span>
            <input className={`${inputCls} mt-1`} {...numberProps('width')} />
          </label>
          <label className="block">
            <span className="text-xs text-ink-muted">
              {t('trimHeight')} ({unitLabel})
            </span>
            <input className={`${inputCls} mt-1`} {...numberProps('height')} />
          </label>
        </div>

        {docInfo && (
          <p className="rounded-md bg-bg-panel p-2 text-xs text-ink-muted">
            {suggestion ? (
              <>
                {t('sizeSuggest', {
                  page: formatPair(docInfo.firstPageWidthIn, docInfo.firstPageHeightIn),
                  size: sizeName(suggestion.preset.widthIn, suggestion.preset.heightIn),
                  bleed: suggestion.bleed ? t('sizeSuggestWith') : t('sizeSuggestWithout'),
                })}{' '}
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => {
                    const p = suggestion.preset;
                    update(
                      {
                        width: String(roundTo(inToUnit(p.widthIn, unit), digitsFor(unit))),
                        height: String(roundTo(inToUnit(p.heightIn, unit), digitsFor(unit))),
                        bleed: suggestion.bleed ? 'yes' : 'no',
                      },
                      true
                    );
                  }}
                >
                  {t('sizeSuggestApply')}
                </button>
              </>
            ) : (
              t('detectedPageSize', {
                size: formatPair(docInfo.firstPageWidthIn, docInfo.firstPageHeightIn),
              })
            )}
          </p>
        )}
        <p className="text-xs text-ink-muted">{t('sizeHint')}</p>
      </fieldset>

      {/* ---- bleed ---- */}
      <fieldset className="space-y-2">
        <legend className={sectionTitle}>{t('bleedLabel')}</legend>
        <BleedOption value="no" checked={draft.bleed === 'no'} title={t('bleedNoTitle')} body={t('bleedNoBody')} onSelect={() => update({ bleed: 'no' }, true)} />
        <BleedOption value="yes" checked={draft.bleed === 'yes'} title={t('bleedYesTitle')} body={t('bleedYesBody')} onSelect={() => update({ bleed: 'yes' }, true)} />
        <p className="text-xs text-ink-muted">{t('bleedHint')}</p>
      </fieldset>

      {/* ---- reading direction ---- */}
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

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-muted">{t('helpTitle')}</summary>
        <div className="mt-2 space-y-2 text-xs text-ink-muted">
          <p>{t('helpTrim')}</p>
          <p>{t('helpBleed')}</p>
          <p>{t('helpSafe')}</p>
        </div>
      </details>

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
