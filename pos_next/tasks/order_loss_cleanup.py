# -*- coding: utf-8 -*-
# Copyright (c) 2026, POS Next and contributors
# For license information, please see license.txt

"""Housekeeping for POS Order Loss rows."""

import frappe
from frappe.utils import add_days, nowdate

# How long a row a supervisor has already written off is kept around. Long
# enough that a disputed write-off can still be looked at, short enough that
# rejected noise does not accumulate for ever.
VOIDED_RETENTION_DAYS = 90


def cleanup_voided_losses():
	"""Drop loss rows that were voided more than 90 days ago.

	Only voided rows. Live ones are business data - somebody's unserved
	customer - and deleting those on a timer would quietly rewrite the history
	the report is read from.
	"""
	cutoff = add_days(nowdate(), -VOIDED_RETENTION_DAYS)

	names = frappe.get_all(
		"POS Order Loss",
		filters={"is_void": 1, "modified": ["<", cutoff]},
		pluck="name",
		limit_page_length=0,
	)

	for name in names:
		try:
			frappe.delete_doc("POS Order Loss", name, ignore_permissions=True, force=True)
		except Exception:
			frappe.log_error(frappe.get_traceback(), "POS Order Loss Cleanup Error")

	# One commit for the sweep rather than per row.
	if names:
		frappe.db.commit()

	return len(names)
