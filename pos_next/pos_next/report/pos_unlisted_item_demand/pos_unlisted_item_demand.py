# -*- coding: utf-8 -*-
# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""What customers asked for that the catalogue does not carry.

The buying list. Every row here is a sale that could not even be attempted,
because there was no item to sell - which makes it a different question from
POS Demand vs Actual, where the item exists and the shelf ran short.

Grouped by a normalised form of what the cashier typed, so "Bosch Wiper 24",
"bosch  wiper 24" and "BOSCH WIPER 24." count as one thing asked for three
times. The wording is free text, so expect near-misses that no normalisation
will catch - read the request count as a floor, not a precise tally.
"""

import frappe
from frappe import _
from frappe.utils import cint, flt, get_first_day, getdate, nowdate

GROUP_BY_FIELD = {
    "Requested Item": "normalized_item",
    "Brand": "brand",
    "Item Group": "item_group",
    "Customer": "customer",
    "Cashier": "cashier",
    "POS Profile": "pos_profile",
    "Date": "posting_date",
}


def execute(filters=None):
    filters = frappe._dict(filters or {})
    group_by = filters.get("group_by") or "Requested Item"

    where_clause, values = _conditions(filters)

    if group_by == "Detail":
        columns = _detail_columns()
        data = _fetch_detail(where_clause, values)
    else:
        columns = _grouped_columns(group_by)
        data = _fetch_grouped(where_clause, values, GROUP_BY_FIELD[group_by], group_by)

    return columns, data, None, _chart(where_clause, values), _summary(where_clause, values)


def _conditions(filters):
    conditions = ["1=1"]
    values = {}

    # A request somebody has written off is out unless it is asked for.
    if not filters.get("include_discarded"):
        conditions.append("status != 'Discarded'")

    for field in (
        "company",
        "pos_profile",
        "pos_opening_shift",
        "cashier",
        "customer",
        "item_group",
        "brand",
        "status",
    ):
        if filters.get(field):
            conditions.append(f"`{field}` = %({field})s")
            values[field] = filters.get(field)

    if filters.get("requested_item"):
        conditions.append("requested_item LIKE %(requested_item)s")
        values["requested_item"] = f"%{filters.get('requested_item')}%"

    from_date = filters.get("from_date")
    to_date = filters.get("to_date")
    if from_date and to_date:
        conditions.append("posting_date BETWEEN %(from_date)s AND %(to_date)s")
        values["from_date"] = getdate(from_date)
        values["to_date"] = getdate(to_date)
    elif from_date:
        conditions.append("posting_date >= %(from_date)s")
        values["from_date"] = getdate(from_date)
    elif to_date:
        conditions.append("posting_date <= %(to_date)s")
        values["to_date"] = getdate(to_date)
    else:
        conditions.append("posting_date BETWEEN %(from_date)s AND %(to_date)s")
        values["from_date"] = get_first_day(nowdate())
        values["to_date"] = nowdate()

    return " AND ".join(conditions), values


def _fetch_grouped(where_clause, values, field, group_by):
    item_col = "MAX(requested_item) as requested_item," if group_by == "Requested Item" else ""
    query = f"""
        SELECT
            `{field}` as `{field}`,
            {item_col}
            COUNT(*) as requests,
            COALESCE(SUM(qty), 0) as qty,
            COUNT(DISTINCT NULLIF(customer, '')) as customers,
            COALESCE(SUM(estimated_value), 0) as estimated_value,
            COALESCE(SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END), 0) as open_requests,
            MAX(posting_date) as last_asked
        FROM `tabPOS Unlisted Item Demand`
        WHERE {where_clause}
        GROUP BY `{field}`
        ORDER BY requests DESC, qty DESC
    """
    return frappe.db.sql(query, values, as_dict=True)


def _fetch_detail(where_clause, values):
    query = f"""
        SELECT
            name,
            posting_date,
            posting_time,
            requested_item,
            normalized_item,
            brand,
            item_group,
            qty,
            uom,
            estimated_rate,
            estimated_value,
            customer,
            customer_name,
            contact_no,
            notes,
            status,
            linked_item,
            pos_profile,
            pos_opening_shift,
            cashier
        FROM `tabPOS Unlisted Item Demand`
        WHERE {where_clause}
        ORDER BY posting_date DESC, posting_time DESC
    """
    return frappe.db.sql(query, values, as_dict=True)


def _detail_columns():
    return [
        {"fieldname": "posting_date", "label": _("Date"), "fieldtype": "Date", "width": 95},
        {"fieldname": "posting_time", "label": _("Time"), "fieldtype": "Time", "width": 80},
        {"fieldname": "requested_item", "label": _("Asked For"), "fieldtype": "Data", "width": 240},
        {"fieldname": "brand", "label": _("Brand"), "fieldtype": "Data", "width": 110},
        {"fieldname": "item_group", "label": _("Item Group"), "fieldtype": "Link", "options": "Item Group", "width": 120},
        {"fieldname": "qty", "label": _("Qty"), "fieldtype": "Float", "width": 80},
        {"fieldname": "uom", "label": _("UOM"), "fieldtype": "Link", "options": "UOM", "width": 70},
        {"fieldname": "estimated_rate", "label": _("Est. Rate"), "fieldtype": "Currency", "width": 100},
        {"fieldname": "estimated_value", "label": _("Est. Value"), "fieldtype": "Currency", "width": 110},
        {"fieldname": "customer", "label": _("Customer"), "fieldtype": "Link", "options": "Customer", "width": 150},
        {"fieldname": "contact_no", "label": _("Contact"), "fieldtype": "Data", "width": 120},
        {"fieldname": "status", "label": _("Status"), "fieldtype": "Data", "width": 100},
        {"fieldname": "linked_item", "label": _("Stocked As"), "fieldtype": "Link", "options": "Item", "width": 130},
        {"fieldname": "cashier", "label": _("Cashier"), "fieldtype": "Link", "options": "User", "width": 150},
        {"fieldname": "pos_profile", "label": _("POS Profile"), "fieldtype": "Link", "options": "POS Profile", "width": 120},
        {"fieldname": "notes", "label": _("Notes"), "fieldtype": "Data", "width": 200},
        {"fieldname": "name", "label": _("Request"), "fieldtype": "Link", "options": "POS Unlisted Item Demand", "width": 150},
    ]


def _grouped_columns(group_by):
    field = GROUP_BY_FIELD[group_by]

    first = {"fieldname": field, "label": _(group_by), "width": 240}

    if group_by == "Requested Item":
        # The normalised key groups; the cashier's wording is what gets read.
        first = {"fieldname": "requested_item", "label": _("Asked For"), "fieldtype": "Data", "width": 260}
    elif group_by == "Brand":
        first["fieldtype"] = "Data"
    elif group_by == "Date":
        first["fieldtype"] = "Date"
        first["width"] = 110
    else:
        first["fieldtype"] = "Link"
        first["options"] = {
            "Item Group": "Item Group",
            "Customer": "Customer",
            "Cashier": "User",
            "POS Profile": "POS Profile",
        }[group_by]

    return [
        first,
        {"fieldname": "requests", "label": _("Times Asked"), "fieldtype": "Int", "width": 110},
        {"fieldname": "qty", "label": _("Qty Asked For"), "fieldtype": "Float", "width": 120},
        {"fieldname": "customers", "label": _("Customers"), "fieldtype": "Int", "width": 100},
        {"fieldname": "estimated_value", "label": _("Est. Value"), "fieldtype": "Currency", "width": 120},
        {"fieldname": "open_requests", "label": _("Still Open"), "fieldtype": "Int", "width": 100},
        {"fieldname": "last_asked", "label": _("Last Asked"), "fieldtype": "Date", "width": 110},
    ]


def _chart(where_clause, values):
    query = f"""
        SELECT
            COALESCE(NULLIF(requested_item, ''), normalized_item) as label,
            COUNT(*) as count
        FROM `tabPOS Unlisted Item Demand`
        WHERE {where_clause}
        GROUP BY COALESCE(NULLIF(requested_item, ''), normalized_item)
        ORDER BY count DESC
        LIMIT 10
    """
    rows = frappe.db.sql(query, values, as_dict=True)
    if not rows:
        return None

    return {
        "data": {
            "labels": [r.label for r in rows],
            "datasets": [{"name": _("Times Asked"), "values": [cint(r.count) for r in rows]}],
        },
        "type": "bar",
        "colors": ["#f5a623"],
    }


def _summary(where_clause, values):
    query = f"""
        SELECT
            COUNT(*) as requests,
            COUNT(DISTINCT NULLIF(normalized_item, '')) as distinct_items,
            COALESCE(SUM(qty), 0) as qty,
            COALESCE(SUM(estimated_value), 0) as estimated_value,
            COALESCE(SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END), 0) as still_open
        FROM `tabPOS Unlisted Item Demand`
        WHERE {where_clause}
    """
    res = frappe.db.sql(query, values, as_dict=True)
    if not res:
        return []

    r = res[0]
    return [
        {"label": _("Requests"), "value": cint(r.requests), "datatype": "Int", "indicator": "Orange"},
        {"label": _("Distinct Items"), "value": cint(r.distinct_items), "datatype": "Int"},
        {"label": _("Qty Asked For"), "value": flt(r.qty), "datatype": "Float"},
        {
            "label": _("Est. Value"),
            "value": flt(r.estimated_value),
            "datatype": "Currency",
        },
        {"label": _("Still Open"), "value": cint(r.still_open), "datatype": "Int", "indicator": "Red"},
    ]
