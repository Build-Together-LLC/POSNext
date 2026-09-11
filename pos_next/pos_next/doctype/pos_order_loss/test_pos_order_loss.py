# -*- coding: utf-8 -*-
# Copyright (c) 2026, BrainWise and contributors
# See license.txt

import frappe
from frappe.tests.utils import FrappeTestCase

from pos_next.pos_next.doctype.pos_order_loss.pos_order_loss import make_idempotency_key


def _row(**overrides):
    """A loss row with the minimum a caller must supply, ready to insert."""
    profile = _a_pos_profile()

    values = {
        "doctype": "POS Order Loss",
        "item_code": _an_item(),
        "uom": frappe.db.get_value("Item", _an_item(), "stock_uom"),
        "warehouse": _a_warehouse(),
        "company": frappe.db.get_value("POS Profile", profile, "company"),
        "pos_profile": profile,
        "cart_session_id": frappe.generate_hash(length=12),
        "demanded_qty": 12,
        "available_qty": 5,
        "rate": 100,
        "conversion_factor": 1,
        "reason": "Insufficient Stock",
    }
    values.update(overrides)
    return frappe.get_doc(values)


def _a_pos_profile():
    return frappe.db.get_value("POS Profile", {"disabled": 0}, "name")


def _a_warehouse():
    return frappe.db.get_value("Warehouse", {"is_group": 0}, "name")


def _an_item():
    return frappe.db.get_value("Item", {"is_stock_item": 1, "disabled": 0}, "name")


class TestPOSOrderLoss(FrappeTestCase):
    def setUp(self):
        # These rows only ever come from a till, so they are anchored to a POS
        # Profile. Building one here would mean inventing a company, warehouse
        # and payment setup; say so plainly instead of asserting against nothing.
        if not _a_pos_profile():
            self.skipTest("no POS Profile on this site to record a loss against")

    def test_derived_fields(self):
        doc = _row(demanded_qty=12, available_qty=5, sold_qty=5, rate=100).insert(
            ignore_permissions=True
        )

        self.assertEqual(doc.lost_qty, 7)
        self.assertEqual(doc.lost_value, 700)
        self.assertEqual(doc.loss_type, "Partial")
        self.assertAlmostEqual(doc.fill_rate, 41.6667, places=3)

    def test_nothing_sold_is_a_full_loss(self):
        doc = _row(demanded_qty=3, available_qty=0, sold_qty=0).insert(
            ignore_permissions=True
        )

        self.assertEqual(doc.lost_qty, 3)
        self.assertEqual(doc.loss_type, "Full")
        self.assertEqual(doc.fill_rate, 0)

    def test_stock_uom_mirrors_use_the_conversion_factor(self):
        """Totalling 2 Boxes and 3 Nos is only meaningful in the stock UOM."""
        doc = _row(demanded_qty=2, sold_qty=1, conversion_factor=12).insert(
            ignore_permissions=True
        )

        self.assertEqual(doc.demanded_stock_qty, 24)
        self.assertEqual(doc.sold_stock_qty, 12)
        self.assertEqual(doc.lost_stock_qty, 12)

    def test_duplicate_key_is_refused(self):
        """The unique key is what stops a repeated scan writing a second row."""
        first = _row().insert(ignore_permissions=True)

        second = _row(cart_session_id=first.cart_session_id)

        self.assertRaises(
            frappe.UniqueValidationError, second.insert, ignore_permissions=True
        )

    def test_key_is_built_from_the_rows_identity(self):
        doc = _row().insert(ignore_permissions=True)

        self.assertEqual(
            doc.idempotency_key,
            make_idempotency_key(
                doc.cart_session_id, doc.item_code, doc.uom, doc.warehouse, None
            ),
        )

    def test_key_does_not_drift_when_the_row_is_re_saved(self):
        doc = _row().insert(ignore_permissions=True)
        original = doc.idempotency_key

        doc.sold_qty = 5
        doc.save(ignore_permissions=True)

        self.assertEqual(doc.idempotency_key, original)

    def test_selling_more_than_was_asked_for_cannot_produce_a_negative_loss(self):
        doc = _row(demanded_qty=5, sold_qty=9).insert(ignore_permissions=True)

        self.assertEqual(doc.sold_qty, 5)
        self.assertEqual(doc.lost_qty, 0)

    def test_negative_bin_reads_as_nothing_available(self):
        doc = _row(available_qty=-4).insert(ignore_permissions=True)

        self.assertEqual(doc.available_qty, 0)

    def test_demand_must_be_positive(self):
        self.assertRaises(
            frappe.ValidationError, _row(demanded_qty=0).insert, ignore_permissions=True
        )
