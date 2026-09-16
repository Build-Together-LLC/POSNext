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
from frappe.utils import flt

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

    rows = _fetch(filters)
    group_by = filters.get("group_by") or "Requested Item"

    if group_by == "Detail":
        return _detail_columns(), rows, None, _chart(rows), _summary(rows)

    data = _group(rows, GROUP_BY_FIELD[group_by])

    return _grouped_columns(group_by), data, None, _chart(rows), _summary(rows)


def _fetch(filters):
    conditions = {}

    # A request somebody has written off is out unless it is asked for.
    if not filters.get("include_discarded"):
        conditions["status"] = ["!=", "Discarded"]

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
            conditions[field] = filters.get(field)

    if filters.get("from_date") and filters.get("to_date"):
        conditions["posting_date"] = [
            "between",
            [filters.get("from_date"), filters.get("to_date")],
        ]

    if filters.get("requested_item"):
        conditions["requested_item"] = ["like", f"%{filters.get('requested_item')}%"]

    return frappe.get_all(
        "POS Unlisted Item Demand",
        filters=conditions,
        fields=[
            "name",
            "posting_date",
            "posting_time",
            "requested_item",
            "normalized_item",
            "brand",
            "item_group",
            "qty",
            "uom",
            "estimated_rate",
            "estimated_value",
            "customer",
            "customer_name",
            "contact_no",
            "notes",
            "status",
            "linked_item",
            "pos_profile",
            "pos_opening_shift",
            "cashier",
        ],
        order_by="posting_date desc, posting_time desc",
        limit_page_length=0,
    )


def _group(rows, field):
    buckets = {}

    for row in rows:
        key = row.get(field) or ""
        bucket = buckets.setdefault(
            key,
            {
                field: key,
                # The most recent spelling, so the buying list reads in a
                # cashier's words rather than in normalised form.
                "requested_item": row.get("requested_item"),
                "requests": 0,
                "qty": 0,
                "estimated_value": 0,
                "open_requests": 0,
                "_customers": set(),
                "last_asked": None,
            },
        )

        bucket["requests"] += 1
        bucket["qty"] += flt(row.qty)
        bucket["estimated_value"] += flt(row.estimated_value)

        if row.status == "Open":
            bucket["open_requests"] += 1

        if row.customer:
            bucket["_customers"].add(row.customer)

        if not bucket["last_asked"] or row.posting_date > bucket["last_asked"]:
            bucket["last_asked"] = row.posting_date
            bucket["requested_item"] = row.get("requested_item")

    data = []
    for bucket in buckets.values():
        bucket["customers"] = len(bucket.pop("_customers"))
        data.append(bucket)

    # Most asked for first - that is the order to go shopping in.
    return sorted(data, key=lambda d: (d["requests"], d["qty"]), reverse=True)


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


def _chart(rows):
    if not rows:
        return None

    counts = {}
    for row in rows:
        label = row.requested_item or row.normalized_item
        counts[label] = counts.get(label, 0) + 1

    top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:10]
    if not top:
        return None

    return {
        "data": {
            "labels": [label for label, _count in top],
            "datasets": [{"name": _("Times Asked"), "values": [count for _label, count in top]}],
        },
        "type": "bar",
        "colors": ["#f5a623"],
    }


def _summary(rows):
    distinct = len({row.normalized_item for row in rows if row.normalized_item})
    still_open = sum(1 for row in rows if row.status == "Open")

    return [
        {"label": _("Requests"), "value": len(rows), "datatype": "Int", "indicator": "Orange"},
        {"label": _("Distinct Items"), "value": distinct, "datatype": "Int"},
        {"label": _("Qty Asked For"), "value": sum(flt(row.qty) for row in rows), "datatype": "Float"},
        {
            "label": _("Est. Value"),
            "value": sum(flt(row.estimated_value) for row in rows),
            "datatype": "Currency",
        },
        {"label": _("Still Open"), "value": still_open, "datatype": "Int", "indicator": "Red"},
    ]
