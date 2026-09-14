# -*- coding: utf-8 -*-
# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""What customers asked the till for, and what they actually got.

Reads POS Order Loss, which only holds the shortfalls: an item that was always
in stock never appears here. So "Demanded" is demand the till came up short on,
not total demand, and the fill rate is the fill rate *on those items*.

Two things worth knowing before acting on the numbers:

  * Batch and serial items are missing. The POS stock guards skip them, so no
    shortfall is ever detected for them and the report cannot show what it was
    never told.
  * An item refused before it reached the cart was never priced, so its lost
    value can be zero while its lost quantity is real. Quantity and value are
    kept in separate columns for exactly that reason - do not read a zero value
    as a zero loss.
"""

import frappe
from frappe import _
from frappe.utils import flt

GROUP_BY_FIELD = {
    "Item": "item_code",
    "Item Group": "item_group",
    "Brand": "brand",
    "Customer": "customer",
    "Cashier": "cashier",
    "Warehouse": "warehouse",
    "POS Profile": "pos_profile",
    "Date": "posting_date",
}


def execute(filters=None):
    filters = frappe._dict(filters or {})

    rows = _fetch(filters)
    group_by = filters.get("group_by") or "Item"

    if group_by == "Detail":
        columns = _detail_columns()
        data = rows
    else:
        columns = _grouped_columns(group_by)
        data = _group(rows, GROUP_BY_FIELD[group_by])

    return columns, data, None, _chart(rows), _summary(rows)


def _fetch(filters):
    conditions = {}

    # Rows a supervisor has written off are out unless they are asked for.
    if not filters.get("include_voided"):
        conditions["is_void"] = 0

    for field in (
        "company",
        "pos_profile",
        "pos_opening_shift",
        "cashier",
        "warehouse",
        "item_code",
        "item_group",
        "brand",
        "customer",
        "reason",
        "loss_type",
    ):
        if filters.get(field):
            conditions[field] = filters.get(field)

    if filters.get("from_date") and filters.get("to_date"):
        conditions["posting_date"] = [
            "between",
            [filters.get("from_date"), filters.get("to_date")],
        ]

    return frappe.get_all(
        "POS Order Loss",
        filters=conditions,
        fields=[
            "name",
            "posting_date",
            "posting_time",
            "pos_profile",
            "pos_opening_shift",
            "cashier",
            "customer",
            "item_code",
            "item_name",
            "item_group",
            "brand",
            "warehouse",
            "uom",
            "demanded_qty",
            "available_qty",
            "sold_qty",
            "lost_qty",
            "demanded_stock_qty",
            "sold_stock_qty",
            "lost_stock_qty",
            "fill_rate",
            "rate",
            "lost_value",
            "reason",
            "loss_type",
            "source",
            "sales_invoice",
            "is_void",
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
                "item_name": row.get("item_name") if field == "item_code" else None,
                "demanded_qty": 0,
                "sold_qty": 0,
                "lost_qty": 0,
                "lost_value": 0,
                "occurrences": 0,
                "full_losses": 0,
                "_customers": set(),
            },
        )

        bucket["demanded_qty"] += flt(row.demanded_stock_qty)
        bucket["sold_qty"] += flt(row.sold_stock_qty)
        bucket["lost_qty"] += flt(row.lost_stock_qty)
        bucket["lost_value"] += flt(row.lost_value)
        bucket["occurrences"] += 1

        if row.loss_type == "Full":
            bucket["full_losses"] += 1

        if row.customer:
            bucket["_customers"].add(row.customer)

    data = []
    for bucket in buckets.values():
        bucket["customers"] = len(bucket.pop("_customers"))
        bucket["fill_rate"] = (
            bucket["sold_qty"] / bucket["demanded_qty"] * 100
            if bucket["demanded_qty"]
            else 0
        )
        data.append(bucket)

    # Biggest hole in the shelf first - that is the reorder list.
    return sorted(data, key=lambda d: (d["lost_value"], d["lost_qty"]), reverse=True)


def _detail_columns():
    return [
        {"fieldname": "posting_date", "label": _("Date"), "fieldtype": "Date", "width": 95},
        {"fieldname": "posting_time", "label": _("Time"), "fieldtype": "Time", "width": 80},
        {"fieldname": "item_code", "label": _("Item"), "fieldtype": "Link", "options": "Item", "width": 130},
        {"fieldname": "item_name", "label": _("Item Name"), "fieldtype": "Data", "width": 190},
        {"fieldname": "item_group", "label": _("Item Group"), "fieldtype": "Link", "options": "Item Group", "width": 120},
        {"fieldname": "brand", "label": _("Brand"), "fieldtype": "Link", "options": "Brand", "width": 100},
        {"fieldname": "warehouse", "label": _("Warehouse"), "fieldtype": "Link", "options": "Warehouse", "width": 130},
        {"fieldname": "uom", "label": _("UOM"), "fieldtype": "Link", "options": "UOM", "width": 70},
        {"fieldname": "demanded_qty", "label": _("Wanted"), "fieldtype": "Float", "width": 90},
        {"fieldname": "available_qty", "label": _("Available"), "fieldtype": "Float", "width": 90},
        {"fieldname": "sold_qty", "label": _("Sold"), "fieldtype": "Float", "width": 80},
        {"fieldname": "lost_qty", "label": _("Lost"), "fieldtype": "Float", "width": 80},
        {"fieldname": "fill_rate", "label": _("Fill Rate"), "fieldtype": "Percent", "width": 90},
        {"fieldname": "rate", "label": _("Rate"), "fieldtype": "Currency", "width": 100},
        {"fieldname": "lost_value", "label": _("Lost Value"), "fieldtype": "Currency", "width": 110},
        {"fieldname": "reason", "label": _("Reason"), "fieldtype": "Data", "width": 140},
        {"fieldname": "source", "label": _("Source"), "fieldtype": "Data", "width": 120},
        {"fieldname": "customer", "label": _("Customer"), "fieldtype": "Link", "options": "Customer", "width": 150},
        {"fieldname": "cashier", "label": _("Cashier"), "fieldtype": "Link", "options": "User", "width": 150},
        {"fieldname": "pos_profile", "label": _("POS Profile"), "fieldtype": "Link", "options": "POS Profile", "width": 120},
        {"fieldname": "sales_invoice", "label": _("Sales Invoice"), "fieldtype": "Link", "options": "Sales Invoice", "width": 140},
        {"fieldname": "name", "label": _("Loss"), "fieldtype": "Link", "options": "POS Order Loss", "width": 140},
    ]


def _grouped_columns(group_by):
    field = GROUP_BY_FIELD[group_by]

    first = {
        "fieldname": field,
        "label": _(group_by),
        "fieldtype": {
            "Item": "Link",
            "Item Group": "Link",
            "Brand": "Link",
            "Customer": "Link",
            "Cashier": "Link",
            "Warehouse": "Link",
            "POS Profile": "Link",
            "Date": "Date",
        }[group_by],
        "width": 160,
    }

    options = {
        "Item": "Item",
        "Item Group": "Item Group",
        "Brand": "Brand",
        "Customer": "Customer",
        "Cashier": "User",
        "Warehouse": "Warehouse",
        "POS Profile": "POS Profile",
    }.get(group_by)

    if options:
        first["options"] = options

    columns = [first]

    if group_by == "Item":
        columns.append(
            {"fieldname": "item_name", "label": _("Item Name"), "fieldtype": "Data", "width": 200}
        )

    columns += [
        {"fieldname": "demanded_qty", "label": _("Wanted (Stock UOM)"), "fieldtype": "Float", "width": 140},
        {"fieldname": "sold_qty", "label": _("Sold"), "fieldtype": "Float", "width": 100},
        {"fieldname": "lost_qty", "label": _("Lost"), "fieldtype": "Float", "width": 100},
        {"fieldname": "fill_rate", "label": _("Fill Rate"), "fieldtype": "Percent", "width": 100},
        {"fieldname": "lost_value", "label": _("Lost Value"), "fieldtype": "Currency", "width": 130},
        {"fieldname": "occurrences", "label": _("Times Short"), "fieldtype": "Int", "width": 110},
        {"fieldname": "full_losses", "label": _("Sold Nothing"), "fieldtype": "Int", "width": 120},
        {"fieldname": "customers", "label": _("Customers"), "fieldtype": "Int", "width": 100},
    ]

    return columns


def _chart(rows):
    if not rows:
        return None

    by_item = {}
    for row in rows:
        by_item[row.item_name or row.item_code] = by_item.get(
            row.item_name or row.item_code, 0
        ) + flt(row.lost_value)

    top = sorted(by_item.items(), key=lambda kv: kv[1], reverse=True)[:10]
    if not top:
        return None

    return {
        "data": {
            "labels": [label for label, _value in top],
            "datasets": [{"name": _("Lost Value"), "values": [value for _label, value in top]}],
        },
        "type": "bar",
        "colors": ["#e03636"],
    }


def _summary(rows):
    demanded = sum(flt(row.demanded_stock_qty) for row in rows)
    sold = sum(flt(row.sold_stock_qty) for row in rows)
    lost = sum(flt(row.lost_stock_qty) for row in rows)
    value = sum(flt(row.lost_value) for row in rows)
    full = sum(1 for row in rows if row.loss_type == "Full")

    return [
        {"label": _("Demand Short"), "value": demanded, "datatype": "Float"},
        {"label": _("Sold"), "value": sold, "datatype": "Float"},
        {"label": _("Lost"), "value": lost, "datatype": "Float", "indicator": "Red"},
        {
            "label": _("Fill Rate"),
            "value": (sold / demanded * 100) if demanded else 0,
            "datatype": "Percent",
        },
        {"label": _("Lost Value"), "value": value, "datatype": "Currency", "indicator": "Red"},
        {
            "label": _("Sold Nothing At All"),
            "value": full,
            "datatype": "Int",
            "indicator": "Orange",
        },
    ]
