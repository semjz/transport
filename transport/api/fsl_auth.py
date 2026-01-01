import secrets
import frappe
from transport.field_auth.qr import verify_customer_token

FIELD_TOKEN_TTL_SECONDS = 30 * 60  # 30 minutes

def _cache_key(token: str) -> str:
    return f"transport_field_token:{token}"

@frappe.whitelist(allow_guest=True)
def exchange_qr_for_field_token(qr_token: str):
    """
    Guest-safe GET endpoint.
    Verifies the signed QR token and returns a short-lived access token.
    """
    if not qr_token:
        frappe.throw("qr_token is required")

    data = verify_customer_token(qr_token)
    customer = data.get("customer")
    if not customer:
        frappe.throw("Invalid QR token")

    # mint short-lived token
    field_token = secrets.token_urlsafe(32)

    # store minimal claims in cache
    frappe.cache().set_value(
        _cache_key(field_token),
        {"customer": customer},
        expires_in_sec=FIELD_TOKEN_TTL_SECONDS,
    )

    return {
        "access_token": field_token,
        "token_type": "Bearer",
        "expires_in": FIELD_TOKEN_TTL_SECONDS,
        "customer": customer,  # optional, useful for debugging
    }


def require_field_bearer_token():
    """
    Validate Authorization: Bearer <token>
    Returns cached claims (e.g. customer).
    """
    auth = frappe.get_request_header("Authorization") or ""
    parts = auth.split(" ", 1)

    if len(parts) != 2 or parts[0].lower() != "bearer":
        frappe.throw("Missing/invalid Authorization Bearer token")

    token = parts[1].strip()
    if not token:
        frappe.throw("Missing bearer token")

    claims = frappe.cache().get_value(_cache_key(token))
    if not claims:
        frappe.throw("Bearer token expired or invalid")

    return claims
