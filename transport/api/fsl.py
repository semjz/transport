import json
import hashlib
import frappe
from frappe.utils import get_datetime, nowdate

from transport.field_auth.qr import verify_customer_token
from transport.field_auth.driver import get_driver_by_canonical_id

FSL_DOCTYPE = "Field Service Log"

ALLOWED_FIELDS = {
    "qty_or_weight",
    "timestamp",
    "photo_data_url",
    "service_type",
    "waste_type",
    "weight_kg",
    "gps_lat",
    "gps_lng",
    "notes",
    "performed_at",
}


# ------------------------------
# Helpers
# ------------------------------


def _parse_payload(payload_json: str) -> dict:
    """Parse JSON payload and keep only whitelisted fields."""
    data = json.loads(payload_json or "{}")
    if not isinstance(data, dict):
        return {}

    out = {k: v for k, v in data.items() if k in ALLOWED_FIELDS}

    ts = out.get("timestamp")
    if ts:
        try:
            dt = get_datetime(ts)
            # strip timezone info; store naive server time
            if getattr(dt, "tzinfo", None):
                dt = dt.replace(tzinfo=None)
            out["timestamp"] = dt
        except Exception:
            frappe.throw("Invalid timestamp format")

    return out


def _make_trip_id(customer: str, driver_canonical_id: str, trip_date: str) -> str:
    """Deterministic per (customer, driver, day) id."""
    raw = f"{customer}|{driver_canonical_id}|{trip_date}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def _rate_limit(key: str, limit: int = 10, window_sec: int = 60):
    """
    Per-key rate limiting using frappe.cache() (Redis in prod).
    Counter with TTL=window_sec. If counter > limit -> HTTP 429.
    """
    cache = frappe.cache()
    cache_key = f"rl:{key}"

    try:
        n = cache.incr(cache_key)
    except ValueError:
        cache.set_value(cache_key, 1, expires_in_sec=window_sec)
        n = 1

    try:
        cache.expire(cache_key, window_sec)
    except Exception:
        # not critical
        pass

    if n > limit:
        frappe.local.response["http_status_code"] = 429
        frappe.throw("Too many requests. Please wait and try again.")


def _assert_same_driver(doc, driver_canonical_id: str):
    """
    Ensure the FSL belongs to the same driver (by canonical id / name).

    Convention:
    - Driver.name == Driver.custom_driver_canonical_id
    - FSL.driver stores that same canonical id.
    """
    current = (doc.driver or "").strip()
    expected = (driver_canonical_id or "").strip()

    if not current:
        frappe.throw("FSL has no driver set")

    if current != expected:
        # Log for server-side debugging
        frappe.log_error(
            f"FSL driver mismatch: doc.driver={current}, token_driver={expected}",
            "FSL Driver Mismatch",
        )
        # IMPORTANT: use frappe.throw (HTTP 417), not PermissionError (403)
        frappe.throw(
            f"Driver mismatch for FSL {doc.name}: doc.driver={current}, token_driver={expected}"
        )


# ------------------------------
# Create / update draft
# ------------------------------


def _create_draft(
    trip_id: str,
    customer: str,
    driver_canonical_id: str,
    payload_json: str,
):
    """
    Create draft FSL.

    - Sets customer and driver ONCE.
    - driver is stored as canonical id (which is also Driver.name).
    - qr_token is not stored.
    """
    payload = _parse_payload(payload_json)

    doc_dict = {
        "doctype": FSL_DOCTYPE,
        "trip_id": trip_id,
        "customer": customer,
        "driver": driver_canonical_id,
        "status": "Draft",
        **payload,
    }

    meta = frappe.get_meta(FSL_DOCTYPE)
    if meta.get_field("trip_date"):
        doc_dict["trip_date"] = nowdate()

    doc = frappe.get_doc(doc_dict)
    doc.insert(ignore_permissions=True, ignore_mandatory=True)
    frappe.db.commit()
    return doc


