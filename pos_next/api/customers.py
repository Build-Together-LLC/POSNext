"""
POS Next Customer API
Handles customer search, creation, and management for POS operations
"""

import re

import frappe
from frappe import _


def _clean_address(text):
    if not text:
        return ""
    text = re.sub(r"(?i)<br\s*/?>", ", ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"(?i)phone\s*:.*", "", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"(\s*,\s*)+", ", ", text)
    return text.strip(" ,")


def _customer_groups_for_pos_profile(pos_profile):
    """Return allowed Customer Groups from a POS Profile, including child groups."""
    if not pos_profile:
        return []

    configured_groups = frappe.get_all(
        "POS Customer Group",
        filters={"parent": pos_profile},
        pluck="customer_group",
    )
    if not configured_groups:
        return []

    groups = set(configured_groups)
    for group in configured_groups:
        groups.update(frappe.db.get_descendants("Customer Group", group) or [])

    return list(groups)


def _all_leaf_customer_groups():
    return frappe.get_all(
        "Customer Group",
        filters={"is_group": 0},
        pluck="name",
        order_by="name asc",
    )


def _allowed_customer_groups_for_creation(pos_profile):
    # POS Profile customer groups are optional; when absent, keep the old behavior
    # of allowing any leaf Customer Group in the creation dialog.
    customer_groups = _customer_groups_for_pos_profile(pos_profile)
    if customer_groups:
        return sorted(customer_groups)
    return _all_leaf_customer_groups()


def _get_select_options(doctype, fieldname):
    field = frappe.get_meta(doctype).get_field(fieldname)
    if not field or not field.options:
        return []
    return [option.strip() for option in field.options.splitlines() if option.strip()]


def _ensure_allowed_customer_group(customer_group, pos_profile):
    # Re-check the POS Profile filter on submit so direct API calls cannot pick
    # a Customer Group that the cashier could not select in the POS UI.
    allowed_groups = _customer_groups_for_pos_profile(pos_profile)
    if allowed_groups and customer_group not in allowed_groups:
        frappe.throw(
            _("Customer Group {0} is not allowed for POS Profile {1}").format(
                frappe.bold(customer_group),
                frappe.bold(pos_profile),
            ),
            frappe.PermissionError,
        )


@frappe.whitelist()
def get_customer_creation_options(pos_profile=None):
    """Return POS-scoped options for the POS customer creation dialog."""
    customer_groups = _allowed_customer_groups_for_creation(pos_profile)
    naming_series = _get_select_options("Customer", "naming_series") or ["CUST-"]
    # Territory existed in the dialog before this change; continue returning the
    # full list so the field keeps its previous behavior while options load here.
    territories = frappe.get_all(
        "Territory",
        pluck="name",
        order_by="name asc",
    )

    profile_country = None
    if pos_profile:
        profile_country = frappe.db.get_value("POS Profile", pos_profile, "country")

    return {
        "customer_groups": customer_groups,
        "default_customer_group": customer_groups[0] if customer_groups else "",
        "naming_series": naming_series,
        "default_naming_series": naming_series[0] if naming_series else "CUST-",
        "territories": territories,
        "default_territory": "All Territories" if "All Territories" in territories else (territories[0] if territories else ""),
        "default_country": profile_country or "Egypt",
    }


@frappe.whitelist()
def get_customers(search_term="", pos_profile=None, limit=20):

    """
    Search customers for inline customer selection in POS.

    Args:
        search_term (str): Search query (name, mobile, or customer ID)
        pos_profile (str): POS Profile to filter by customer group
        limit (int): Maximum number of results to return

    Returns:
        list: List of customer dictionaries with name, customer_name, mobile_no, email_id
    """
    try:
        frappe.logger().debug(
            f"get_customers called with search_term={search_term}, pos_profile={pos_profile}, limit={limit}"
        )

        filters = {}

        # Filter by Customer Groups configured on POS Profile.
        if pos_profile:
            frappe.logger().debug(f"Loading POS Profile: {pos_profile}")
            customer_groups = _customer_groups_for_pos_profile(pos_profile)
            if customer_groups:
                filters["customer_group"] = ["in", customer_groups]
                frappe.logger().debug(f"Filtering by customer_groups: {customer_groups}")

        # Return all customers (for client-side filtering)
        filters["disabled"] = 0
        customer_limit = limit if limit not in (None, 0) else frappe.db.count("Customer", filters)
        fields = ["name", "customer_name", "mobile_no", "email_id", "customer_group"]
        if frappe.get_meta("Customer").has_field("custom_vehicle_no"):
            fields.append("custom_vehicle_no")

        if frappe.get_meta("Customer").has_field("primary_address"):
            fields.append("primary_address")
        if frappe.get_meta("Customer").has_field("customer_primary_address"):
            fields.append("customer_primary_address")

        result = frappe.get_all(
            "Customer",
            filters=filters,
            fields=fields,
            limit=customer_limit,
            order_by="customer_name asc",
        )

        # Bulk fetch addresses linked via Dynamic Link (tabAddress)
        address_map = {}
        try:
            addresses = frappe.db.sql(
                """
                SELECT 
                    dl.link_name as customer,
                    addr.address_line1,
                    addr.address_line2,
                    addr.city,
                    addr.state,
                    addr.pincode,
                    addr.country,
                    addr.is_primary_address
                FROM `tabDynamic Link` dl
                JOIN `tabAddress` addr ON dl.parent = addr.name
                WHERE dl.link_doctype = 'Customer' AND dl.parenttype = 'Address'
                ORDER BY addr.is_primary_address DESC, addr.creation DESC
            """,
                as_dict=True,
            )
            for addr in addresses:
                cust_name = addr.get("customer")
                if cust_name and cust_name not in address_map:
                    parts = []
                    for k in ["address_line1", "address_line2", "city", "state", "pincode"]:
                        val = addr.get(k)
                        if val and val.strip() and val.strip().lower() != "unknown":
                            if not parts or parts[-1].lower() != val.strip().lower():
                                parts.append(val.strip())
                    if parts:
                        address_map[cust_name] = ", ".join(parts)
        except Exception as addr_err:
            frappe.logger().error(f"Error fetching addresses: {str(addr_err)}")

        for c in result:
            addr_str = address_map.get(c.name) or _clean_address(c.get("primary_address")) or ""
            c["customer_address"] = addr_str
            c["primary_address"] = addr_str
            c["address"] = addr_str

        frappe.logger().debug(f"get_customers returned {len(result)} customers")
        return result
    except Exception as e:
        frappe.logger().error(f"Error in get_customers: {str(e)}")
        frappe.logger().error(frappe.get_traceback())
        frappe.throw(_("Error fetching customers: {0}").format(str(e)))


@frappe.whitelist()
def create_customer(
    customer_name,
    mobile_no=None,
    email_id=None,
    customer_group="Individual",
    territory="All Territories",
    custom_vehicle_no=None,
    pos_profile=None,
    naming_series=None,
    address_line1=None,
    address_line2=None,
    city=None,
    state=None,
    pincode=None,
    country=None,
):
    """
    Create a new customer from POS.

    Args:
        customer_name (str): Customer name (required)
        mobile_no (str): Mobile number (optional)
        email_id (str): Email address (optional)
        customer_group (str): Customer group (default: Individual)
        territory (str): Territory (default: All Territories)
        custom_vehicle_no (str): Vehicle number (optional)
        pos_profile (str): POS Profile used to validate customer group access
        naming_series (str): Customer naming series
        address_line1 (str): Primary address line 1 (required)

    Returns:
        dict: Created customer document
    """
    # Check if user has permission to create customers
    if not frappe.has_permission("Customer", "create"):
        frappe.throw(_("You don't have permission to create customers"), frappe.PermissionError)

    if not customer_name:
        frappe.throw(_("Customer name is required"))

    if not naming_series:
        frappe.throw(_("Customer Series is required"))

    if not address_line1:
        frappe.throw(_("Address Line 1 is required"))

    if not city:
        frappe.throw(_("City/Town is required"))

    if not country:
        frappe.throw(_("Country is required"))

    customer_group = customer_group or "Individual"
    _ensure_allowed_customer_group(customer_group, pos_profile)

    # Customer Series is captured explicitly from POS because Customer naming can
    # vary by deployment and ERPNext treats naming_series as part of creation.
    customer = frappe.get_doc(
        {
            "doctype": "Customer",
            "naming_series": naming_series,
            "customer_name": customer_name,
            "customer_type": "Individual",
            "customer_group": customer_group,
            "territory": territory or "All Territories",
            "mobile_no": mobile_no or "",
            "email_id": email_id or "",
            "custom_vehicle_no": custom_vehicle_no or "",
        }
    )

    customer.insert()

    # POS customer creation now captures the required address fields and links a
    # primary Billing Address immediately, matching ERPNext's Customer/Address model.
    address = frappe.get_doc(
        {
            "doctype": "Address",
            "address_title": customer.customer_name,
            "address_type": "Billing",
            "address_line1": address_line1,
            "address_line2": address_line2 or "",
            "city": city,
            "state": state or "",
            "pincode": pincode or "",
            "country": country,
            "email_id": email_id or "",
            "phone": mobile_no or "",
            "is_primary_address": 1,
            "is_shipping_address": 1,
            "links": [
                {
                    "link_doctype": "Customer",
                    "link_name": customer.name,
                }
            ],
        }
    )
    address.insert()

    customer.customer_primary_address = address.name
    customer.primary_address = address.get_display()
    customer.save()

    customer_dict = customer.as_dict()
    customer_dict["address"] = _clean_address(customer.primary_address)
    customer_dict["customer_address"] = customer_dict["address"]
    customer_dict["primary_address"] = customer_dict["address"]

    return customer_dict


@frappe.whitelist()
def get_customer_details(customer):
    """
    Get detailed customer information.

    Args:
        customer (str): Customer ID

    Returns:
        dict: Customer details
    """
    if not customer:
        frappe.throw(_("Customer is required"))

    return frappe.get_cached_doc("Customer", customer).as_dict()
