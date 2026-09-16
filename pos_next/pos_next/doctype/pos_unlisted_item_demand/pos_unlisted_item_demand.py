# -*- coding: utf-8 -*-
# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Demand for something the shop does not sell.

POS Order Loss covers items the catalogue knows about but the shelf could not
cover. This covers the other half: a customer asks for something that is not in
the Item master at all, so there is no item to be short of, no stock figure and
no sale to reconcile against - the whole request walks out of the door.

It is the buying list. Everything here is a candidate for something to start
stocking, which is why a request carries who asked and how to reach them.
"""

import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime, nowdate


def normalize_request(text):
    """Fold a typed request down to something that groups.

    Three cashiers typing "Bosch Wiper 24", "bosch  wiper 24" and
    "BOSCH WIPER 24." are reporting one thing, and a buying list that shows
    them as three is worth less than one that shows them as one asked for
    three times.
    """
    if not text:
        return ""

    folded = re.sub(r"[^a-z0-9]+", " ", str(text).lower())

    return folded.strip()


class POSUnlistedItemDemand(Document):
    def validate(self):
        self.set_defaults()
        self.validate_qty()

        self.normalized_item = normalize_request(self.requested_item)
        self.estimated_value = flt(self.qty) * flt(self.estimated_rate)

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

        if self.requested_item:
            self.requested_item = " ".join(str(self.requested_item).split())

    def validate_qty(self):
        if flt(self.qty) <= 0:
            frappe.throw(_("Qty Asked For must be greater than zero"))

        # Recording an unstocked item against an item that exists is a sign the
        # cashier searched badly rather than that the catalogue is missing
        # something - but it is their call, so say it and carry on.
        if self.linked_item and self.status == "Open":
            self.status = "Sourced"