def _update_draft(
    existing_name: str,
    driver_canonical_id: str,
    payload_json: str,
):
    """
    Update an existing draft FSL.

    - Does NOT change customer or driver.
    - Only updates payload fields.
    - Enforces same-driver and Draft status.
    """
    doc = frappe.get_doc(FSL_DOCTYPE, existing_name)

    if doc.status != "Draft":
        frappe.throw("Only Draft can be edited")

    _assert_same_driver(doc, driver_canonical_id)

    patch = _parse_payload(payload_json)
    doc.update(patch)

    if doc.meta.get_field("trip_date"):
        doc.trip_date = nowdate()

    doc.save(ignore_permissions=True)
    frappe.db.commit()
    return doc


# ------------------------------
# Public API
# ------------------------------


@frappe.whitelist(allow_guest=True)
def upsert_draft_fsl(qr_token: str, driver_canonical_id: str, payload_json: str = "{}"):
    """
    Upsert a draft FSL for (customer, driver, day).

    - qr_token: signed token bound to a Customer (via verify_customer_token)
    - driver_canonical_id: canonical id of Driver (also its name)
    - payload_json: JSON with allowed fields

    Server computes trip_id from (customer + driver + day).
    If trip exists -> update; else -> create.
    qr_token is only used for verification and is NOT stored.
    """
    
    if not qr_token:
        frappe.throw("qr_token required")
    if not driver_canonical_id:
        frappe.throw("driver_canonical_id required")

    # Validate driver exists (name == canonical id)
    if not get_driver_by_canonical_id(driver_canonical_id):
        frappe.throw("Driver with this ID doesn't exist!")

    # Verify QR -> customer (site binding)
    token_data = verify_customer_token(qr_token) or {}
    customer = token_data.get("customer")
    if not customer:
        frappe.throw("Invalid QR token")

    trip_date = nowdate()
    trip_id = _make_trip_id(customer, driver_canonical_id, trip_date)

    # rate limit per customer+driver+day
    _rate_limit(
        key=f"fsl:{customer}:{driver_canonical_id}:{trip_date}",
        limit=10,
        window_sec=60,
    )

    existing = frappe.db.get_value(FSL_DOCTYPE, {"trip_id": trip_id}, "name")
    if existing:
        doc = _update_draft(
            existing_name=existing,
            driver_canonical_id=driver_canonical_id,
            payload_json=payload_json,
        )
        return {
            "ok": True,
            "mode": "edit",
            "name": doc.name,
            "trip_id": trip_id,
            "trip_date": trip_date,
        }

    doc = _create_draft(
        trip_id=trip_id,
        customer=customer,
        driver_canonical_id=driver_canonical_id,
        payload_json=payload_json,
    )
    return {
        "ok": True,
        "mode": "created",
        "name": doc.name,
        "trip_id": trip_id,
        "trip_date": trip_date,
    }


@frappe.whitelist(allow_guest=True)
def finalize_fsl(fsl_name: str, driver_canonical_id: str):
    """
    Finalize a draft FSL.

    - Caller provides fsl_name and driver_canonical_id.
    - We verify the driver exists and that this FSL belongs to that driver.
    """
    # Validate driver exists (mainly for clearer errors)
    get_driver_by_canonical_id(driver_canonical_id)

    doc = frappe.get_doc(FSL_DOCTYPE, fsl_name)
    if doc.status != "Draft":
        frappe.throw("Already finalized")

    _assert_same_driver(doc, driver_canonical_id)

    if not getattr(doc, "service_type", None):
        frappe.throw("Service type required")

    doc.status = "Final"
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {"ok": True, "name": doc.name, "status": doc.status}


@frappe.whitelist()
def get_driver_profile():
    """
    Return driver info for the logged-in user.

    Used by the FSL frontend to resolve driver_canonical_id automatically.
    """
    user = frappe.session.user
    if user == "Guest":
        frappe.throw("Not logged in")

    driver = frappe.db.get_value(
        "Driver",
        {"custom_user_id": user},
        ["name", "custom_driver_canonical_id"],
        as_dict=True,
    )

    if not driver:
        frappe.throw("No Driver linked to this user")

    if not driver.custom_driver_canonical_id:
        frappe.throw("Driver has no canonical_id")

    return driver
