import { useI18n } from '../i18n/context';
import { useTheme } from '../theme/context';
import type { Locale } from '../i18n/strings';

const LOCALES: { id: Locale; label: string }[] = [
  { id: 'uk', label: 'UA' },
  { id: 'en', label: 'EN' },
];

export function Header() {
  const { t, locale, setLocale } = useI18n();
  const { mode, toggle } = useTheme();
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-bg px-4">
      <div className="flex items-center gap-2.5">
        <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true" className="shrink-0">
          <rect x="1.5" y="1.5" width="19" height="23" className="fill-none stroke-ink" strokeWidth="1.8" />
          <rect x="5.5" y="5.5" width="11" height="15" className="fill-none stroke-ink" strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
        <h1 className="font-display text-lg font-semibold tracking-tight">{t('appTitle')}</h1>
        <span className="hidden font-mono text-[11px] uppercase tracking-widest text-ink-muted sm:inline">{t('appSubtitle')}</span>
      </div>
      <div className="flex items-center gap-3">
        <div role="group" aria-label={t('language')} className="inline-flex overflow-hidden rounded-md border border-border-strong">
          {LOCALES.map((l) => (
            <button
              key={l.id}
              type="button"
              lang={l.id}
              aria-pressed={locale === l.id}
              onClick={() => setLocale(l.id)}
              className={`px-2.5 py-1 text-xs font-medium ${locale === l.id ? 'bg-accent text-accent-ink' : 'bg-bg text-ink hover:bg-bg-hover'}`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={mode === 'dark'}
          aria-label={mode === 'dark' ? t('themeSwitchToLight') : t('themeSwitchToDark')}
          title={mode === 'dark' ? t('themeSwitchToLight') : t('themeSwitchToDark')}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium hover:bg-bg-hover"
        >
          <span aria-hidden="true">{mode === 'dark' ? '☾' : '☀'}</span>
          {mode === 'dark' ? t('themeDark') : t('themeLight')}
        </button>
      </div>
    </header>
  );
}
