# Copyright (c) 2025, Saman Malakjan and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class FieldServiceLog(Document):
    def validate(self):
        if self.has_value_changed("driver"):
            self.set_driver_from_canonical_id()

    def set_driver_from_canonical_id(self):
        cid = (self.driver or "").strip()
        if not cid:
            return

        driver = frappe.db.get_value(
            "Driver",
            {"custom_driver_canonical_id": cid},
            "name"
        )

        if not driver:
            frappe.throw(_("Invalid Driver Canonical ID"))

        self.driver = driver
