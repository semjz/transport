import frappe
from frappe import _


def get_driver_by_canonical_id(canonical_id: str):
    """
    Resolve Driver by canonical_id.

    Returns:
        dict with keys: name, canonical_id
        or None if not found
    """
    if not canonical_id:
        return None

    canonical_id = canonical_id.strip()

    driver = frappe.db.get_value(
        "Driver",
        {"custom_driver_canonical_id": canonical_id},
        ["name", "custom_driver_canonical_id"],
        as_dict=True,
    )

    return driver
