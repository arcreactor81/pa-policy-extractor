import { describe, expect, it } from "vitest";
import {
  applyBatchEvent,
  createBatchState,
  shouldRenderFinishedSnapshot,
} from "../public/batch-state.js";
import type {
  BatchEvent,
  BatchState,
} from "../public/batch-state.js";

function resultEvent(
  seq: number,
  pdfIndex: number,
  brand: string,
  score: number
): BatchEvent {
  return {
    event: "result",
    seq_num: seq,
    pdf_index: pdfIndex,
    filename: `policy-${pdfIndex}.pdf`,
    brand,
    result: {
      Filename: `policy-${pdfIndex}.pdf`,
      Brand: brand,
      "Access Score": score,
    },
  };
}

function doneEvent(
  seq: number,
  pdfIndex: number,
  failed: boolean
): BatchEvent {
  return {
    event: "done",
    seq_num: seq,
    pdf_index: pdfIndex,
    filename: `policy-${pdfIndex}.pdf`,
    failed,
  };
}

function reduce(events: BatchEvent[], initial?: BatchState): BatchState {
  return events.reduce(
    (state, event) => applyBatchEvent(state, event),
    initial || createBatchState()
  );
}

describe("batch replay reducer", () => {
  it("converges from replay-from-0 and reconnect-after-stale state", () => {
    const stalePrefix: BatchEvent[] = [
      resultEvent(1, 0, "TREMFYA", 100),
      doneEvent(2, 0, false),
      resultEvent(3, 1, "SKYRIZI", 75),
      doneEvent(4, 1, false),
    ];
    const replacementSuffix: BatchEvent[] = [
      {
        event: "pdf_reset",
        seq_num: 5,
        pdf_index: 0,
        filename: "policy-0.pdf",
        reason: "watchdog_resume",
        previous_attempt: 1,
        attempt: 2,
      },
      resultEvent(6, 0, "TREMFYA", 25),
      doneEvent(7, 0, false),
    ];

    const replayFromZero = reduce(stalePrefix.concat(replacementSuffix));
    const staleState = reduce(stalePrefix);
    const reconnectAfterStale = reduce(replacementSuffix, staleState);
    const recoveredResult = reconnectAfterStale.results.find(
      (row) => row.pdfIndex === 0
    );

    expect(reconnectAfterStale).toEqual(replayFromZero);
    expect(staleState.results).toHaveLength(2);
    expect(reconnectAfterStale.results).toHaveLength(2);
    expect(recoveredResult?.data.result?.["Access Score"]).toBe(25);
    expect(reconnectAfterStale.pdfs["0"]).toMatchObject({
      attempt: 2,
      done: true,
      failed: false,
    });
    expect(reconnectAfterStale.pdfs["1"]).toMatchObject({
      attempt: 1,
      done: true,
      failed: false,
    });
    expect(reconnectAfterStale.completedPdfs).toBe(2);
    expect(reconnectAfterStale.failedPdfs).toBe(0);
  });

  it("drops an attempt-1 success when attempt 2 ends in an error", () => {
    const stalePrefix: BatchEvent[] = [
      resultEvent(1, 0, "TREMFYA", 100),
      doneEvent(2, 0, false),
    ];
    const replacementSuffix: BatchEvent[] = [
      {
        event: "pdf_reset",
        seq_num: 3,
        pdf_index: 0,
        filename: "policy-0.pdf",
        reason: "watchdog_resume",
        previous_attempt: 1,
        attempt: 2,
      },
      {
        event: "error",
        seq_num: 4,
        pdf_index: 0,
        filename: "policy-0.pdf",
        brand: "TREMFYA",
        error: "attempt-2-error",
      },
      doneEvent(5, 0, true),
    ];

    const replayFromZero = reduce(stalePrefix.concat(replacementSuffix));
    const staleState = reduce(stalePrefix);
    const reconnectAfterStale = reduce(replacementSuffix, staleState);

    expect(reconnectAfterStale).toEqual(replayFromZero);
    expect(staleState.results).toHaveLength(1);
    expect(reconnectAfterStale.results).toEqual([]);
    expect(reconnectAfterStale.errors).toEqual([
      {
        pdfIndex: 0,
        filename: "policy-0.pdf",
        brand: "TREMFYA",
        message: "attempt-2-error",
      },
    ]);
    expect(reconnectAfterStale.pdfs["0"]).toMatchObject({
      attempt: 2,
      done: true,
      failed: true,
    });
    expect(reconnectAfterStale.completedPdfs).toBe(1);
    expect(reconnectAfterStale.failedPdfs).toBe(1);
  });

  it("renders saved results only for the coordinator's complete state", () => {
    expect(shouldRenderFinishedSnapshot({ status: "complete" })).toBe(true);

    [
      { status: "running" },
      { status: "pending" },
      { status: "failed" },
      { status: "done" },
      { status: "" },
      {},
      null,
      undefined,
    ].forEach((state) => {
      expect(shouldRenderFinishedSnapshot(state)).toBe(false);
    });
  });
});
