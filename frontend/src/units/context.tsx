import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/context';

export type Unit = 'in' | 'mm';
const STORAGE_KEY = 'kdpsafe.unit';
const MM_PER_IN = 25.4;
const PT_PER_IN = 72;

export const inToUnit = (inches: number, unit: Unit) => (unit === 'mm' ? inches * MM_PER_IN : inches);
export const unitToIn = (value: number, unit: Unit) => (unit === 'mm' ? value / MM_PER_IN : value);

interface UnitContextValue {
  unit: Unit;
  setUnit: (u: Unit) => void;
  /** Points (engine) -> "1.4 mm" / "0.056 in" for display. */
  formatPt: (pt: number) => string;
  /** Inches -> display string in the current unit. */
  formatIn: (inches: number) => string;
  /** "6 × 9 in" -- one unit for the pair. */
  formatPair: (widthIn: number, heightIn: number) => string;
  unitLabel: string;
}

const UnitContext = createContext<UnitContextValue | null>(null);

function initialUnit(): Unit {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'in' || v === 'mm') return v;
  } catch {
    /* storage unavailable */
  }
  return 'in';
}

export function UnitProvider({ children, initial }: { children: ReactNode; initial?: Unit }) {
  const { t, formatNumber } = useI18n();
  const [unit, setUnit] = useState<Unit>(initial ?? initialUnit);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, unit);
    } catch {
      /* storage unavailable */
    }
  }, [unit]);

  const value = useMemo<UnitContextValue>(() => {
    const unitLabel = unit === 'mm' ? t('mmShort') : t('inchesShort');
    const formatIn = (inches: number) => `${formatNumber(inToUnit(inches, unit), unit === 'mm' ? 1 : 3)} ${unitLabel}`;
    const num = (inches: number) => formatNumber(inToUnit(inches, unit), unit === 'mm' ? 1 : 3);
    const formatPair = (w: number, h: number) => `${num(w)} × ${num(h)} ${unitLabel}`;
    return { unit, setUnit, unitLabel, formatIn, formatPair, formatPt: (pt) => formatIn(Math.abs(pt) / PT_PER_IN) };
  }, [unit, t, formatNumber]);

  return <UnitContext.Provider value={value}>{children}</UnitContext.Provider>;
}

export function useUnit(): UnitContextValue {
  const ctx = useContext(UnitContext);
  if (!ctx) throw new Error('useUnit must be used within a UnitProvider');
  return ctx;
}
