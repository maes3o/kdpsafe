import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineApi } from '../engine/api';
import type { ExpandAnchor, InspectionResult, PageGeometryAssessment, SafetyCheck, UserIntent, VerifyAutofixResult } from '../engine/types';
import { applyablePlans } from './issues';

export type Busy = 'reading' | 'preflight' | 'autofix' | 'verifying' | 'normalizing' | null;
export type FailureStage = 'read' | 'preflight' | 'autofix' | 'verify' | 'normalize';

export interface Failure {
  stage: FailureStage;
  /** 'notPdf' is a UI-level format check; 'expandNotReady' = the expanded copy
   * was verified but the real AFTER preflight was not READY (nothing applied). */
  code?: 'notPdf' | 'expandNotReady';
  message: string;
}

export interface DocInfo {
  pageCount: number;
  firstPageWidthIn: number;
  firstPageHeightIn: number;
}

/** Record of an applied (metadata-only) page-box normalization. */
export interface NormalizationRecord {
  kind: 'ADD_TRIM_BOX' | 'DEFINE_TRIM_BOX_FROM_BLEED' | 'EXPAND_PAGE';
  pagesChanged: number;
  checks: SafetyCheck[];
  /** EXPAND_PAGE only. */
  anchor?: ExpandAnchor;
  target?: { widthPt: number; heightPt: number };
}

export interface WorkspaceState {
  file: { name: string; size: number } | null;
  /** The WORKING bytes: the user's original file, or -- after an approved
   * page-box normalization -- the normalized copy. Never mutated in place;
   * every engine call gets a copy. */
  bytes: Uint8Array | null;
  /** The user's untouched original, kept only while a normalization is applied. */
  originalBytes: Uint8Array | null;
  /** Page-box analysis for `bytes` under `intent` (analysis only). */
  geometry: PageGeometryAssessment | null;
  normalization: NormalizationRecord | null;
  intent: UserIntent | null;
  busy: Busy;
  /** Engine result for the ORIGINAL bytes under `intent`. */
  inspection: InspectionResult | null;
  /** Authoritative verifyAutofix() result (for READY docs and after Apply). */
  fix: VerifyAutofixResult | null;
  failure: Failure | null;
  showFixed: boolean;
  docInfo: DocInfo | null;
}

