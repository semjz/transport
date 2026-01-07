// /field/fsl/fsl.request.js

/**
 * Simple data class representing one queued FSL request.
 * We store enough info to re-send + minimal metadata (created_at, retry_count).
 */
class FslRequest {
  constructor({
    id = null,
    url,
    method = "POST",
    headers = {},
    body = null,
    created_at = null,
    retry_count = 0, // NEW
  }) {
    if (!url) {
      throw new Error("FslRequest requires url");
    }
    this.id = id;
    this.url = url;
    this.method = method;
    this.headers = headers;
    this.body = body;

    // Store as-is; we handle both string/number in SW
    this.created_at = created_at || new Date().toISOString();
    this.retry_count = retry_count || 0;
  }
}

// In browsers and service workers, `self` exists (and is `window` in pages).
self.FslRequest = FslRequest;
