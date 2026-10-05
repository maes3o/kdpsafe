import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineApi } from '../engine/api';
import type { InspectionResult, UserIntent, VerifyAutofixResult } from '../engine/types';
import { applyablePlans } from './issues';

export type Busy = 'reading' | 'preflight' | 'autofix' | 'verifying' | null;
export type FailureStage = 'read' | 'preflight' | 'autofix' | 'verify';

export interface Failure {
  stage: FailureStage;
  /** 'notPdf' is a UI-level format check; everything else carries the raw message. */
  code?: 'notPdf';
  message: string;
}

export interface DocInfo {
  pageCount: number;
  firstPageWidthIn: number;
  firstPageHeightIn: number;
}

export interface WorkspaceState {
  file: { name: string; size: number } | null;
  /** The user's original bytes. Never mutated; every engine call gets a copy. */
  bytes: Uint8Array | null;
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

  /** (Re)run the real preflight with a user-confirmed intent. */
  const runIntent = useCallback(
    async (intent: UserIntent) => {
      const bytes = stateRef.current.bytes;
      if (!bytes) return;
      const mySeq = ++seq.current;
      // Drop any previous result immediately: a stale READY must never stay
      // on screen while a new check runs.
      patch({ intent, busy: 'preflight', inspection: null, fix: null, failure: null, showFixed: false });
      try {
        const inspection = await engine().runPreflight(bytes, { userIntent: intent });
        if (mySeq !== seq.current) return;
        patch({ inspection, busy: null });

        // READY with nothing to apply: ask the engine for its verification
        // contract (VERIFIED, after:null). No mutation can occur here.
        if (inspection.verdict === 'READY' && applyablePlans(inspection).length === 0) {
          patch({ busy: 'verifying' });
          try {
            const fix = await engine().verifyAutofix(bytes, { userIntent: intent });
            if (mySeq !== seq.current) return;
            patch({ fix, busy: null });
          } catch (err) {
            if (mySeq === seq.current) patch({ busy: null, failure: { stage: 'verify', message: message(err) } });
          }
        }
      } catch (err) {
        if (mySeq === seq.current) patch({ busy: null, failure: { stage: 'preflight', message: message(err) } });
      }
    },
    [engine, patch]
  );

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

  return { state, openFile, runIntent, applyFix, discardFix, setShowFixed, setDocInfo, dismissFailure, reset };
}
