import type { ViewerFocus } from '../components/viewer/types';

interface MockProps {
  pdfBytes: Uint8Array | null;
  focus: ViewerFocus | null;
  activeMarkId: string | null;
  marks: unknown[];
  toolbarExtra?: React.ReactNode;
}

/** jsdom cannot run PDF.js; the real viewer is covered by the browser smoke test. */
export function PdfViewer(props: MockProps) {
  return (
    <div data-testid="viewer" data-bytes={props.pdfBytes?.length ?? 0} data-focus-page={props.focus ? props.focus.pageIndex : ''} data-active={props.activeMarkId ?? ''} data-marks={props.marks.length}>
      {props.toolbarExtra}
    </div>
  );
}
