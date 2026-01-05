import frappe


def create_employee_for_driver(doc, method=None):
    """
    Simple Driver.after_insert hook:

    - Always creates an Employee for this Driver.
    - Copies company & mobile_no from Driver.
    - If Driver.custom_user_id is set AND Employee has user_id field,
      reuse that same User (prevents duplicate Users).
    """

    emp_meta = frappe.get_meta("Employee")

    employee_values = {
        "doctype": "Employee",
        "employee_name": doc.full_name,
        "status": "Active",
        "company": doc.company,
        "custom_sepidar_code": doc.custom_sepidar_code,
        "custom_territory": doc.custom_territory,
        "cell_number": doc.mobile_no,
    }

    # Reuse existing user if Driver already has one
    if emp_meta.has_field("user_id") and doc.custom_user_id:
        employee_values["user_id"] = doc.custom_user_id

    # Optional: link back to Driver if such a field exists on Employee
    if emp_meta.has_field("custom_driver"):
        employee_values["custom_driver"] = doc.name

    # Create Employee
    emp = frappe.get_doc(employee_values)
    emp.flags.ignore_permissions = True
    emp.insert(ignore_mandatory=True)

    # Optional: if Driver has an 'employee' field, store the link
    if doc.meta.has_field("employee"):
        doc.db_set("employee", emp.name)
