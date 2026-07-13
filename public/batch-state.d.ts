export interface BatchEvent {
  event: string;
  pdf_index?: number;
  filename?: string;
  brand?: string;
  error?: string;
  result?: Record<string, unknown>;
  attempt?: number;
  failed?: boolean;
  [key: string]: unknown;
}

export interface BatchPdfState {
  filename: string;
  attempt: number;
  done: boolean;
  failed: boolean;
  error: string | null;
}

export interface BatchResultState {
  pdfIndex: number;
  filename: string;
  brand: string;
  data: BatchEvent;
}

export interface BatchErrorState {
  pdfIndex: number;
  filename: string;
  brand: string | null;
  message: string;
}

export interface BatchState {
  pdfs: Record<string, BatchPdfState>;
  results: BatchResultState[];
  errors: BatchErrorState[];
  completedPdfs: number;
  failedPdfs: number;
}

export function createBatchState(): BatchState;

export function applyBatchEvent(
  current: BatchState | null | undefined,
  event: BatchEvent
): BatchState;

export function shouldRenderFinishedSnapshot(jobState: unknown): boolean;
