import frappe

USER_FIELD = "custom_user_id"

def create_user_for_driver(doc, method=None):
    """Run on Driver.after_insert: create User + Company permission."""

    if not doc.mobile_no:
        return

    mobile_clean = doc.mobile_no.strip().replace(" ", "")

    user = frappe.get_doc({
        "doctype": "User",
        "email": f"{mobile_clean}@drivers.local",   # or doc.email if you have one
        "first_name": getattr(doc, "driver_name", None) or doc.name,
        "user_type": "System User",
        "enabled": 1,
        "mobile_no": mobile_clean,
        "username": mobile_clean,
        "send_welcome_email": 0,
        "new_password": mobile_clean,
    })
    user.flags.ignore_permissions = True
    user.insert()
    user_name = user.name

    # 🔑 give them a Desk role so Frappe keeps them as System User
    try:
        user.add_roles("Driver")   # make sure Role 'Driver' exists and has Desk Access
    except frappe.DoesNotExistError:
        frappe.log_error("Role 'Driver' not found when creating driver user", "create_user_for_driver")

    # Link back to driver if field exists
    if doc.meta.has_field(USER_FIELD):
        doc.db_set(USER_FIELD, user_name)

    # Company permission (same as your employee hook)
    if doc.company:
        if not frappe.db.exists("User Permission", {
            "user": user_name,
            "allow": "Company",
            "for_value": doc.company,
        }):
            perm = frappe.get_doc({
                "doctype": "User Permission",
                "user": user_name,
                "allow": "Company",
                "for_value": doc.company,
                "apply_to_all_doctypes": 1
            })
            perm.flags.ignore_permissions = True
            perm.insert()
    else:
        frappe.log_error(
            f"No company for Driver {doc.name}, skipping User Permission",
            "create_user_for_driver",
        )
