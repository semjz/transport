import frappe

def execute():
    frappe.db.set_value("DocType", "Driver", "autoname", "field:custom_driver_canonical_id")
