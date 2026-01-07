// /field/fsl/fsl.logic.js

/**
 * Build the body that /upsert_draft_fsl expects:
 * {
 *   qr_token,
 *   driver_canonical_id,
 *   payload_json: "<stringified payload>"
 * }
 */
function buildFslBody(item) {
  return {
    qr_token: item.qr_token,
    driver_canonical_id: item.driver_canonical_id,
    payload_json: JSON.stringify(item.payload),
  };
}

/**
 * Simple validation function that can be unit-tested without DOM.
 * Returns an array of error codes:
 *   - "qty_required"
 *   - "photo_required"
 */
function validatePayload(payload) {
  const errors = [];

  if (
    payload.qty_or_weight == null ||
    Number.isNaN(Number(payload.qty_or_weight))
  ) {
    errors.push("qty_required");
  }

  if (!payload.photo_data_url) {
    errors.push("photo_required");
  }

  return errors;
}

// ---- For Jest / Node tests ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildFslBody,
    validatePayload,
  };
}

// ---- Expose to browser global (used by fsl.js) ----
if (typeof self !== "undefined") {
  self.FslLogic = {
    buildFslBody,
    validatePayload,
  };
}
