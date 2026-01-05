import frappe
from frappe.tests.utils import FrappeTestCase


class TestDriverUserCreation(FrappeTestCase):
    def _get_any_company(self) -> str:
        """Get an existing Company name to attach the Driver to."""
        company = frappe.get_all("Company", fields=["name"], limit=1)
        if not company:
            # If somehow no Company exists, you *could* create one here,
            # but in a normal ERPNext site there is always at least one.
            raise Exception("No Company found to use in Driver test.")
        return company[0].name
    
    def _get_any_territory(self) -> str:
        """Get an Existing Territory to attach the Driver to"""
        territory = frappe.get_all("Territory", fields=["name"], limit=1)
        if not territory:
            raise Exception("No Territoryy found to use in Driver test.")
        return territory[0].name

    def test_driver_creates_user_and_permission(self):
        """On Driver insert, a User and Company User Permission should be created."""

        company_name = self._get_any_company()
        territory = self._get_any_territory()

        # 1) Create Driver
        driver = frappe.get_doc({
            "doctype": "Driver",
            "driver_name": "Test Driver",
            "full_name": "Test Driver",
            "mobile_no": "0912 333 4444",
            "company": company_name,
            "custom_territory": territory
        })
        driver.insert(ignore_permissions=True)

        # Reload to see fields set by hooks (e.g., user link)
        driver = frappe.get_doc("Driver", driver.name)

        mobile_clean = "09123334444"

        # 2) Find the created User
        user_name = None

        # If you have a Link field "user" on Driver, prefer that:
        if driver.meta.has_field("user") and driver.user:
            user_name = driver.user
        else:
            user_name = frappe.db.get_value(
                "User",
                {"mobile_no": mobile_clean},
                "name",
            )

        self.assertIsNotNone(user_name, "User was not created for Driver")

        user = frappe.get_doc("User", user_name)

        # 3) Assert user fields
        self.assertEqual(user.mobile_no, mobile_clean)
        self.assertEqual(user.username, mobile_clean)
        self.assertEqual(user.enabled, 1)

        # 4) Assert Company User Permission exists
        perm_name = frappe.db.exists("User Permission", {
            "user": user_name,
            "allow": "Company",
            "for_value": company_name,
        })
        self.assertIsNotNone(
            perm_name,
            "Company User Permission not created for Driver's User"
        )
