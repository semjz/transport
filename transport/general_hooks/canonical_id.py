import frappe

# Map doctype -> T code
ENTITY_TYPE_MAP = {
    "Driver": "D",
}


def get_ss_from_territory(territory_name: str) -> str:
    """Get SS from Territory SS Code mapping."""
    ss_code = frappe.db.get_value(
        "Territory SS Code",
        {"territory": territory_name},
        "ss_code",
    )

    if not ss_code:
        frappe.throw(
            f"SS code not found for Territory '{territory_name}' in 'Territory SS Code'"
        )

    return ss_code


def get_simple_serial(doctype: str) -> str:
    """
    SUPER simple serial:
    - Just count how many records of this doctype already exist
      with this SS+T prefix and add 1.
    - No extra DocTypes, no fancy counters.
    """

    existing_count = frappe.db.count(
        doctype
    )

    new_number = existing_count + 1
    return f"{new_number:05d}"  # zero-pad to 5 digits


def set_canonical_id(doc, method=None):
    """
    Hook target:
    - runs on before_insert
    - uses Territory -> Territory SS Code -> ss_code
    - generates: SS-T-NNNNN
    """

    # don't overwrite if it's already set (e.g. data import)
    if doc.custom_driver_canonical_id:
        return

    doctype = doc.doctype
    entity_type = ENTITY_TYPE_MAP.get(doctype)
    if not entity_type:
        # not a managed entity type
        return
    
    territory_name = doc.custom_territory
    if not territory_name:
        frappe.throw(f"Territory is required to generate Canonical ID for {doctype}")

    # 1) SS from Territory SS Code
    ss_code = get_ss_from_territory(territory_name)

    # 2) NNNNN based on how many existing records share this SS + T prefix
    serial_str = get_simple_serial(doctype)

    # 3) Final canonical ID (no K for now)
    doc.custom_driver_canonical_id = f"{ss_code}-{entity_type}-{serial_str}"
