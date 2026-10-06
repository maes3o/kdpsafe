import { useI18n } from '../i18n/context';
import { useTheme } from '../theme/context';
import type { Locale } from '../i18n/strings';
import { IconMoon, IconSun, Mark } from './icons';

const LOCALES: { id: Locale; label: string }[] = [
  { id: 'uk', label: 'UA' },
  { id: 'en', label: 'EN' },
];

export function Header() {
  const { t, locale, setLocale } = useI18n();
  const { mode, toggle } = useTheme();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-bg px-4">
      <div className="flex items-center gap-2.5">
        <Mark size={30} className="text-ink" />
        <h1 className="text-lg font-bold tracking-tight">{t('appTitle')}</h1>
      </div>
      <div className="flex items-center gap-2">
        <div role="group" aria-label={t('language')} className="inline-flex rounded-full bg-bg-hover p-0.5">
          {LOCALES.map((l) => (
            <button
              key={l.id}
              type="button"
              lang={l.id}
              aria-pressed={locale === l.id}
              onClick={() => setLocale(l.id)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${locale === l.id ? 'bg-bg text-accent shadow-sm' : 'text-ink-muted hover:text-ink'}`}
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
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-bg-hover hover:text-ink"
        >
          {mode === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </header>
  );
}
