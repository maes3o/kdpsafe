import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context';
import { inToUnit, unitToIn, useUnit, type Unit } from '../units/context';
import type { UserIntent } from '../engine/types';
import type { DocInfo } from '../workspace/useWorkspace';
import { TRIM_PRESETS, matchPreset, suggestFromPageSize } from '../workspace/kdpSizes';
import { IconArrow } from './icons';
import { btnGhost, btnPrimary, inputCls } from './ui';

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
      {bleed && <rect x="1" y="1" width="42" height="54" rx="2" className="fill-status-error-soft stroke-status-error" strokeDasharray="4 2" />}
      <rect x="6" y="6" width="32" height="44" rx="1" className="fill-bg stroke-ink-muted" strokeWidth="1.5" />
      <rect x="11" y="11" width="22" height="34" className="fill-none stroke-accent" strokeDasharray="1.5 2.5" />
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
      className={`relative flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 p-3 text-center ${
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-bg hover:bg-bg-hover'
      }`}
    >
      <input type="radio" name="bleed" value={value} checked={checked} onChange={onSelect} className="absolute right-2.5 top-2.5 h-4 w-4 accent-accent" />
      <PageDiagram bleed={value === 'yes'} />
      <span className="block text-sm">
        <span className="block font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs text-ink-muted">{body}</span>
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
  const { t, formatNumber } = useI18n();
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
  const formatPairIn = (w: number, h: number, u: Unit) => {
    const f = (v: number) => formatNumber(roundTo(inToUnit(v, u), digitsFor(u)));
    return `${f(w)} × ${f(h)} ${u === 'mm' ? t('mmShort') : t('inchesShort')}`;
  };

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

  const otherUnitPair = unit === 'in' ? 'mm' : 'in';
  const selectedPreset = preset ?? null;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (intent) onSubmit(intent);
      }}
    >
      {!live && <p className="text-sm text-ink-muted">{t('settingsIntro')}</p>}

      {/* ---- units ---- */}
      <div role="group" aria-label={t('unitsLabel')} className="grid grid-cols-2 gap-1 rounded-xl bg-bg-hover p-1">
        {(['in', 'mm'] as const).map((u) => (
          <button
            key={u}
            type="button"
            aria-pressed={unit === u}
            onClick={() => changeUnit(u)}
            className={`rounded-lg px-3 py-2 text-sm font-semibold ${unit === u ? 'bg-accent text-accent-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
          >
            {u === 'in' ? t('unitIn') : t('unitMm')}
          </button>
        ))}
      </div>

      {/* ---- trim size ---- */}
      <fieldset className="space-y-2">
        <legend className="text-base font-semibold">{t('sizeLabel')}</legend>

        <label className="relative block">
          <span className="sr-only">{t('sizePresetLabel')}</span>
          <span className="flex items-center justify-between gap-2 rounded-xl border border-border-strong bg-bg px-3.5 py-2.5">
            <span className="block">
              <span className="block text-sm font-semibold">{selectedPreset ? formatPair(selectedPreset.widthIn, selectedPreset.heightIn) : t('sizeChoose')}</span>
              {selectedPreset && (
                <span className="block font-mono text-xs text-ink-muted">
                  ({formatPairIn(selectedPreset.widthIn, selectedPreset.heightIn, otherUnitPair)})
                </span>
              )}
            </span>
            <span aria-hidden="true" className="text-ink-muted">⌄</span>
          </span>
          <select
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
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

        <details open={!preset} className="rounded-xl border border-border bg-bg">
          <summary className="flex cursor-pointer items-center justify-between px-3.5 py-2.5 text-sm font-medium">
            {t('sizeCustom')}
            <span aria-hidden="true" className="text-ink-muted">›</span>
          </summary>
          <div className="grid grid-cols-2 gap-3 border-t border-border p-3.5">
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
        </details>

        {docInfo && (
          <p className="rounded-xl bg-accent-soft p-3 text-xs">
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
              t('detectedPageSize', { size: formatPair(docInfo.firstPageWidthIn, docInfo.firstPageHeightIn) })
            )}
          </p>
        )}
        <p className="text-xs text-ink-muted">{t('sizeHint')}</p>
      </fieldset>

      {/* ---- bleed ---- */}
      <fieldset className="space-y-2">
        <legend className="text-base font-semibold">{t('bleedLabel')}</legend>
        <div className="grid grid-cols-2 gap-3">
          <BleedOption value="no" checked={draft.bleed === 'no'} title={t('bleedNoTitle')} body={t('bleedNoBody')} onSelect={() => update({ bleed: 'no' }, true)} />
          <BleedOption value="yes" checked={draft.bleed === 'yes'} title={t('bleedYesTitle')} body={t('bleedYesBody')} onSelect={() => update({ bleed: 'yes' }, true)} />
        </div>
        <p className="rounded-xl bg-accent-soft p-3 text-xs">{t('bleedHint')}</p>
      </fieldset>

      {/* ---- reading direction ---- */}
      <label className="block">
        <span className="text-base font-semibold">{t('readingDirection')}</span>
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
        <summary className="cursor-pointer font-medium text-accent">{t('helpTitle')}</summary>
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
          <button type="submit" className={`${btnPrimary} w-full py-3.5 text-base`} disabled={!intent}>
            {t('runPreflight')}
            <IconArrow />
          </button>
        </>
      )}
    </form>
  );
}
