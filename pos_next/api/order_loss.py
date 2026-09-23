# -*- coding: utf-8 -*-
# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Recording unmet demand from the till.

The POS refuses or clamps a quantity whenever the shelf cannot cover what the
customer asked for. That refusal is the only moment the demand exists - the
cart ends up holding what was actually sold, and an item with no stock at all
never reaches the cart in the first place. These endpoints capture it before it
is gone.

Two rules shape everything here:

  * Rows are upserted on an idempotency key, and quantities merge rather than
    accumulate, so a retried flush or a repeated scan can never inflate a
    number. See _merge_into.
  * Nothing in this module may ever stop a sale. Only a permission failure or a
    malformed request throws; a row the server cannot make sense of is skipped
    and reported back, never raised.
"""

import json

import frappe
from frappe import _
from frappe.utils import cint, cstr, flt, getdate, now_datetime, nowdate

from pos_next.api.invoices import _assert_pos_profile_access
from pos_next.pos_next.doctype.pos_order_loss.pos_order_loss import make_idempotency_key

# A single flush carries one cart's short items. Anything beyond this is not a
# cart, it is a bug or an attack.
MAX_LOSSES_PER_REQUEST = 200

DOCTYPE = "POS Order Loss"


# ==========================================
# Settings and context
# ==========================================


def _is_enabled(pos_profile):
    """Whether this profile records lost demand at all."""
    if not pos_profile:
        return False

    return bool(
        cint(
            frappe.db.get_value(
                "POS Settings", {"pos_profile": pos_profile}, "track_order_loss"
            )
            or 0
        )
    )


def _max_demand_qty(pos_profile):
    """Demand above this is treated as a mistyped quantity and dropped (0 = no limit)."""
    return flt(
        frappe.db.get_value(
            "POS Settings", {"pos_profile": pos_profile}, "order_loss_max_demand_qty"
        )
        or 0
    )


def _profile_context(pos_profile):
    """Company, currency, warehouse and price list to fall back on."""
    profile = frappe.get_cached_value(
        "POS Profile",
        pos_profile,
        ["company", "currency", "warehouse", "selling_price_list"],
        as_dict=True,
    ) or frappe._dict()

    if not profile.get("currency") and profile.get("company"):
        profile.currency = frappe.get_cached_value(
            "Company", profile.company, "default_currency"
        )

    return profile


def _item_meta(item_codes):
    """Item fields the loss row denormalises, fetched once for the whole batch."""
    codes = [c for c in set(item_codes or []) if c]
    if not codes:
        return {}

    rows = frappe.get_all(
        "Item",
        filters={"name": ["in", codes]},
        fields=[
            "name",
            "item_name",
            "item_group",
            "brand",
            "stock_uom",
            "is_stock_item",
        ],
    )

    return {row.name: row for row in rows}


def _item_prices(item_codes, price_list, currency=None):
    """Fetch price_list_rate for items in batch, bucketed by (item_code, uom) and item_code fallback."""
    codes = [c for c in set(item_codes or []) if c]
    if not (codes and price_list):
        return {}

    filters = {
        "item_code": ["in", codes],
        "price_list": price_list,
        "selling": 1,
    }
    if currency:
        filters["currency"] = currency

    rows = frappe.get_all(
        "Item Price",
        filters=filters,
        fields=["item_code", "uom", "price_list_rate"],
    )

    prices = {}
    for r in rows:
        rate = flt(r.price_list_rate)
        if r.uom:
            prices[(r.item_code, r.uom)] = rate
        if r.item_code not in prices:
            prices[r.item_code] = rate

    return prices


def _fallback_rate(item_code, uom, price_list, currency):
    """Price an item the cart never priced.

    The zero-stock case reaches us with no rate at all: the item was refused at
    the tile, so it never became a cart line with a price on it. Without this
    the loss would be counted in quantity but valued at nothing.
    """
    if not (item_code and price_list):
        return 0

    filters = {"item_code": item_code, "price_list": price_list, "selling": 1}
    if currency:
        filters["currency"] = currency

    rate = frappe.db.get_value(
        "Item Price", dict(filters, uom=uom), "price_list_rate"
    ) if uom else None

    if not rate:
        rate = frappe.db.get_value("Item Price", filters, "price_list_rate")

    return flt(rate)


# ==========================================
# Recording
# ==========================================


def _sanitise(
    entry,
    ctx,
    meta,
    ceiling,
    cart_session_id,
    pos_profile,
    pos_opening_shift,
    customer,
    prices=None,
):
    """Turn one client entry into a row, or return (None, why) to skip it.

    Skipping is deliberate rather than throwing: a cart with one unusable line
    should still record the rest, and a till should never see an error from
    this feature.
    """
    item_code = cstr(entry.get("item_code")).strip()
    if not item_code:
        return None, "missing item"

    item = meta.get(item_code)
    if not item:
        return None, "unknown item"

    if not cint(item.is_stock_item):
        # Nothing can be short of a non-stock item.
        return None, "not a stock item"

    warehouse = cstr(entry.get("warehouse")).strip() or ctx.get("warehouse")
    if not warehouse:
        return None, "missing warehouse"

    demanded = flt(entry.get("demanded_qty"))
    available = max(flt(entry.get("available_qty")), 0)

    if demanded <= 0:
        return None, "demand is not positive"

    if demanded <= available:
        # Nothing was lost - the till could have covered this.
        return None, "demand was coverable"

    if ceiling and demanded > ceiling:
        return None, "demand above the profile's ceiling"

    uom = cstr(entry.get("uom")).strip() or item.stock_uom
    conversion_factor = flt(entry.get("conversion_factor")) or 1
    rate = flt(entry.get("rate"))

    if not rate:
        if prices is not None:
            rate = prices.get((item_code, uom)) or prices.get(item_code) or 0
        if not rate:
            rate = _fallback_rate(item_code, uom, ctx.get("selling_price_list"), ctx.get("currency"))

    row = {
        "doctype": DOCTYPE,
        "item_code": item_code,
        "item_name": item.item_name,
        "item_group": item.item_group,
        "brand": item.brand,
        "uom": uom,
        "stock_uom": item.stock_uom,
        "conversion_factor": conversion_factor,
        "batch_no": entry.get("batch_no") or None,
        "company": ctx.get("company"),
        "warehouse": warehouse,
        "customer": customer or None,
        "pos_profile": pos_profile,
        "pos_opening_shift": pos_opening_shift or None,
        "cashier": frappe.session.user,
        "demanded_qty": demanded,
        "last_demanded_qty": demanded,
        "available_qty": available,
        # What the cart is holding for this item as the shortfall is recorded.
        # Provisional: reconcile_invoice replaces it with what the submitted
        # invoice actually took, which is the number that counts.
        "sold_qty": max(flt(entry.get("sold_qty")), 0),
        "currency": ctx.get("currency"),
        "rate": rate,
        "reason": entry.get("reason") or ("Out of Stock" if not available else "Insufficient Stock"),
        "source": entry.get("source") or "Manual",
        "cart_session_id": cart_session_id,
        "idempotency_key": make_idempotency_key(
            cart_session_id, item_code, uom, warehouse, entry.get("batch_no")
        ),
    }

    # Offline rows carry the time the customer actually asked, which may be days
    # before the flush that finally lands them.
    if entry.get("posting_date"):
        row["posting_date"] = getdate(entry.get("posting_date"))
        row["posting_time"] = entry.get("posting_time")

    return row, None


def _merge_into(doc, row):
    """Bring the row up to date with the latest ask for this item.

    The cashier confirms every change of quantity, so the newest confirmed
    number is the demand - 200 corrected to 300 is a customer who wants 300, not
    one who wants both. Writing the value rather than accumulating also keeps the
    upsert idempotent: replaying the same flush after a timeout lands the same
    number. `last_demanded_qty` keeps the previous ask for comparison.
    """
    doc.last_demanded_qty = flt(doc.demanded_qty)
    doc.demanded_qty = flt(row["demanded_qty"])
    doc.available_qty = flt(row["available_qty"])

    # Follows the cart too, so a line edited down after the shortfall does not
    # leave the row claiming a bigger sale than the cart holds. A row already
    # settled against a submitted invoice keeps that figure.
    if not doc.sales_invoice:
        doc.sold_qty = flt(row.get("sold_qty"))
    doc.rate = flt(doc.rate) or flt(row["rate"])
    doc.customer = doc.customer or row.get("customer")
    doc.pos_opening_shift = doc.pos_opening_shift or row.get("pos_opening_shift")


@frappe.whitelist()
def record_losses(
    losses,
    pos_profile,
    cart_session_id=None,
    pos_opening_shift=None,
    customer=None,
):
    """Upsert this cart's short items.

    Returns what was written and what was skipped, so the till can drop the
    entries that landed and keep the rest. Never raises for a bad row.
    """
    _assert_pos_profile_access(pos_profile)

    if not _is_enabled(pos_profile):
        return {"enabled": False, "rows": [], "skipped": []}

    if isinstance(losses, str):
        losses = json.loads(losses or "[]")

    if not isinstance(losses, list):
        frappe.throw(_("Losses must be a list"))

    if len(losses) > MAX_LOSSES_PER_REQUEST:
        frappe.throw(
            _("Too many loss rows in one request (limit {0})").format(
                MAX_LOSSES_PER_REQUEST
            )
        )

    if not cart_session_id:
        frappe.throw(_("Cart Session ID is required"))

    ctx = _profile_context(pos_profile)
    meta = _item_meta([entry.get("item_code") for entry in losses])
    prices = _item_prices(
        [entry.get("item_code") for entry in losses],
        ctx.get("selling_price_list"),
        ctx.get("currency"),
    )
    ceiling = _max_demand_qty(pos_profile)

    written = []
    skipped = []

    for entry in losses:
        row, why = _sanitise(
            entry,
            ctx,
            meta,
            ceiling,
            cart_session_id,
            pos_profile,
            pos_opening_shift,
            customer,
            prices=prices,
        )

        if row is None:
            skipped.append({"item_code": entry.get("item_code"), "reason": why})
            continue

        # A savepoint per row, so one that blows up is undone on its own and the
        # rest of the cart is still recorded.
        save_point = "pos_order_loss_row"
        frappe.db.savepoint(save_point)

        try:
            doc, note = _upsert_row(row)
        except Exception:
            frappe.db.rollback(save_point=save_point)
            frappe.log_error(frappe.get_traceback(), "POS Order Loss Record Error")
            skipped.append({"item_code": row["item_code"], "reason": "server error"})
            continue

        frappe.db.release_savepoint(save_point)

        if doc is None:
            skipped.append({"item_code": row["item_code"], "reason": note})
        else:
            written.append({"key": row["idempotency_key"], "name": doc.name})

    return {"enabled": True, "rows": written, "skipped": skipped}


def _upsert_row(row):
    """Write the row, or fold it into the one already recording this shortfall."""
    name = frappe.db.get_value(DOCTYPE, {"idempotency_key": row["idempotency_key"]}, "name")

    if not name:
        insert_savepoint = "pos_order_loss_insert"
        frappe.db.savepoint(insert_savepoint)
        try:
            doc = frappe.get_doc(row)
            doc.flags.ignore_permissions = True
            doc.insert()
            frappe.db.release_savepoint(insert_savepoint)
            return doc, None
        except (frappe.DuplicateEntryError, frappe.UniqueValidationError):
            frappe.db.rollback(save_point=insert_savepoint)
            name = frappe.db.get_value(DOCTYPE, {"idempotency_key": row["idempotency_key"]}, "name")
            if not name:
                raise

    doc = frappe.get_doc(DOCTYPE, name)

    if doc.is_void:
        # A supervisor has already ruled on this one; do not resurrect it.
        return None, "voided"

    _merge_into(doc, row)
    doc.flags.ignore_permissions = True
    doc.save()

    return doc, None


# ==========================================
# Reconciling against the sale
# ==========================================


def _sold_map(invoice_doc):
    """What the invoice actually sold, both per line and rolled up per item.

    The per-line key is the exact match; the roll-up covers a loss recorded
    against one warehouse or UOM that was ultimately sold from another.
    """
    exact = {}
    by_item = {}

    for row in invoice_doc.get("items") or []:
        key = (row.item_code, row.uom, row.warehouse, row.get("batch_no") or None)
        exact[key] = flt(exact.get(key, 0)) + flt(row.qty)

        stock_qty = flt(row.get("stock_qty")) or flt(row.qty) * (flt(row.get("conversion_factor")) or 1)
        by_item[row.item_code] = flt(by_item.get(row.item_code, 0)) + stock_qty

    return exact, by_item


@frappe.whitelist()
def reconcile_invoice(sales_invoice, cart_session_id=None):
    """Settle this cart's loss rows against the invoice that came out of it.

    Idempotent, and safe to run more than once: the sold quantity is always
    re-derived from the invoice's own lines rather than added to what is
    already on the row. A row that turns out to have lost nothing is deleted -
    stock arrived, or the cashier re-added the line, and there is no loss to
    report.
    """
    if not sales_invoice:
        return {"updated": 0, "deleted": 0}

    invoice_doc = frappe.get_doc("Sales Invoice", sales_invoice)
    _assert_pos_profile_access(invoice_doc.pos_profile)

    filters = {"is_void": 0, "pos_profile": invoice_doc.pos_profile}
    if cart_session_id:
        filters["cart_session_id"] = cart_session_id
    else:
        filters["sales_invoice"] = sales_invoice

    names = frappe.get_all(DOCTYPE, filters=filters, pluck="name")
    if not names:
        return {"updated": 0, "deleted": 0}

    exact, by_item = _sold_map(invoice_doc)
    updated = deleted = 0

    for name in names:
        doc = frappe.get_doc(DOCTYPE, name)

        key = (doc.item_code, doc.uom, doc.warehouse, doc.batch_no or None)
        if key in exact:
            sold = flt(exact[key])
        elif doc.item_code in by_item:
            sold = flt(by_item[doc.item_code]) / (flt(doc.conversion_factor) or 1)
        else:
            sold = 0

        doc.sold_qty = sold
        doc.sales_invoice = invoice_doc.name
        doc.customer = doc.customer or invoice_doc.customer
        doc.flags.ignore_permissions = True
        doc.save()

        if flt(doc.lost_qty) <= 0:
            frappe.delete_doc(DOCTYPE, doc.name, ignore_permissions=True, force=True)
            deleted += 1
        else:
            updated += 1

    return {"updated": updated, "deleted": deleted}


def on_invoice_cancel(doc, method=None):
    """A cancelled sale un-happened, so its demand is lost again.

    Hooked on Sales Invoice `on_cancel`. Never raises - a cancellation must not
    fail because of an analytics row.
    """
    try:
        names = frappe.get_all(DOCTYPE, filters={"sales_invoice": doc.name}, pluck="name")

        for name in names:
            row = frappe.get_doc(DOCTYPE, name)
            row.sold_qty = 0
            row.flags.ignore_permissions = True
            row.save()
    except Exception:
        frappe.log_error(frappe.get_traceback(), "POS Order Loss Cancel Error")


# ==========================================
# Reading and correcting
# ==========================================


@frappe.whitelist()
def rebind_session(old_session, new_session, pos_profile):
    """Move a cart's loss rows onto the invoice its cart was just held as.

    Rows recorded before the ticket was held belong to the same customer as the
    ones recorded after it is resumed, so they have to share a session - and the
    session is what the idempotency key is built from. Without this, resuming a
    held draft would start recording a second row for the same item instead of
    updating the first.

    A row whose item is already recorded under the new session is left where it
    is: the newer one is the live record, and quietly deleting the older one
    would throw away demand somebody took the trouble to confirm.
    """
    _assert_pos_profile_access(pos_profile)

    if not (old_session and new_session) or old_session == new_session:
        return {"moved": 0, "skipped": 0}

    names = frappe.get_all(
        DOCTYPE, filters={"cart_session_id": old_session, "is_void": 0}, pluck="name"
    )

    moved = skipped = 0

    for name in names:
        doc = frappe.get_doc(DOCTYPE, name)
        new_key = make_idempotency_key(
            new_session, doc.item_code, doc.uom, doc.warehouse, doc.batch_no
        )

        clash = frappe.db.get_value(DOCTYPE, {"idempotency_key": new_key}, "name")
        if clash and clash != doc.name:
            skipped += 1
            continue

        doc.cart_session_id = new_session
        doc.idempotency_key = new_key
        doc.flags.ignore_permissions = True
        doc.save()
        moved += 1

    return {"moved": moved, "skipped": skipped}


@frappe.whitelist()
def void_loss(name, reason):
    """Retire a row that does not reflect real demand, keeping the evidence."""
    if not reason:
        frappe.throw(_("A reason is required to void a loss"))

    doc = frappe.get_doc(DOCTYPE, name)

    if not frappe.has_permission(DOCTYPE, "write", doc=doc):
        frappe.throw(
            _("You are not allowed to void a loss record"), frappe.PermissionError
        )

    doc.is_void = 1
    doc.void_reason = reason
    doc.save()

    return {"voided": doc.name}


# ==========================================
# Demand for items the catalogue does not carry
# ==========================================

UNLISTED_DOCTYPE = "POS Unlisted Item Demand"


@frappe.whitelist()
def record_unlisted_demand(
    requested_item,
    pos_profile,
    qty=1,
    uom=None,
    item_group=None,
    brand=None,
    estimated_rate=0,
    customer=None,
    contact_no=None,
    notes=None,
    pos_opening_shift=None,
):
    """Record a customer asking for something the shop does not sell.

    Deliberately not deduplicated against earlier requests: two customers
    asking for the same thing is the whole signal. The report groups them.
    """
    _assert_pos_profile_access(pos_profile)

    if not _is_enabled(pos_profile):
        return {"enabled": False, "name": None}

    requested_item = cstr(requested_item).strip()
    if not requested_item:
        frappe.throw(_("What the customer asked for is required"))

    if flt(qty) <= 0:
        frappe.throw(_("Qty Asked For must be greater than zero"))

    ctx = _profile_context(pos_profile)

    doc = frappe.get_doc(
        {
            "doctype": UNLISTED_DOCTYPE,
            "requested_item": requested_item,
            "item_group": item_group or None,
            "brand": cstr(brand).strip() or None,
            "qty": flt(qty),
            "uom": uom or None,
            "estimated_rate": flt(estimated_rate),
            "currency": ctx.get("currency"),
            "customer": customer or None,
            "contact_no": cstr(contact_no).strip() or None,
            "notes": cstr(notes).strip() or None,
            "company": ctx.get("company"),
            "pos_profile": pos_profile,
            "pos_opening_shift": pos_opening_shift or None,
            "cashier": frappe.session.user,
            "status": "Open",
        }
    )
    doc.flags.ignore_permissions = True
    doc.insert()

    return {"enabled": True, "name": doc.name, "requested_item": doc.requested_item}


@frappe.whitelist()
def get_unlisted_demand(
    pos_profile, pos_opening_shift=None, from_date=None, to_date=None, limit=200
):
    """Requests for items the shop does not carry, for the till's own screen."""
    _assert_pos_profile_access(pos_profile)

    filters = {"pos_profile": pos_profile, "status": ["!=", "Discarded"]}

    if pos_opening_shift:
        filters["pos_opening_shift"] = pos_opening_shift

    if from_date and to_date:
        filters["posting_date"] = ["between", [getdate(from_date), getdate(to_date)]]
    elif from_date:
        filters["posting_date"] = [">=", getdate(from_date)]
    elif not pos_opening_shift:
        filters["posting_date"] = nowdate()

    return frappe.get_all(
        UNLISTED_DOCTYPE,
        filters=filters,
        fields=[
            "name",
            "requested_item",
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
            "posting_date",
            "posting_time",
        ],
        order_by="posting_date desc, posting_time desc",
        limit_page_length=cint(limit) or 200,
        ignore_permissions=True,
    )


