import base64, hmac, hashlib, json, time
import frappe

def _b64url(b: bytes) -> str:
    # URL-safe base64 without '=' padding (easier to embed in QR URL)
    return base64.urlsafe_b64encode(b).decode().rstrip("=")

def _b64url_decode(s: str) -> bytes:
    # add padding back for decoding
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def sign_customer_token(customer: str, exp: int) -> str:
    """
    Creates a QR token. Use it when generating QR codes for customers.
    Output is base64url(JSON payload including signature).
    """

    expires_at = int(time.time() + int(exp))
    unsigned = {"v": 1, "customer": customer, "exp": int(expires_at)}
    raw = json.dumps(unsigned, separators=(",", ":"), sort_keys=True).encode()

    secret = frappe.conf.get("qr_hmac_secret")
    if not secret:
        raise RuntimeError("qr_hmac_secret not set in site_config.json")

    sig = hmac.new(secret.encode(), raw, hashlib.sha256).digest()
    unsigned["sig"] = _b64url(sig)

    payload = json.dumps(unsigned, separators=(",", ":"), sort_keys=True).encode()
    return _b64url(payload)

def verify_customer_token(token: str) -> dict:
    """
    Verifies token integrity and expiry.
    Returns {"customer": "<Customer DocName>"} if valid.
    """
    secret = frappe.conf.get("qr_hmac_secret")
    if not secret:
        raise RuntimeError("qr_hmac_secret not set in site_config.json")

    payload_json = _b64url_decode(token).decode()
    payload = json.loads(payload_json)

    # Version check
    if payload.get("v") != 1:
        raise frappe.PermissionError("Invalid token version")

    customer = payload.get("customer")
    if not customer:
        raise frappe.PermissionError("Missing customer")

    # Expiry check
    exp = int(payload.get("exp", 0))
    if exp and time.time() > exp:
        raise frappe.PermissionError("Token expired")

    sig = payload.get("sig")
    if not sig:
        raise frappe.PermissionError("Missing signature")

    # Recompute signature from unsigned payload
    unsigned = {"v": 1, "customer": customer, "exp": exp}
    raw = json.dumps(unsigned, separators=(",", ":"), sort_keys=True).encode()
    mac = hmac.new(secret.encode(), raw, hashlib.sha256).digest()

    # constant-time compare
    if not hmac.compare_digest(_b64url(mac), sig):
        raise frappe.PermissionError("Bad signature")

    return {"customer": customer}
