/**
 * Minimal EN + UA dictionary for the FRONTEND-01 shell. Deliberately only
 * covers the strings the shell actually renders -- not a placeholder for
 * every future screen. Extend per-feature as real UI is built, not ahead
 * of it.
 */

export type Locale = 'en' | 'uk';

export const STRINGS = {
  en: {
    appTitle: 'KDPSafe',
    uploadPrompt: 'Drop a PDF here, or click to choose a file',
    uploadHint: 'Interior PDF for Amazon KDP preflight',
    processing: 'Running preflight…',
    verdictReady: 'READY',
    verdictNeedsAttention: 'NEEDS ATTENTION',
    verdictManualReview: 'MANUAL REVIEW',
    verdictError: 'PROBLEM',
    pageOf: 'Page {current} of {total}',
    violationsHeading: 'Violations',
    manualReviewHeading: 'Manual review',
    noIssues: 'No issues found.',
    themeLight: 'Light',
    themeDark: 'Dark',
  },
  uk: {
    appTitle: 'KDPSafe',
    uploadPrompt: 'Перетягніть PDF сюди або натисніть, щоб обрати файл',
    uploadHint: 'PDF інтер’єру книги для перевірки Amazon KDP',
    processing: 'Виконується перевірка…',
    verdictReady: 'ГОТОВО',
    verdictNeedsAttention: 'ПОТРІБНА УВАГА',
    verdictManualReview: 'РУЧНА ПЕРЕВІРКА',
    verdictError: 'ПРОБЛЕМА',
    pageOf: 'Сторінка {current} з {total}',
    violationsHeading: 'Порушення',
    manualReviewHeading: 'Ручна перевірка',
    noIssues: 'Проблем не знайдено.',
    themeLight: 'Світла',
    themeDark: 'Темна',
  },
} as const;

export type StringKey = keyof typeof STRINGS.en;
