// apps/transport/tests/fsl.logic.test.js

const {
  buildFslBody,
  validatePayload,
} = require("../transport/www/field/fsl/fsl.logic.js"); // ⬅ adjust path

describe("buildFslBody", () => {
  test("wraps item into server payload", () => {
    const body = buildFslBody({
      qr_token: "QR-123",
      driver_canonical_id: "DRV-01",
      payload: { qty_or_weight: 27, hello: "world" },
    });

    expect(body.qr_token).toBe("QR-123");
    expect(body.driver_canonical_id).toBe("DRV-01");
    expect(body.payload_json).toBe(
      JSON.stringify({ qty_or_weight: 27, hello: "world" })
    );
  });
});

describe("validatePayload", () => {
  test("flags missing qty and photo", () => {
    const errors = validatePayload({
      qty_or_weight: null,
      photo_data_url: null,
    });

    expect(errors).toContain("qty_required");
    expect(errors).toContain("photo_required");
  });

  test("passes valid payload", () => {
    const errors = validatePayload({
      qty_or_weight: 10,
      photo_data_url: "data:image/png;base64,...",
    });

    expect(errors).toEqual([]);
  });
});
