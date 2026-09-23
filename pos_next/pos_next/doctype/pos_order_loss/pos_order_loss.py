# -*- coding: utf-8 -*-
# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Unmet customer demand at the till.

One row per item per sale: what the customer asked for, what the till could
actually give them, and what that gap was worth. The row is written when the
shortfall happens, not when the sale completes - a customer who walks away
because the shelf was empty is the loss most worth knowing about, and there is
no invoice for that.
"""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime, nowdate

# Joined with "::" so a value containing one component cannot be confused for
# another. Mirrored in POS/src/stores/orderLoss.js - the two must agree exactly
# or the same shortfall would be stored twice.
KEY_SEPARATOR = "::"


def make_idempotency_key(cart_session_id, item_code, uom, warehouse, batch_no=None):
    """The identity of a shortfall: this item, in this UOM, in this sale."""
    return KEY_SEPARATOR.join(
        [
            cart_session_id or "",
            item_code or "",
            uom or "",
            warehouse or "",
            batch_no or "",
        ]
    )


class POSOrderLoss(Document):
    def validate(self):
        self.set_defaults()
        self.set_idempotency_key()
        self.validate_quantities()
        self.compute_derived()

    def set_defaults(self):
        if not self.cashier:
            self.cashier = frappe.session.user

        if not self.posting_date:
            self.posting_date = nowdate()

        if not self.posting_time:
            self.posting_time = now_datetime().strftime("%H:%M:%S")

        if not self.company and self.pos_profile:
            self.company = frappe.db.get_value("POS Profile", self.pos_profile, "company")

        if not self.currency and self.company:
            self.currency = frappe.db.get_value("Company", self.company, "default_currency")

        if not flt(self.conversion_factor):
            self.conversion_factor = 1

    def set_idempotency_key(self):
        """Fill the key once, from the fields that define the row's identity.

        Never recomputed on a later save: the key is what an upsert looks the
        row up by, so letting it drift would orphan the row and let a second one
        take its place.
        """
        if self.idempotency_key:
            return

        if not self.cart_session_id:
            frappe.throw(_("Cart Session ID is required to identify a loss row"))

        self.idempotency_key = make_idempotency_key(
            self.cart_session_id,
            self.item_code,
            self.uom,
            self.warehouse,
            self.batch_no,
        )

    def validate_quantities(self):
        if flt(self.demanded_qty) <= 0:
            frappe.throw(_("Demanded Qty must be greater than zero"))

        # A bin can go negative; demand was still measured against an empty shelf.
        if flt(self.available_qty) < 0:
            self.available_qty = 0

        if flt(self.sold_qty) < 0:
            self.sold_qty = 0

        # Selling more than was asked for is not a thing - it means the row was
        # reconciled against the wrong line, and would produce a negative loss.
        if flt(self.sold_qty) > flt(self.demanded_qty):
            self.sold_qty = flt(self.demanded_qty)

    def compute_derived(self):
        """Every derived number, in one place.

        The desk form, the API upsert and the reconcile all re-save through
        here, so none of them can disagree about what was lost.
        """
        factor = flt(self.conversion_factor) or 1

        # What the till could have handed over: the stock that was on the shelf,
        # or what the sale actually took if that turned out to be more (stock
        # arrived between the refusal and the checkout). Asking for 200 against 2
        # on the shelf loses 198, not 200 - the 2 were never lost, whether or not
        # the customer ended up taking them.
        fulfillable = max(flt(self.available_qty), flt(self.sold_qty))

        self.lost_qty = max(flt(self.demanded_qty) - fulfillable, 0)

        self.demanded_stock_qty = flt(self.demanded_qty) * factor
        self.sold_stock_qty = flt(self.sold_qty) * factor
        self.lost_stock_qty = flt(self.lost_qty) * factor

        # Measured against what could be served, so it matches lost_qty rather
        # than tracking whether the customer chose to take what was there.
        self.fill_rate = (
            ((flt(self.demanded_qty) - flt(self.lost_qty)) / flt(self.demanded_qty) * 100)
            if flt(self.demanded_qty)
            else 0
        )

        # Zero when the item never reached the cart and so was never priced -
        # the quantity is still the real loss, which is why the report totals
        # quantity and value separately.
        self.lost_value = flt(self.lost_qty) * flt(self.rate)

        # Full means the shelf could not cover any of it.
        self.loss_type = "Full" if flt(self.lost_qty) >= flt(self.demanded_qty) else "Partial"
