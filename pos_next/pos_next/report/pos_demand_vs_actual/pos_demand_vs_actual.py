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
from frappe.utils import cint, flt, get_first_day, getdate, nowdate

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
    group_by = filters.get("group_by") or "Item"

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

    # Rows a supervisor has written off are out unless they are asked for.
    if not filters.get("include_voided"):
        conditions.append("is_void = 0")

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
            conditions.append(f"`{field}` = %({field})s")
            values[field] = filters.get(field)

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
    item_name_col = "MAX(item_name) as item_name," if group_by == "Item" else ""
    query = f"""
        SELECT
            `{field}` as `{field}`,
            {item_name_col}
            COALESCE(SUM(demanded_stock_qty), 0) as demanded_qty,
            COALESCE(SUM(sold_stock_qty), 0) as sold_qty,
            COALESCE(SUM(lost_stock_qty), 0) as lost_qty,
            COALESCE(SUM(lost_value), 0) as lost_value,
            COUNT(*) as occurrences,
            COALESCE(SUM(CASE WHEN loss_type = 'Full' THEN 1 ELSE 0 END), 0) as full_losses,
            COUNT(DISTINCT NULLIF(customer, '')) as customers
        FROM `tabPOS Order Loss`
        WHERE {where_clause}
        GROUP BY `{field}`
        ORDER BY lost_value DESC, lost_qty DESC
    """
    rows = frappe.db.sql(query, values, as_dict=True)

    for row in rows:
        row["fill_rate"] = (
            (row["sold_qty"] / row["demanded_qty"] * 100)
            if row["demanded_qty"]
            else 0
        )

    return rows


def _fetch_detail(where_clause, values):
    query = f"""
        SELECT
            name,
            posting_date,
            posting_time,
            pos_profile,
            pos_opening_shift,
            cashier,
            customer,
            item_code,
            item_name,
            item_group,
            brand,
            warehouse,
            uom,
            demanded_qty,
            available_qty,
            sold_qty,
            lost_qty,
            demanded_stock_qty,
            sold_stock_qty,
            lost_stock_qty,
            fill_rate,
            rate,
            lost_value,
            reason,
            loss_type,
            source,
            sales_invoice,
            is_void
        FROM `tabPOS Order Loss`
        WHERE {where_clause}
        ORDER BY posting_date DESC, posting_time DESC
    """
    return frappe.db.sql(query, values, as_dict=True)


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


def _chart(where_clause, values):
    query = f"""
        SELECT
            COALESCE(NULLIF(item_name, ''), item_code) as label,
            SUM(lost_value) as lost_value
        FROM `tabPOS Order Loss`
        WHERE {where_clause}
        GROUP BY COALESCE(NULLIF(item_name, ''), item_code)
        HAVING SUM(lost_value) > 0
        ORDER BY lost_value DESC
        LIMIT 10
    """
    rows = frappe.db.sql(query, values, as_dict=True)
    if not rows:
        return None

    return {
        "data": {
            "labels": [r.label for r in rows],
            "datasets": [{"name": _("Lost Value"), "values": [flt(r.lost_value) for r in rows]}],
        },
        "type": "bar",
        "colors": ["#e03636"],
    }


def _summary(where_clause, values):
    query = f"""
        SELECT
            COALESCE(SUM(demanded_stock_qty), 0) as demanded,
            COALESCE(SUM(sold_stock_qty), 0) as sold,
            COALESCE(SUM(lost_stock_qty), 0) as lost,
            COALESCE(SUM(lost_value), 0) as value,
            COALESCE(SUM(CASE WHEN loss_type = 'Full' THEN 1 ELSE 0 END), 0) as full_losses
        FROM `tabPOS Order Loss`
        WHERE {where_clause}
    """
    res = frappe.db.sql(query, values, as_dict=True)
    if not res:
        return []

    r = res[0]
    demanded = flt(r.demanded)
    sold = flt(r.sold)
    lost = flt(r.lost)
    value = flt(r.value)
    full = cint(r.full_losses)

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
