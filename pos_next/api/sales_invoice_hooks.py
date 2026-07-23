# Copyright (c) 2025, BrainWise and contributors
# For license information, please see license.txt

"""
Sales Invoice Hooks
Event handlers for Sales Invoice document events
"""

import frappe
from frappe import _


def validate(doc, method=None):
	"""
	Validate hook for Sales Invoice.
	Apply tax inclusive settings based on POS Profile configuration.

	Args:
		doc: Sales Invoice document
		method: Hook method name (unused)
	"""
	apply_tax_inclusive(doc)
	record_applied_pricing_rules(doc)


def record_applied_pricing_rules(doc):
	"""Record cashier-applied pricing rules on the invoice's Pricing Rules table.

	POS applies promotional-scheme discounts manually and submits invoices with
	ignore_pricing_rule=1 (so ERPNext never auto-applies unselected rules). A side
	effect is that ERPNext resets the Pricing Rules child table on every validate,
	dropping the link between the discount and the scheme that produced it.

	This runs after the controller's validate (doc_events fire after the class
	method), so it rebuilds that table from the applied rule names passed through
	by the POS API (invoices.update_invoice / submit_invoice). The item-level
	`pricing_rules` field is intentionally left untouched: setting it would make
	ERPNext strip the discount via remove_pricing_rule_for_item on the next validate.

	Args:
		doc: Sales Invoice document
	"""
	applied = doc.flags.get("pos_applied_pricing_rules")
	if not applied:
		return

	# Aligned to items order (same convention the POS uses everywhere).
	doc.set("pricing_rules", [])
	seen = set()
	for idx, item in enumerate(doc.get("items", [])):
		rule_names = applied[idx] if idx < len(applied) else None
		if not rule_names:
			continue

		for rule_name in rule_names:
			if not rule_name:
				continue

			key = (item.name, rule_name)
			if key in seen:
				continue
			seen.add(key)

			if not frappe.db.exists("Pricing Rule", rule_name):
				continue

			doc.append(
				"pricing_rules",
				{
					"pricing_rule": rule_name,
					"item_code": item.item_code,
					"child_docname": item.name,
					"rule_applied": 1,
				},
			)


def apply_tax_inclusive(doc):
	"""
	Mark taxes as inclusive based on POS Profile setting.

	This function reads the tax_inclusive setting from POS Settings
	and applies it to all taxes in the invoice (except Actual charge type).

	Args:
		doc: Sales Invoice document
	"""
	if not doc.pos_profile:
		return

	try:
		# Get POS Settings for this profile
		pos_settings = frappe.db.get_value(
			"POS Settings",
			{"pos_profile": doc.pos_profile},
			["tax_inclusive"],
			as_dict=True
		)
		tax_inclusive = pos_settings.get("tax_inclusive", 0) if pos_settings else 0
	except Exception:
		tax_inclusive = 0

	has_changes = False
	for tax in doc.get("taxes", []):
		# Skip Actual charge type - these can't be inclusive
		if tax.charge_type == "Actual":
			if tax.included_in_print_rate:
				tax.included_in_print_rate = 0
				has_changes = True
			continue

		# Apply tax inclusive setting
		if tax_inclusive and not tax.included_in_print_rate:
			tax.included_in_print_rate = 1
			has_changes = True
		elif not tax_inclusive and tax.included_in_print_rate:
			tax.included_in_print_rate = 0
			has_changes = True

	# Recalculate if we made changes
	if has_changes:
		doc.calculate_taxes_and_totals()


def before_cancel(doc, method=None):
	"""
	Before Cancel hook for Sales Invoice.
	Cancel any credit redemption journal entries.

	Args:
		doc: Sales Invoice document
		method: Hook method name (unused)
	"""
	try:
		from pos_next.api.credit_sales import cancel_credit_journal_entries
		cancel_credit_journal_entries(doc.name)
	except Exception as e:
		frappe.log_error(
			title="Credit Sale JE Cancellation Error",
			message=f"Invoice: {doc.name}, Error: {str(e)}\n{frappe.get_traceback()}"
		)
		# Don't block invoice cancellation if JE cancellation fails
		frappe.msgprint(
			_("Warning: Some credit journal entries may not have been cancelled. Please check manually."),
			alert=True,
			indicator="orange"
		)