const INITIAL: WorkspaceState = {
  file: null,
  bytes: null,
  originalBytes: null,
  geometry: null,
  normalization: null,
  intent: null,
  busy: null,
  inspection: null,
  fix: null,
  failure: null,
  showFixed: false,
  docInfo: null,
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/**
 * Workspace state machine. All compliance work is delegated to `engine`;
 * this hook only sequences calls, drops stale responses, and stores what
 * the engine returned.
 */
export function useWorkspace(createEngine: () => EngineApi) {
  const [state, setState] = useState<WorkspaceState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const engineRef = useRef<EngineApi | null>(null);
  const seq = useRef(0);

  const engine = useCallback((): EngineApi => {
    if (!engineRef.current) engineRef.current = createEngine();
    return engineRef.current;
  }, [createEngine]);

  useEffect(
    () => () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    },
    []
  );

  const patch = useCallback((p: Partial<WorkspaceState>) => setState((s) => ({ ...s, ...p })), []);

  const openFile = useCallback(
    async (file: File) => {
      const mySeq = ++seq.current;
      setState({ ...INITIAL, busy: 'reading' });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (mySeq !== seq.current) return;
        if (!looksLikePdf(bytes)) {
          setState({ ...INITIAL, failure: { stage: 'read', code: 'notPdf', message: file.name } });
          return;
        }
        setState({ ...INITIAL, file: { name: file.name, size: file.size }, bytes });
      } catch (err) {
        if (mySeq === seq.current) setState({ ...INITIAL, failure: { stage: 'read', message: message(err) } });
      }
    },
    []
  );

  /** READY with nothing to apply: ask the engine for its verification
   * contract (VERIFIED, after:null). No mutation can occur here. */
  const autoVerify = useCallback(
    async (bytes: Uint8Array, intent: UserIntent, inspection: InspectionResult, mySeq: number) => {
      if (inspection.verdict !== 'READY' || applyablePlans(inspection).length > 0) return;
      patch({ busy: 'verifying' });
      try {
        const fix = await engine().verifyAutofix(bytes, { userIntent: intent });
        if (mySeq !== seq.current) return;
        patch({ fix, busy: null });
      } catch (err) {
        if (mySeq === seq.current) patch({ busy: null, failure: { stage: 'verify', message: message(err) } });
      }
    },
    [engine, patch]
  );

  /** Page-box analysis is advisory: a failure here never blocks the verdict. */
  const assess = useCallback(
    async (bytes: Uint8Array, intent: UserIntent, mySeq: number) => {
      try {
        const geometry = await engine().assessPageGeometry(bytes, { userIntent: intent });
        if (mySeq === seq.current) patch({ geometry });
      } catch {
        if (mySeq === seq.current) patch({ geometry: null });
      }
    },
    [engine, patch]
  );

  /** (Re)run the real preflight with a user-confirmed intent. Always starts
   * from the user's ORIGINAL file: a normalization depends on the intent, so
   * changing a setting drops it and asks for approval again. */
  const runIntent = useCallback(
    async (intent: UserIntent) => {
      const current = stateRef.current;
      const bytes = current.originalBytes ?? current.bytes;
      if (!bytes) return;
      const mySeq = ++seq.current;
      // Drop any previous result immediately: a stale READY must never stay
      // on screen while a new check runs.
      patch({
        bytes,
        originalBytes: null,
        normalization: null,
        geometry: null,
        intent,
        busy: 'preflight',
        inspection: null,
        fix: null,
        failure: null,
        showFixed: false,
      });
      try {
        const inspection = await engine().runPreflight(bytes, { userIntent: intent });
        if (mySeq !== seq.current) return;
        patch({ inspection, busy: null });
        await assess(bytes, intent, mySeq);
        if (mySeq !== seq.current) return;
        await autoVerify(bytes, intent, inspection, mySeq);
      } catch (err) {
        if (mySeq === seq.current) patch({ busy: null, failure: { stage: 'preflight', message: message(err) } });
      }
    },
    [engine, patch, assess, autoVerify]
  );

  /** Explicit user approval of the page-box plan (metadata only). The
   * engine verifies the output byte-wise and returns the REAL preflight of
   * the changed file; that result replaces the current one. */
  const normalizeGeometry = useCallback(async () => {
    const { bytes, intent, geometry } = stateRef.current;
    if (!bytes || !intent || !geometry?.plan) return;
    const mySeq = ++seq.current;
    patch({ busy: 'normalizing', failure: null });
    try {
      const res = await engine().normalizePageGeometry(bytes, { userIntent: intent });
      if (mySeq !== seq.current) return;
      if (!res.applied || !res.after) {
        patch({ busy: null, failure: { stage: 'normalize', message: res.safety?.failure ?? 'NOT_APPLIED' } });
        return;
      }
      patch({
        originalBytes: bytes,
        bytes: res.outputBytes,
        inspection: res.after,
        fix: null,
        showFixed: false,
        normalization: { kind: geometry.plan.kind, pagesChanged: geometry.plan.changes.length, checks: res.safety?.checks ?? [] },
        busy: null,
      });
      await assess(res.outputBytes, intent, mySeq);
      if (mySeq !== seq.current) return;
      await autoVerify(res.outputBytes, intent, res.after, mySeq);
    } catch (err) {
      if (mySeq === seq.current) patch({ busy: null, failure: { stage: 'normalize', message: message(err) } });
    }
  }, [engine, patch, assess, autoVerify]);

  /** Explicit user approval of "Expand page to the selected size" with an
   * explicit anchor. Adopted ONLY when the engine's saved-bytes invariants
   * pass AND the real AFTER preflight is READY (checked here as well:
   * defense in depth); otherwise the original stays the working file. */
  const expandPage = useCallback(
    async (anchor: ExpandAnchor) => {
      const { bytes, intent, geometry } = stateRef.current;
      if (!bytes || !intent || !geometry?.expand?.eligible) return;
      const mySeq = ++seq.current;
      patch({ busy: 'normalizing', failure: null });
      try {
        const res = await engine().normalizePageGeometry(bytes, { userIntent: intent, expandPage: { anchor, confirmed: true } });
        if (mySeq !== seq.current) return;
        if (res.safety?.failure === 'AFTER_NOT_READY' && res.after) {
          patch({
            busy: null,
            failure: {
              stage: 'normalize',
              code: 'expandNotReady',
              message: `AFTER_NOT_READY: ${res.after.verdict}, confirmed problems ${res.after.violations.length}, manual-review items ${res.after.categories.margins.manualReview.length}`,
            },
          });
          return;
        }
        if (!res.applied || !res.after || res.after.verdict !== 'READY' || !res.expand) {
          patch({ busy: null, failure: { stage: 'normalize', message: res.safety?.failure ?? 'NOT_APPLIED' } });
          return;
        }
        patch({
          originalBytes: bytes,
          bytes: res.outputBytes,
          inspection: res.after,
          fix: null,
          showFixed: false,
          normalization: { kind: 'EXPAND_PAGE', pagesChanged: res.expand.pagesChanged, checks: res.safety?.checks ?? [], anchor: res.expand.anchor, target: res.expand.target },
          busy: null,
        });
        await assess(res.outputBytes, intent, mySeq);
        if (mySeq !== seq.current) return;
        await autoVerify(res.outputBytes, intent, res.after, mySeq);
      } catch (err) {
        if (mySeq === seq.current) patch({ busy: null, failure: { stage: 'normalize', message: message(err) } });
      }
    },
    [engine, patch, assess, autoVerify]
  );

  /** Back to the user's untouched original (re-analysed from scratch). */
  const undoNormalization = useCallback(() => {
    const { intent } = stateRef.current;
    if (intent) void runIntent(intent);
  }, [runIntent]);

  /** Explicit user approval of the engine's autofix plans. */
  const applyFix = useCallback(async () => {
    const { bytes, intent, inspection } = stateRef.current;
    if (!bytes || !intent || !inspection || applyablePlans(inspection).length === 0) return;
    const mySeq = ++seq.current;
    patch({ busy: 'autofix', failure: null });
    try {
      const fix = await engine().verifyAutofix(bytes, { userIntent: intent });
      if (mySeq !== seq.current) return;
      patch({ fix, busy: null, showFixed: fix.applied.length > 0 && fix.after !== null });
    } catch (err) {
      if (mySeq === seq.current) patch({ busy: null, failure: { stage: 'autofix', message: message(err) } });
    }
  }, [engine, patch]);

  const discardFix = useCallback(() => patch({ fix: null, showFixed: false, failure: null }), [patch]);
  const setShowFixed = useCallback((showFixed: boolean) => patch({ showFixed }), [patch]);
  const setDocInfo = useCallback((docInfo: DocInfo | null) => patch({ docInfo }), [patch]);
  const dismissFailure = useCallback(() => patch({ failure: null }), [patch]);

  const reset = useCallback(() => {
    seq.current++;
    setState(INITIAL);
  }, []);

  return { state, openFile, runIntent, normalizeGeometry, expandPage, undoNormalization, applyFix, discardFix, setShowFixed, setDocInfo, dismissFailure, reset };
}
