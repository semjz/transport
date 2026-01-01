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

def _parse_payload(payload_json: str) -> dict:
    data = json.loads(payload_json or "{}")
    if not isinstance(data, dict):
        return {}

    out = {k: v for k, v in data.items() if k in ALLOWED_FIELDS}

    ts = out.get("timestamp")
    if ts:
        try:
            dt = get_datetime(ts)
            if getattr(dt, "tzinfo", None):
                dt = dt.replace(tzinfo=None)
            out["timestamp"] = dt
        except Exception:
            frappe.throw("Invalid timestamp format")

    return out


def _make_trip_id(customer: str, driver_canonical_id: str, trip_date: str) -> str:
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
        pass

    if n > limit:
        frappe.local.response["http_status_code"] = 429
        frappe.throw("Too many requests. Please wait and try again.")


def _assert_same_driver(doc, driver_canonical_id: str):
    current = frappe.db.get_value(
        "Driver",
        doc.driver,  # this is the Driver.name (string)
        "custom_driver_canonical_id"
    ) or ""

    if current.strip() != (driver_canonical_id or "").strip():
        raise frappe.PermissionError("Not owner")

def _create_draft(trip_id: str, customer: str, driver_canonical_id: str, payload_json: str):
    """
    Create sets customer ONCE. No qr_token stored.
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

    # optional field: trip_date
    meta = frappe.get_meta(FSL_DOCTYPE)
    if meta.get_field("trip_date"):
        doc_dict["trip_date"] = nowdate()

    doc = frappe.get_doc(doc_dict)
    doc.insert(ignore_permissions=True, ignore_mandatory=True)
    frappe.db.commit()
    return doc


def _update_draft(existing_name: str, driver_canonical_id: str, payload_json: str):
    """
    Update does NOT accept/modify customer.
    Only updates allowed payload fields, and enforces same-driver + Draft status.
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


@frappe.whitelist(allow_guest=True)
def upsert_draft_fsl(qr_token: str, driver_canonical_id: str, payload_json: str = "{}"):
    """
    Server computes trip_id from (customer + driver + day).
    If trip exists -> update; else -> create.
    qr_token is only used for verification (NOT stored).
    """
    if not qr_token:
        frappe.throw("qr_token required")
    if not driver_canonical_id:
        frappe.throw("driver_canonical_id required")

    # Validate driver exists (optional but recommended)
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
        # Optional extra hard check: existing doc must belong to same customer (should always be true)
        # doc0 = frappe.get_doc(FSL_DOCTYPE, existing)
        # if doc0.customer != customer:
        #     frappe.throw("Trip mismatch")

        doc = _update_draft(existing_name=existing, driver_canonical_id=driver_canonical_id, payload_json=payload_json)
        return {"ok": True, "mode": "edit", "name": doc.name, "trip_id": trip_id, "trip_date": trip_date}

    doc = _create_draft(trip_id=trip_id, customer=customer, driver_canonical_id=driver_canonical_id, payload_json=payload_json)
    return {"ok": True, "mode": "created", "name": doc.name, "trip_id": trip_id, "trip_date": trip_date}


@frappe.whitelist(allow_guest=True)
def finalize_fsl(fsl_name: str, driver_canonical_id: str):
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