@frappe.whitelist()
def get_order_losses(
    pos_profile, pos_opening_shift=None, from_date=None, to_date=None, limit=200
):
    """Lost demand for the till's own screen, newest first."""
    _assert_pos_profile_access(pos_profile)

    filters = {"pos_profile": pos_profile, "is_void": 0}

    if pos_opening_shift:
        filters["pos_opening_shift"] = pos_opening_shift

    if from_date and to_date:
        filters["posting_date"] = ["between", [getdate(from_date), getdate(to_date)]]
    elif from_date:
        filters["posting_date"] = [">=", getdate(from_date)]
    elif not pos_opening_shift:
        # Neither a shift nor a date: today only, or a busy till would pull its
        # whole history down on every open.
        filters["posting_date"] = nowdate()

    return frappe.get_all(
        DOCTYPE,
        filters=filters,
        fields=[
            "name",
            "item_code",
            "item_name",
            "uom",
            "warehouse",
            "customer",
            "demanded_qty",
            "sold_qty",
            "lost_qty",
            "rate",
            "lost_value",
            "reason",
            "loss_type",
            "sales_invoice",
            "posting_date",
            "posting_time",
        ],
        order_by="posting_date desc, posting_time desc",
        limit_page_length=cint(limit) or 200,
        ignore_permissions=True,
    )
