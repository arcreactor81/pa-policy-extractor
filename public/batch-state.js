function createBatchState() {
  return {
    pdfs: {},
    results: [],
    errors: [],
    completedPdfs: 0,
    failedPdfs: 0,
  };
}

function pdfIndexOf(event) {
  return event && typeof event.pdf_index === "number"
    ? event.pdf_index
    : null;
}

function filenameOf(event, pdf) {
  return event && typeof event.filename === "string"
    ? event.filename
    : pdf && typeof pdf.filename === "string"
      ? pdf.filename
      : "";
}

function recount(state) {
  var completed = 0;
  var failed = 0;

  Object.keys(state.pdfs).forEach(function (key) {
    var pdf = state.pdfs[key];
    if (pdf.done) completed += 1;
    if (pdf.failed) failed += 1;
  });

  state.completedPdfs = completed;
  state.failedPdfs = failed;
  return state;
}

function applyBatchEvent(current, event) {
  var state = current && typeof current === "object"
    ? current
    : createBatchState();
  var eventType = event && typeof event.event === "string"
    ? event.event
    : "";
  var pdfIndex = pdfIndexOf(event);

  if (
    pdfIndex == null ||
    (
      eventType !== "result" &&
      eventType !== "error" &&
      eventType !== "pdf_reset" &&
      eventType !== "done" &&
      eventType !== "pdf_done"
    )
  ) {
    return state;
  }

  var key = String(pdfIndex);
  var previousPdf = state.pdfs[key] || {
    filename: "",
    attempt: 1,
    done: false,
    failed: false,
    error: null,
  };
  var next = {
    pdfs: Object.assign({}, state.pdfs),
    results: Array.isArray(state.results) ? state.results.slice() : [],
    errors: Array.isArray(state.errors) ? state.errors.slice() : [],
    completedPdfs: Number(state.completedPdfs) || 0,
    failedPdfs: Number(state.failedPdfs) || 0,
  };
  var pdf = Object.assign({}, previousPdf, {
    filename: filenameOf(event, previousPdf),
  });
  next.pdfs[key] = pdf;

  if (eventType === "pdf_reset") {
    next.results = next.results.filter(function (row) {
      return row.pdfIndex !== pdfIndex;
    });
    next.errors = next.errors.filter(function (row) {
      return row.pdfIndex !== pdfIndex;
    });
    pdf.attempt = typeof event.attempt === "number"
      ? event.attempt
      : (Number(previousPdf.attempt) || 1) + 1;
    pdf.done = false;
    pdf.failed = false;
    pdf.error = null;
    return recount(next);
  }

  if (eventType === "result") {
    var resultObject = event.result && typeof event.result === "object"
      ? event.result
      : {};
    var brand = typeof event.brand === "string" && event.brand
      ? event.brand
      : typeof resultObject.Brand === "string"
        ? resultObject.Brand
        : "";

    if (!brand) return state;

    next.results = next.results.filter(function (row) {
      return !(row.pdfIndex === pdfIndex && row.brand === brand);
    });
    next.errors = next.errors.filter(function (row) {
      return !(row.pdfIndex === pdfIndex && row.brand === brand);
    });
    next.results.push({
      pdfIndex: pdfIndex,
      filename: pdf.filename,
      brand: brand,
      data: event,
    });
    return recount(next);
  }

  if (eventType === "error") {
    var errorBrand = typeof event.brand === "string" && event.brand
      ? event.brand
      : null;
    var message = typeof event.error === "string"
      ? event.error
      : "extraction failed";

    if (errorBrand) {
      next.results = next.results.filter(function (row) {
        return !(row.pdfIndex === pdfIndex && row.brand === errorBrand);
      });
      next.errors = next.errors.filter(function (row) {
        return !(row.pdfIndex === pdfIndex && row.brand === errorBrand);
      });
      next.errors.push({
        pdfIndex: pdfIndex,
        filename: pdf.filename,
        brand: errorBrand,
        message: message,
      });
    } else {
      next.errors = next.errors.filter(function (row) {
        return !(row.pdfIndex === pdfIndex && row.brand == null);
      });
      next.errors.push({
        pdfIndex: pdfIndex,
        filename: pdf.filename,
        brand: null,
        message: message,
      });
      pdf.done = true;
      pdf.failed = true;
      pdf.error = message;
    }
    return recount(next);
  }

  pdf.done = true;
  pdf.failed = event.failed === true;
  pdf.error = pdf.failed && typeof event.error === "string"
    ? event.error
    : pdf.failed
      ? pdf.error
      : null;
  return recount(next);
}

var batchStateApi = Object.freeze({
  createBatchState: createBatchState,
  applyBatchEvent: applyBatchEvent,
});

globalThis.PABatchState = batchStateApi;

export { applyBatchEvent, createBatchState };
