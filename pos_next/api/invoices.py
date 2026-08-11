# -*- coding: utf-8 -*-
# Copyright (c) 2025, BrainWise and contributors
# For license information, please see license.txt

from __future__ import unicode_literals
import json
import frappe
from frappe import _
from frappe.utils import flt, cint, nowdate, nowtime, get_datetime, cstr
from erpnext.stock.doctype.batch.batch import get_batch_qty, get_batch_no
from erpnext.accounts.doctype.sales_invoice.sales_invoice import get_bank_cash_account

try:
    from erpnext.accounts.doctype.pricing_rule.pricing_rule import (
        apply_pricing_rule as erpnext_apply_pricing_rule,
    )
    from erpnext.accounts.doctype.pricing_rule.utils import (
        get_applied_pricing_rules as erpnext_get_applied_pricing_rules,
    )
except Exception:  # pragma: no cover - ERPNext not installed in some environments
    erpnext_apply_pricing_rule = None
    erpnext_get_applied_pricing_rules = None


# Roles allowed to clear held POS drafts that belong to another cashier
# (see delete_all_pos_drafts).
POS_DRAFT_MANAGER_ROLES = ("System Manager", "Sales Manager", "Accounts Manager")


# ==========================================
# Helper Functions
# ==========================================


def get_payment_account(mode_of_payment, company):
    """
    Get account for mode of payment.
    Tries multiple fallback methods to find a suitable account.
    """
    # Try 1: Mode of Payment Account table
    account = frappe.db.get_value(
        "Mode of Payment Account",
        {"parent": mode_of_payment, "company": company},
        "default_account",
    )
    if account:
        return {"account": account}

    # Try 2: POS Payment Method from POS Profile
    account = frappe.db.sql(
        """
		SELECT ppm.default_account
		FROM `tabPOS Payment Method` ppm
		INNER JOIN `tabPOS Profile` pp ON ppm.parent = pp.name
		WHERE ppm.mode_of_payment = %s
		AND pp.company = %s
		AND ppm.default_account IS NOT NULL
		LIMIT 1
	""",
        (mode_of_payment, company),
        as_dict=1,
    )

    if account and account[0].default_account:
        return {"account": account[0].default_account}

    # Try 3: Company default cash account (for cash payments)
    if "cash" in mode_of_payment.lower():
        account = frappe.get_value("Company", company, "default_cash_account")
        if account:
            return {"account": account}

    # Try 4: Company default bank account
    account = frappe.get_value("Company", company, "default_bank_account")
    if account:
        return {"account": account}

    # Try 5: Any Cash/Bank account for the company
    account = frappe.db.get_value(
        "Account",
        {"company": company, "account_type": ["in", ["Cash", "Bank"]], "is_group": 0},
        "name",
    )
    if account:
        return {"account": account}

    # No account found - throw error
    frappe.throw(
        _(
            "Please set default Cash or Bank account in Mode of Payment {0} or set default accounts in Company {1}"
        ).format(mode_of_payment, company),
        title=_("Missing Account"),
    )


# ==========================================
# Stock Validation Functions
# ==========================================


def _get_available_stock(item):
    """Return available stock qty for an item row."""
    warehouse = item.get("warehouse")
    batch_no = item.get("batch_no")
    item_code = item.get("item_code")

    if not item_code or not warehouse:
        return 0

    if batch_no:
        return get_batch_qty(batch_no, warehouse) or 0

    # Get stock from Bin
    bin_qty = frappe.db.get_value(
        "Bin", {"item_code": item_code, "warehouse": warehouse}, "actual_qty"
    )
    return flt(bin_qty) or 0


def _collect_stock_errors(items):
    """Return list of items exceeding available stock."""
    errors = []
    for d in items:
        if flt(d.get("qty")) < 0:
            continue

        available = _get_available_stock(d)
        requested = flt(
            d.get("stock_qty")
            or (flt(d.get("qty")) * flt(d.get("conversion_factor") or 1))
        )

        if requested > available:
            errors.append(
                {
                    "item_code": d.get("item_code"),
                    "warehouse": d.get("warehouse"),
                    "requested_qty": requested,
                    "available_qty": available,
                }
            )

    return errors


def _should_block(pos_profile):
    """Check if sale should be blocked for insufficient stock."""
    # First check global ERPNext Stock Settings
    allow_negative = cint(
        frappe.db.get_single_value("Stock Settings", "allow_negative_stock") or 0
    )
    if allow_negative:
        return False

    # Check POS Settings for the specific profile
    if pos_profile:
        # Check if POS Settings allows negative stock
        pos_settings_allow_negative = cint(
            frappe.db.get_value(
                "POS Settings",
                {"pos_profile": pos_profile},
                "allow_negative_stock"
            ) or 0
        )
        if pos_settings_allow_negative:
            return False

        # Try to get custom field (may not exist in vanilla ERPNext)
        block_sale = cint(
            frappe.db.get_value(
                "POS Profile", pos_profile, "posa_block_sale_beyond_available_qty"
            )
            or 1
        )
        return bool(block_sale)

    # Default to blocking if no profile specified
    return True


def _validate_stock_on_invoice(invoice_doc):
    """Validate stock availability before submission."""
    if invoice_doc.doctype == "Sales Invoice" and not cint(
        getattr(invoice_doc, "update_stock", 0)
    ):
        return

    # Collect all stock items to check
    items_to_check = [d.as_dict() for d in invoice_doc.items if d.get("is_stock_item")]

    # Include packed items if present
    if hasattr(invoice_doc, "packed_items"):
        items_to_check.extend([d.as_dict() for d in invoice_doc.packed_items])

    # Check for stock errors
    errors = _collect_stock_errors(items_to_check)

    # Throw error if stock insufficient and blocking is enabled
    if errors and _should_block(invoice_doc.pos_profile):
        frappe.throw(frappe.as_json({"errors": errors}), frappe.ValidationError)


def _auto_set_return_batches(invoice_doc):
    """Assign batch numbers for return invoices without a source invoice.

    When an item requires a batch number, this function allocates the first
    available batch in FIFO order. If no batches exist in the selected
    warehouse, an informative error is raised.
    """
    if not invoice_doc.is_return or invoice_doc.get("return_against"):
        return

    for d in invoice_doc.items:
        if not d.get("item_code") or not d.get("warehouse"):
            continue

        has_batch = frappe.db.get_value("Item", d.item_code, "has_batch_no")
        if has_batch and not d.get("batch_no"):
            batch_list = (
                get_batch_qty(item_code=d.item_code, warehouse=d.warehouse) or []
            )
            batch_list = [b for b in batch_list if flt(b.get("qty")) > 0]

            if batch_list:
                # FIFO: batches are already sorted by posting/expiry in ERPNext
                d.batch_no = batch_list[0].get("batch_no")
            else:
                frappe.throw(
                    _("No batches available in {0} for {1}.").format(
                        d.warehouse, d.item_code
                    )
                )


# ==========================================
# Validation Functions
# ==========================================


@frappe.whitelist()
def validate_cart_items(items, pos_profile=None):
    """Validate cart items for available stock.

    Returns a list of item dicts where requested quantity exceeds availability.
    This can be used on the front-end for pre-submission checks.
    """
    if isinstance(items, str):
        items = json.loads(items)

    if pos_profile and not frappe.db.exists("POS Profile", pos_profile):
        pos_profile = None

    if not _should_block(pos_profile):
        return []

    errors = _collect_stock_errors(items)
    if not errors:
        return []

    return errors


@frappe.whitelist()
def validate_return_items(original_invoice_name, return_items, doctype="Sales Invoice"):
    """Ensure that return items do not exceed the quantity from the original invoice."""
    original_invoice = frappe.get_doc(doctype, original_invoice_name)
    original_item_qty = {}

    for item in original_invoice.items:
        original_item_qty[item.item_code] = (
            original_item_qty.get(item.item_code, 0) + item.qty
        )

    # Get all returned items from this invoice
    returned_items = frappe.get_all(
        doctype,
        filters={
            "return_against": original_invoice_name,
            "docstatus": 1,
            "is_return": 1,
        },
        fields=["name"],
    )

    for returned_invoice in returned_items:
        ret_doc = frappe.get_doc(doctype, returned_invoice.name)
        for item in ret_doc.items:
            if item.item_code in original_item_qty:
                original_item_qty[item.item_code] -= abs(item.qty)

    # Validate new return items
    for item in return_items:
        item_code = item.get("item_code")
        return_qty = abs(item.get("qty", 0))
        if item_code in original_item_qty and return_qty > original_item_qty[item_code]:
            return {
                "valid": False,
                "message": _(
                    "You are trying to return more quantity for item {0} than was sold."
                ).format(item_code),
            }

    return {"valid": True}


# ==========================================
# Invoice Management (Two-Step Flow)
# ==========================================


def _get_editable_invoice(doctype, invoice_name):
    """Load the draft `invoice_name` points at, or None if a new document is due.

    A held draft can be resumed on more than one terminal at a time. If the first
    till submits it, the second must not quietly fall through to creating a
    second Sales Invoice for the same sale - that books the goods twice. So a
    name that exists but has left draft state is an error, not a cue to create.

    Returns None only when there is nothing to update: no name at all, or a name
    the server has never heard of (an invoice queued offline, say), in which case
    the caller creates the document.
    """
    if not invoice_name:
        return None

    docstatus = frappe.db.get_value(doctype, invoice_name, "docstatus")

    if docstatus is None:
        return None

    docstatus = cint(docstatus)

    if docstatus == 1:
        frappe.throw(
            _(
                "Invoice {0} has already been submitted, most likely from another "
                "terminal. Refresh the held invoices before continuing - do not "
                "charge this sale again."
            ).format(invoice_name),
            title=_("Already Submitted"),
        )

    if docstatus == 2:
        frappe.throw(
            _("Invoice {0} has been cancelled and can no longer be edited.").format(
                invoice_name
            ),
            title=_("Invoice Cancelled"),
        )

    return frappe.get_doc(doctype, invoice_name)


@frappe.whitelist()
def update_invoice(data):
    """Create or update invoice draft (Step 1)."""
    try:
        data = json.loads(data) if isinstance(data, str) else data

        pos_profile = data.get("pos_profile")
        doctype = "Sales Invoice"

        applied_pricing_rules = data.pop("applied_pricing_rules", None)

        # Ensure the document type is set
        data.setdefault("doctype", doctype)

        invoice_name = data.get("name")
        # Throws if the name belongs to an invoice that is no longer a draft.
        invoice_doc = _get_editable_invoice(doctype, invoice_name)

        if invoice_doc:
            invoice_doc.update(data)
        else:
            data.pop("name", None)
            invoice_doc = frappe.get_doc(data)

        pos_profile_doc = None
        if pos_profile:
            try:
                pos_profile_doc = frappe.get_cached_doc("POS Profile", pos_profile)
            except Exception as profile_err:
                frappe.throw(_("Unable to load POS Profile {0}").format(pos_profile))

            invoice_doc.pos_profile = pos_profile

            if pos_profile_doc.company and not invoice_doc.get("company"):
                invoice_doc.company = pos_profile_doc.company
            if pos_profile_doc.currency and not invoice_doc.get("currency"):
                invoice_doc.currency = pos_profile_doc.currency

            # Copy accounting dimensions from POS Profile
            if hasattr(pos_profile_doc, "branch") and pos_profile_doc.branch:
                invoice_doc.branch = pos_profile_doc.branch
                # Also set branch on all items for GL entries
                for item in invoice_doc.get("items", []):
                    item.branch = pos_profile_doc.branch

        company = invoice_doc.get("company") or (
            pos_profile_doc.company if pos_profile_doc else None
        )

        if company and invoice_doc.get("payments"):
            for payment in invoice_doc.payments:
                if payment.mode_of_payment and not payment.get("account"):
                    try:
                        account_info = get_payment_account(
                            payment.mode_of_payment, company
                        )
                        payment.account = account_info.get("account")
                    except Exception:
                        pass  # Will be handled during save

        # Validate return items if this is a return invoice
        if (data.get("is_return") or invoice_doc.is_return) and invoice_doc.get(
            "return_against"
        ):
            validation = validate_return_items(
                invoice_doc.return_against,
                [d.as_dict() for d in invoice_doc.items],
                doctype=invoice_doc.doctype,
            )
            if not validation.get("valid"):
                frappe.throw(validation.get("message"))

        # Ensure customer exists
        customer_name = invoice_doc.get("customer")
        if customer_name and not frappe.db.exists("Customer", customer_name):
            try:
                cust = frappe.get_doc(
                    {
                        "doctype": "Customer",
                        "customer_name": customer_name,
                        "customer_group": "All Customer Groups",
                        "territory": "All Territories",
                        "customer_type": "Individual",
                    }
                )
                cust.flags.ignore_permissions = True
                cust.insert()
                invoice_doc.customer = cust.name
                invoice_doc.customer_name = cust.customer_name
            except Exception as e:
                frappe.log_error(f"Failed to create customer {customer_name}: {e}")

        # Disable automatic pricing rules (we handle discounts manually from POS)
        invoice_doc.ignore_pricing_rule = 1
        invoice_doc.flags.ignore_pricing_rule = True

        # ========================================================================
        # DISCOUNT CALCULATION - CRITICAL LOGIC
        # ========================================================================
        # Problem: Frontend sends rate (discounted) and discount_percentage
        # Solution: Reverse-calculate price_list_rate (original price) to avoid double discount
        #
        # Formula: rate = price_list_rate * (1 - discount_percentage/100)
        # Reverse: price_list_rate = rate / (1 - discount_percentage/100)
        # ========================================================================
        for item in invoice_doc.get("items", []):
            item_rate = flt(item.rate or 0)
            discount_pct = flt(item.discount_percentage or 0)

            # If item has a discount, reverse-calculate the original price_list_rate
            if discount_pct > 0 and discount_pct < 100:
                if item_rate > 0:
                    # Reverse calculation to get original price
                    item.price_list_rate = item_rate / (1 - discount_pct / 100)
                elif not item.get("price_list_rate"):
                    # Fallback: if rate is 0 but discount exists (edge case)
                    item.price_list_rate = item_rate
            elif not item.get("price_list_rate"):
                # No discount or price_list_rate not set - use rate as is
                item.price_list_rate = item_rate

            # Ensure price_list_rate is never less than rate (data integrity)
            if flt(item.price_list_rate) < item_rate:
                item.price_list_rate = item_rate

            # IMPORTANT: Keep the rate from frontend (do NOT set to 0)
            # ERPNext will recalculate if needed, but preserving frontend rate
            # prevents rounding issues and ensures UI matches invoice

        # Set invoice flags BEFORE calculations
        invoice_doc.is_pos = 1
        invoice_doc.update_stock = 1

        # ========================================================================
        # ROUNDING CONFIGURATION
        # ========================================================================
        # Load rounding preference from POS Settings
        # When disabled (0): ERPNext rounds to nearest whole number
        # When enabled (1): Shows exact amount without rounding
        # Check if disable_rounded_total is explicitly passed in invoice data payload,
        # otherwise fall back to POS Settings or default (1).
        if "disable_rounded_total" in data:
            disable_rounded = cint(data.get("disable_rounded_total"))
        else:
            disable_rounded = 1  # Default: disable rounding for POS (show exact amounts)
            if pos_profile:
                try:
                    pos_settings_value = frappe.db.get_value(
                        "POS Settings",
                        {"pos_profile": pos_profile},
                        "disable_rounded_total"
                    )
                    if pos_settings_value is not None:
                        disable_rounded = cint(pos_settings_value)
                except Exception as e:
                    frappe.log_error(f"Error loading rounding setting: {str(e)}", "POS Invoice Creation")

        invoice_doc.disable_rounded_total = disable_rounded

        # Populate missing fields (company, currency, accounts, etc.)
        invoice_doc.set_missing_values()

        # Calculate totals and apply discounts (with rounding disabled)
        invoice_doc.calculate_taxes_and_totals()

        # Set accounts for payment methods before saving
        for payment in invoice_doc.payments:
            if payment.mode_of_payment and not payment.get("account"):
                try:
                    account_info = get_payment_account(
                        payment.mode_of_payment, invoice_doc.company
                    )
                    payment.account = account_info["account"]
                except Exception:
                    pass  # Will be handled during save

        # For return invoices, ensure payments are negative
        if invoice_doc.is_return:
            for payment in invoice_doc.payments:
                payment.amount = -abs(payment.amount)
                if payment.base_amount:
                    payment.base_amount = -abs(payment.base_amount)

            invoice_doc.paid_amount = flt(sum(p.amount for p in invoice_doc.payments))
            invoice_doc.base_paid_amount = flt(
                sum(p.base_amount or 0 for p in invoice_doc.payments)
            )

        # Validate and track POS Coupon if coupon_code is provided
        coupon_code = data.get("coupon_code")
        if coupon_code:
            # Validate POS Coupon exists and is valid
            if frappe.db.table_exists("POS Coupon"):
                from pos_next.pos_next.doctype.pos_coupon.pos_coupon import check_coupon_code

                coupon_result = check_coupon_code(
                    coupon_code,
                    customer=invoice_doc.customer,
                    company=invoice_doc.company
                )

                if not coupon_result.get("valid"):
                    frappe.throw(_(coupon_result.get("msg", "Invalid coupon code")))

                # Store coupon code on invoice for tracking
                invoice_doc.coupon_code = coupon_code

        # Stash applied pricing rules so the validate hook can record them on the
        # invoice's Pricing Rules table (ERPNext resets that table during validate
        # when ignore_pricing_rule is set, so it must be rebuilt afterwards).
        if applied_pricing_rules is not None:
            invoice_doc.flags.pos_applied_pricing_rules = applied_pricing_rules

        # Save as draft
        invoice_doc.flags.ignore_permissions = True
        frappe.flags.ignore_account_permission = True
        invoice_doc.docstatus = 0
        invoice_doc.save()

        return invoice_doc.as_dict()
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Update Invoice Error")
        raise


@frappe.whitelist()
def submit_invoice(invoice=None, data=None):
    """Submit the invoice (Step 2)."""
    try:

        # Handle different calling conventions
        if invoice is None:
            if data:
                # Check if data is a JSON string containing both params
                data_parsed = json.loads(data) if isinstance(data, str) else data

                # frappe-ui might send all params nested in data
                if isinstance(data_parsed, dict):
                    if "invoice" in data_parsed:
                        invoice = data_parsed.get("invoice")
                        data = data_parsed.get("data", {})
                    elif "name" in data_parsed or "doctype" in data_parsed:
                        # Data itself might be the invoice
                        invoice = data_parsed
                        data = {}
                    else:
                        frappe.throw(
                            _("Missing invoice parameter. Received data: {0}").format(
                                json.dumps(data_parsed, default=str)
                            )
                        )
                else:
                    frappe.throw(_("Missing invoice parameter"))
            else:
                frappe.throw(_("Both invoice and data parameters are missing"))

        # Parse JSON strings if needed
        if isinstance(data, str):
            data = json.loads(data) if data and data != "{}" else {}
        if isinstance(invoice, str):
            invoice = json.loads(invoice)

        # Applied pricing rule names per item (aligned to items order). Re-sent on
        # the submit step because the persisted draft does not carry it. Recorded
        # on the invoice's Pricing Rules table by the Sales Invoice validate hook.
        applied_pricing_rules = data.get("applied_pricing_rules")
        if applied_pricing_rules is None:
            applied_pricing_rules = invoice.get("applied_pricing_rules")
        # Not a Sales Invoice field: strip so invoice_doc.update(invoice) ignores it.
        invoice.pop("applied_pricing_rules", None)

        pos_profile = invoice.get("pos_profile")
        doctype = "Sales Invoice"

        invoice_name = invoice.get("name")

        # Throws if this sale was already submitted (or cancelled) elsewhere,
        # rather than booking a duplicate for the same cart.
        invoice_doc = _get_editable_invoice(doctype, invoice_name)

        if invoice_doc:
            invoice_doc.update(invoice)
        else:
            invoice.pop("name", None)
            created = update_invoice(json.dumps(invoice, default=str))
            invoice_name = created.get("name")
            invoice_doc = frappe.get_doc(doctype, invoice_name)

        # Ensure update_stock is set
        invoice_doc.update_stock = 1

        # Copy accounting dimensions from POS Profile if not already set
        if pos_profile and not invoice_doc.get("branch"):
            try:
                pos_profile_doc = frappe.get_cached_doc("POS Profile", pos_profile)
                if hasattr(pos_profile_doc, "branch") and pos_profile_doc.branch:
                    invoice_doc.branch = pos_profile_doc.branch
                    # Also set branch on all items for GL entries
                    for item in invoice_doc.get("items", []):
                        if not item.get("branch"):
                            item.branch = pos_profile_doc.branch
            except Exception:
                pass  # Branch is optional, continue without it

        # Set accounts for all payment methods before saving
        for payment in invoice_doc.payments:
            if payment.mode_of_payment:
                account_info = get_payment_account(
                    payment.mode_of_payment, invoice_doc.company
                )
                payment.account = account_info["account"]

        # Handle sales team (multiple sales persons)
        sales_team_data = invoice.get("sales_team") or data.get("sales_team")
        if sales_team_data:
            # Clear existing sales team entries
            invoice_doc.sales_team = []

            # Add new sales team entries
            for member in sales_team_data:
                invoice_doc.append("sales_team", {
                    "sales_person": member.get("sales_person"),
                    "allocated_percentage": member.get("allocated_percentage", 0),
                })

        # Handle POS Coupon if coupon_code is provided
        coupon_code = invoice.get("coupon_code") or data.get("coupon_code")
        if coupon_code:
            # Increment usage counter for POS Coupon
            if frappe.db.table_exists("POS Coupon"):
                try:
                    from pos_next.pos_next.doctype.pos_coupon.pos_coupon import increment_coupon_usage
                    increment_coupon_usage(coupon_code)
                except Exception as e:
                    frappe.log_error(
                        title="Failed to increment coupon usage",
                        message=f"Coupon: {coupon_code}, Error: {str(e)}"
                    )

        # Auto-set batch numbers for returns
        _auto_set_return_batches(invoice_doc)

        # Check if POS Settings allows negative stock
        pos_settings_allow_negative = False
        if pos_profile:
            pos_settings_allow_negative = cint(
                frappe.db.get_value(
                    "POS Settings",
                    {"pos_profile": pos_profile},
                    "allow_negative_stock"
                ) or 0
            )

        # Validate stock availability only if negative stock is not allowed
        if not pos_settings_allow_negative:
            _validate_stock_on_invoice(invoice_doc)


        invoice_doc.ignore_pricing_rule = 1
        invoice_doc.flags.ignore_pricing_rule = True

        # Record which pricing rules the cashier applied. ERPNext resets the
        # Pricing Rules table on every validate while ignore_pricing_rule is set,
        # so the validate hook rebuilds it from this flag on both save and submit.
        if applied_pricing_rules is not None:
            invoice_doc.flags.pos_applied_pricing_rules = applied_pricing_rules

        # Save before submit
        invoice_doc.flags.ignore_permissions = True
        frappe.flags.ignore_account_permission = True
        invoice_doc.save()

        # Submit invoice with error handling
        # Note: Negative stock handling is now done through the CustomSalesInvoice override
        # which checks POS Settings in the update_stock_ledger method
        try:
            invoice_doc.submit()
        except Exception as submit_error:
            # If submission fails, cleanup the invoice to prevent stock reservation issues
            try:
                # Reload to get current state
                current_doc = frappe.get_doc("Sales Invoice", invoice_doc.name)

                # If already submitted, must cancel before deleting
                if current_doc.docstatus == 1:
                    current_doc.flags.ignore_permissions = True
                    current_doc.cancel()

                # Now delete the cancelled/draft invoice
                frappe.delete_doc(
                    "Sales Invoice",
                    invoice_doc.name,
                    force=True,
                    ignore_permissions=True,
                )
                frappe.db.commit()
            except Exception:
                # Silent fail on cleanup - don't hide original error
                pass

            # Re-raise the original submission error
            raise submit_error

        # Handle credit redemption after successful submission
        customer_credit_dict = data.get("customer_credit_dict") or invoice.get("customer_credit_dict")
        redeemed_customer_credit = data.get("redeemed_customer_credit") or invoice.get("redeemed_customer_credit")

        if redeemed_customer_credit and customer_credit_dict:
            try:
                from pos_next.api.credit_sales import redeem_customer_credit
                redeem_customer_credit(invoice_doc.name, customer_credit_dict)
            except Exception as credit_error:
                frappe.log_error(
                    title="Credit Redemption Error",
                    message=f"Invoice: {invoice_doc.name}, Error: {str(credit_error)}\n{frappe.get_traceback()}"
                )
                # Don't fail the entire transaction, just log the error
                frappe.msgprint(
                    _("Invoice submitted successfully but credit redemption failed. Please contact administrator."),
                    alert=True,
                    indicator="orange"
                )

        # Return complete invoice details
        return {
            "name": invoice_doc.name,
            "status": invoice_doc.docstatus,
            "grand_total": invoice_doc.grand_total,
            "total": invoice_doc.total,
            "net_total": invoice_doc.net_total,
            "outstanding_amount": invoice_doc.outstanding_amount,
            "paid_amount": invoice_doc.paid_amount,
            "change_amount": getattr(invoice_doc, "change_amount", 0),
        }
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Submit Invoice Error")
        raise


# ==========================================
# Invoice History Management
# ==========================================


@frappe.whitelist()
def get_invoice(invoice_name):
	"""
	Get a single invoice with all details for POS.

	Args:
		invoice_name: Sales Invoice name

	Returns:
		Complete invoice document with items and payments
	"""
	if not invoice_name:
		frappe.throw(_("Invoice name is required"))

	if not frappe.db.exists("Sales Invoice", invoice_name):
		frappe.throw(_("Invoice {0} does not exist").format(invoice_name))

	# Check permissions
	if not frappe.has_permission("Sales Invoice", "read", invoice_name):
		frappe.throw(_("You don't have permission to view this invoice"))

	# Get invoice document
	invoice = frappe.get_doc("Sales Invoice", invoice_name)

	return invoice.as_dict()


@frappe.whitelist()
def render_draft_receipt(invoice_data):
	"""Render the draft receipt print format from cart data without saving an invoice.

	Builds a transient Sales Invoice so taxes/GST/totals are computed by ERPNext,
	then renders the "POS Next Draft Receipt" print format against it.
	"""
	data = json.loads(invoice_data) if isinstance(invoice_data, str) else invoice_data

	si = frappe.new_doc("Sales Invoice")
	si.is_pos = 1

	pos_profile = data.get("pos_profile")
	pos_profile_doc = frappe.get_cached_doc("POS Profile", pos_profile) if pos_profile else None
	if pos_profile_doc:
		si.pos_profile = pos_profile
		si.company = data.get("company") or pos_profile_doc.company
		si.selling_price_list = pos_profile_doc.selling_price_list
		si.currency = pos_profile_doc.currency
	elif data.get("company"):
		si.company = data.get("company")

	customer = data.get("customer")
	si.customer = customer if (customer and frappe.db.exists("Customer", customer)) else (
		pos_profile_doc.customer if pos_profile_doc else None
	)

	warehouse = pos_profile_doc.warehouse if pos_profile_doc else None
	for row in data.get("items") or []:
		si.append("items", {
			"item_code": row.get("item_code"),
			"qty": flt(row.get("qty") or row.get("quantity") or 0),
			"rate": flt(row.get("rate")),
			"price_list_rate": flt(row.get("price_list_rate") or row.get("rate")),
			"uom": row.get("uom"),
			"warehouse": row.get("warehouse") or warehouse,
			"discount_amount": flt(row.get("discount_amount") or 0),
			"discount_percentage": flt(row.get("discount_percentage") or 0),
		})

	si.set_missing_values()
	si.calculate_taxes_and_totals()
	try:
		si.set_total_in_words()
	except Exception:
		pass

	# Show the real customer on the pick list even when no Customer record was
	# resolved (walk-in / unsaved draft), so the print never renders "None".
	if not si.customer_name and data.get("customer_name"):
		si.customer_name = data.get("customer_name")

	if data.get("name"):
		si.name = data.get("name")

	return frappe.get_print(doc=si, print_format="POS Next Draft Receipt", no_letterhead=1)


@frappe.whitelist()
def get_invoices(pos_profile, limit=100):
	"""
	Get list of invoices for a POS Profile.

	Args:
		pos_profile: POS Profile name
		limit: Maximum number of invoices to return (default 100)

	Returns:
		List of invoices with details
	"""
	if not pos_profile:
		frappe.throw(_("POS Profile is required"))

	# Check if user has access to this POS Profile
	has_access = frappe.db.exists(
		"POS Profile User",
		{"parent": pos_profile, "user": frappe.session.user}
	)

	if not has_access and not frappe.has_permission("Sales Invoice", "read"):
		frappe.throw(_("You don't have access to this POS Profile"))

	# Query for invoices
	invoices = frappe.db.sql("""
		SELECT
			name,
			customer,
			customer_name,
			posting_date,
			posting_time,
			grand_total,
			paid_amount,
			outstanding_amount,
			status,
			docstatus,
			is_return,
			return_against,
			pos_profile
		FROM
			`tabSales Invoice`
		WHERE
			pos_profile = %(pos_profile)s
			AND docstatus = 1
			AND is_pos = 1
		ORDER BY
			posting_date DESC,
			posting_time DESC
		LIMIT %(limit)s
	""", {
		"pos_profile": pos_profile,
		"limit": limit
	}, as_dict=True)

	# Load items for each invoice for filtering purposes
	for invoice in invoices:
		items = frappe.db.sql("""
			SELECT
				item_code,
				item_name,
				qty,
				rate,
				amount
			FROM
				`tabSales Invoice Item`
			WHERE
				parent = %(invoice_name)s
			ORDER BY
				idx
		""", {
			"invoice_name": invoice.name
		}, as_dict=True)
		invoice.items = items

	return invoices


# ==========================================
# Draft Invoice Management
# ==========================================


@frappe.whitelist()
def get_draft_invoices(pos_opening_shift, doctype="Sales Invoice"):
    """Get all draft invoices for a POS opening shift."""
    filters = {
        "docstatus": 0,
    }

    # Add pos_opening_shift filter if the field exists
    if frappe.db.has_column(doctype, "pos_opening_shift"):
        filters["pos_opening_shift"] = pos_opening_shift

    # Performance: Get all invoice names first
    invoices_list = frappe.get_list(
        doctype,
        filters=filters,
        fields=["name"],
        limit_page_length=0,
        order_by="modified desc",
    )

    # Performance: Batch load all documents at once using get_cached_doc
    # This leverages Frappe's internal caching and is faster than individual queries
    data = []
    for invoice in invoices_list:
        data.append(frappe.get_cached_doc(doctype, invoice["name"]))

    return data


@frappe.whitelist()
def delete_invoice(invoice):
    """Delete draft invoice."""
    doctype = "Sales Invoice"

    if not frappe.db.exists(doctype, invoice):
        frappe.throw(_("Invoice {0} does not exist").format(invoice))

    # Check if it's a draft
    if frappe.db.get_value(doctype, invoice, "docstatus") != 0:
        frappe.throw(_("Cannot delete submitted invoice {0}").format(invoice))

    frappe.delete_doc(doctype, invoice, force=1)
    return _("Invoice {0} Deleted").format(invoice)


@frappe.whitelist()
def cleanup_old_drafts(pos_profile=None, max_age_hours=24):
    """
    Clean up old draft invoices to prevent stock reservation issues.
    Deletes drafts older than max_age_hours (default 24 hours).
    """
    from datetime import datetime, timedelta

    if is_server_side_draft_enabled(pos_profile):
        return {
            "deleted": 0,
            "message": "Skipped: server side draft invoices are enabled for this profile",
        }

    doctype = "Sales Invoice"
    cutoff_time = datetime.now() - timedelta(hours=int(max_age_hours))

    filters = {
        "docstatus": 0,  # Draft only
        "modified": ["<", cutoff_time.strftime("%Y-%m-%d %H:%M:%S")],
    }

    # Optionally filter by POS profile
    if pos_profile:
        filters["pos_profile"] = pos_profile

    # Get old drafts
    old_drafts = frappe.get_all(
        doctype,
        filters=filters,
        fields=["name", "modified"],
        limit_page_length=100,  # Safety limit
    )

    deleted_count = 0
    for draft in old_drafts:
        try:
            frappe.delete_doc(
                doctype, draft["name"], force=True, ignore_permissions=True
            )
            deleted_count += 1
        except Exception as e:
            frappe.log_error(
                f"Failed to delete draft {draft['name']}: {str(e)}",
                "Draft Cleanup Error",
            )

    if deleted_count > 0:
        frappe.db.commit()

    return {
        "deleted": deleted_count,
        "message": f"Cleaned up {deleted_count} old draft invoices",
    }




def is_server_side_draft_enabled(pos_profile):
    """Return True when held invoices for this POS Profile are stored server side."""
    if not pos_profile:
        return False

    try:
        return bool(
            cint(
                frappe.db.get_value(
                    "POS Settings",
                    {"pos_profile": pos_profile},
                    "allow_server_side_draft_invoice",
                )
                or 0
            )
        )
    except Exception:
        # Field missing (site not migrated yet) - fall back to browser drafts.
        return False


def _get_draft_item_meta(item_codes):
    """Fetch the Item-master fields the POS cart needs to rehydrate a held draft.

    Returns (meta_by_item_code, alternate_uoms_by_item_code).
    """
    if not item_codes:
        return {}, {}

    item_codes = list(item_codes)

    fields = [
        "name",
        "item_name",
        "item_group",
        "brand",
        "stock_uom",
        "image",
        "has_batch_no",
        "has_serial_no",
        "is_stock_item",
    ]
    if frappe.db.has_column("Item", "custom_sub_brand"):
        fields.append("custom_sub_brand")

    meta = {
        row["name"]: row
        for row in frappe.get_all(
            "Item", filters={"name": ["in", item_codes]}, fields=fields
        )
    }

    uoms = {}
    for row in frappe.get_all(
        "UOM Conversion Detail",
        filters={"parent": ["in", item_codes], "parenttype": "Item"},
        fields=["parent", "uom", "conversion_factor"],
    ):
        # Mirror the item search payload: alternate UOMs only, stock UOM excluded.
        if row["uom"] == (meta.get(row["parent"]) or {}).get("stock_uom"):
            continue
        uoms.setdefault(row["parent"], []).append(
            {
                "uom": row["uom"],
                "conversion_factor": flt(row["conversion_factor"]) or 1,
            }
        )

    return meta, uoms


def _get_applied_rules_by_row(doc):
    """Map each item row name to the Pricing Rules recorded against it."""
    rules_by_row = {}
    for row in doc.get("pricing_rules") or []:
        if not row.get("pricing_rule"):
            continue
        rules_by_row.setdefault(row.get("child_docname"), []).append(row.pricing_rule)

    return rules_by_row


def _serialize_pos_draft(doc):
    """Convert a Sales Invoice draft into the cart shape the POS front-end uses.

    The POS cart works in `quantity` / line-level `discount_amount`, while the
    Sales Invoice stores `qty` / per-unit `discount_amount`. Discounts are handed
    back as a percentage wherever one exists so the cart recomputes the exact
    line values itself (see recalculateItem in useInvoice.js).
    """
    items = doc.get("items") or []
    meta, uoms = _get_draft_item_meta({d.item_code for d in items if d.item_code})
    rules_by_row = _get_applied_rules_by_row(doc)

    cart_items = []
    for row in items:
        item_meta = meta.get(row.item_code) or {}
        qty = flt(row.qty)
        price_list_rate = flt(row.price_list_rate) or flt(row.rate)
        discount_percentage = flt(row.discount_percentage)
        # Per-unit on the invoice -> line total in the cart.
        discount_amount = 0 if discount_percentage else flt(row.discount_amount) * qty
        pricing_rules = rules_by_row.get(row.name) or []

        cart_items.append(
            {
                "item_code": row.item_code,
                "item_name": row.item_name or item_meta.get("item_name"),
                "qty": qty,
                "quantity": qty,
                "rate": price_list_rate,
                "price_list_rate": price_list_rate,
                "amount": flt(row.amount),
                "discount_percentage": discount_percentage,
                "discount_amount": discount_amount,
                # A discount with no pricing rule behind it was typed in by the
                # cashier - flag it so re-applying offers does not wipe it.
                "manual_discount": bool(
                    (discount_percentage or discount_amount) and not pricing_rules
                ),
                "pricing_rules": pricing_rules,
                "uom": row.uom or item_meta.get("stock_uom"),
                "stock_uom": row.stock_uom or item_meta.get("stock_uom"),
                "conversion_factor": flt(row.conversion_factor) or 1,
                "warehouse": row.warehouse,
                "batch_no": row.get("batch_no"),
                "serial_no": row.get("serial_no"),
                "item_group": item_meta.get("item_group"),
                "brand": item_meta.get("brand"),
                "custom_sub_brand": item_meta.get("custom_sub_brand"),
                "image": item_meta.get("image"),
                "has_batch_no": cint(item_meta.get("has_batch_no")),
                "has_serial_no": cint(item_meta.get("has_serial_no")),
                "is_stock_item": cint(item_meta.get("is_stock_item", 1)),
                "item_uoms": uoms.get(row.item_code) or [],
            }
        )

    applied_rules = sorted({rule for rules in rules_by_row.values() for rule in rules})

    return {
        # draft_id keeps the browser-draft contract so the dialogs, the cart's
        # currentDraftId and the delete/print handlers all work unchanged.
        "draft_id": doc.name,
        "invoice_name": doc.name,
        "server_draft": True,
        "pos_profile": doc.pos_profile,
        "pos_opening_shift": doc.get("posa_pos_opening_shift"),
        "customer": {
            "name": doc.customer,
            "customer_name": doc.customer_name or doc.customer,
        },
        "items": cart_items,
        "applied_pricing_rules": applied_rules,
        "additional_discount": flt(doc.discount_amount),
        "coupon_code": doc.get("coupon_code"),
        "grand_total": flt(doc.grand_total),
        "created_at": cstr(doc.creation),
        "updated_at": cstr(doc.modified),
        "owner": doc.owner,
    }


def _get_pos_draft_doc(invoice_name, ptype="read"):
    """Load a held draft after checking it exists, is unsubmitted and is reachable.

    Access is decided by the POS Profile the ticket was parked on, not by
    record-level permission on the Sales Invoice - a hold has to be resumable
    from any till on that profile, which is the same rule get_pos_drafts lists
    by. Deleting someone else's hold additionally needs a manager role, matching
    delete_all_pos_drafts.
    """
    if not invoice_name:
        frappe.throw(_("Draft invoice name is required"))

    if not frappe.db.exists("Sales Invoice", invoice_name):
        frappe.throw(_("Invoice {0} does not exist").format(invoice_name))

    doc = frappe.get_doc("Sales Invoice", invoice_name)

    # Access first: without this, the docstatus message below would tell any
    # logged-in user whether an arbitrary invoice exists and is still a draft.
    _assert_pos_profile_access(doc.pos_profile)

    if doc.docstatus != 0:
        frappe.throw(_("Invoice {0} is no longer a draft").format(invoice_name))

    if (
        ptype == "delete"
        and doc.owner != frappe.session.user
        and not _can_delete_others_drafts()
    ):
        frappe.throw(
            _("Draft {0} was held by another user and can only be deleted by a manager").format(
                invoice_name
            ),
            frappe.PermissionError,
        )

    return doc


@frappe.whitelist()
def save_pos_draft(data):
    """Hold the current cart as a server-side Sales Invoice draft (create or update).

    Pass `name` in the payload to update an already held draft, omit it to hold a
    new one. Returns the full draft, in the same shape as get_pos_draft (not the
    summary rows get_pos_drafts lists).
    """
    data = json.loads(data) if isinstance(data, str) else data

    pos_profile = data.get("pos_profile")
    if not is_server_side_draft_enabled(pos_profile):
        frappe.throw(
            _("Server side draft invoices are not enabled for POS Profile {0}").format(
                pos_profile or ""
            )
        )

    if not data.get("items"):
        frappe.throw(_("Cannot hold an invoice with an empty cart"))

    if data.get("name"):
        # Refuse to overwrite something that already left draft state.
        _get_pos_draft_doc(data.get("name"), ptype="write")

    # A held invoice is not paid yet - payment is captured when it is resumed.
    data["payments"] = []
    data.setdefault("doctype", "Sales Invoice")
    data.setdefault("is_pos", 1)
    data.setdefault("update_stock", 1)

    saved = update_invoice(json.dumps(data, default=str))

    return _serialize_pos_draft(frappe.get_doc("Sales Invoice", saved.get("name")))


def _pos_draft_filters(pos_profile=None, pos_opening_shift=None, owner=None):
    """Filters that identify held (unsubmitted) POS invoices."""
    filters = {"docstatus": 0, "is_pos": 1}

    if pos_profile:
        filters["pos_profile"] = pos_profile

    if pos_opening_shift and frappe.db.has_column(
        "Sales Invoice", "posa_pos_opening_shift"
    ):
        filters["posa_pos_opening_shift"] = pos_opening_shift

    if owner:
        filters["owner"] = owner

    return filters


def _assert_pos_profile_access(pos_profile):
    """Gate the held-draft endpoints on the caller being a user of this profile.

    The queries below deliberately run without record-level permission checks so
    that a parked ticket is reachable from any till on the profile - that is the
    whole point of holding one. This is the guard that replaces them: the caller
    must be listed on the POS Profile, or hold blanket read on Sales Invoice.
    """
    if not pos_profile:
        frappe.throw(_("POS Profile is required"))

    if frappe.db.exists(
        "POS Profile User", {"parent": pos_profile, "user": frappe.session.user}
    ):
        return

    if not frappe.has_permission("Sales Invoice", "read"):
        frappe.throw(
            _("You don't have access to POS Profile {0}").format(pos_profile),
            frappe.PermissionError,
        )


def _pos_draft_names(pos_profile=None, pos_opening_shift=None, owner=None, limit=0):
    """Names of held drafts, newest held first, without loading the documents.

    get_all, not get_list: see _assert_pos_profile_access.
    """
    return frappe.get_all(
        "Sales Invoice",
        filters=_pos_draft_filters(pos_profile, pos_opening_shift, owner),
        pluck="name",
        order_by="creation desc",
        # 0 means "every held draft" (Frappe's no-limit convention).
        limit_page_length=cint(limit),
    )


def _can_delete_others_drafts():
    """Whether the session user may clear held drafts parked by other cashiers."""
    return bool(set(POS_DRAFT_MANAGER_ROLES) & set(frappe.get_roles()))


def _serialize_pos_draft_summary(row, item_rows):
    """List-shaped view of a held draft: what the drafts dialog actually renders.

    The dialog shows the customer, the timestamp, the line count, the total and
    the first few item names - none of which need the Item master, the alternate
    UOMs or the applied Pricing Rules that _serialize_pos_draft looks up per
    document. Resuming or printing a draft hydrates the full cart shape through
    get_pos_draft, so `summary` marks this payload as display-only.
    """
    items = [
        {
            "item_code": item.get("item_code"),
            "item_name": item.get("item_name") or item.get("item_code"),
            "qty": flt(item.get("qty")),
            # The cart works in `quantity`; keep both so the dialogs and the
            # local-draft rows stay interchangeable.
            "quantity": flt(item.get("qty")),
            "rate": flt(item.get("rate")),
            "amount": flt(item.get("amount")),
            "uom": item.get("uom"),
        }
        for item in item_rows
    ]

    return {
        # draft_id keeps the browser-draft contract (see _serialize_pos_draft).
        "draft_id": row.get("name"),
        "invoice_name": row.get("name"),
        "server_draft": True,
        "summary": True,
        "pos_profile": row.get("pos_profile"),
        "pos_opening_shift": row.get("posa_pos_opening_shift"),
        "customer": {
            "name": row.get("customer"),
            "customer_name": row.get("customer_name") or row.get("customer"),
        },
        "items": items,
        "item_count": len(items),
        "additional_discount": flt(row.get("discount_amount")),
        "coupon_code": row.get("coupon_code"),
        "grand_total": flt(row.get("grand_total")),
        "created_at": cstr(row.get("creation")),
        "updated_at": cstr(row.get("modified")),
        "owner": row.get("owner"),
    }


@frappe.whitelist()
def get_pos_drafts(pos_profile=None, pos_opening_shift=None, limit=0, owner=None):
    """List held draft invoices for a POS Profile, newest held first.

    Ordered by `creation`, which is the timestamp the drafts dialog shows and the
    order the POS itself applies once it merges these rows with the drafts held
    in the browser (see sortByCreatedDesc in stores/posDrafts.js).

    Returns summary rows (see _serialize_pos_draft_summary), built from two
    queries no matter how many drafts are listed - the parents and their lines.
    Loading a draft into the cart or printing it goes through get_pos_draft for
    the full cart shape.

    The opening shift is deliberately optional: a held invoice must still be
    reachable after the shift that parked it was closed.

    `limit` defaults to 0 - every held draft. A capped list would silently hide
    parked tickets, and a cashier cannot resume what the list does not show;
    holds are cleared as they are paid, so this set stays small in practice.

    Held drafts stay visible to every cashier on the profile on purpose, so a
    parked ticket can be resumed at any till - hence get_all rather than
    get_list, gated by _assert_pos_profile_access. Pass `owner` to narrow the
    list to a single cashier (delete_all_pos_drafts does this to protect other
    people's drafts).
    """
    _assert_pos_profile_access(pos_profile)

    fields = [
        "name",
        "customer",
        "customer_name",
        "pos_profile",
        "grand_total",
        "discount_amount",
        "coupon_code",
        "creation",
        "modified",
        "owner",
    ]
    if frappe.db.has_column("Sales Invoice", "posa_pos_opening_shift"):
        fields.append("posa_pos_opening_shift")

    rows = frappe.get_all(
        "Sales Invoice",
        filters=_pos_draft_filters(pos_profile, pos_opening_shift, owner),
        fields=fields,
        order_by="creation desc",
        # 0 means "every held draft" (Frappe's no-limit convention).
        limit_page_length=cint(limit),
    )

    if not rows:
        return []

    # One query for every line of every listed draft.
    items_by_draft = {}
    for item in frappe.get_all(
        "Sales Invoice Item",
        filters={"parent": ["in", [row["name"] for row in rows]]},
        fields=["parent", "item_code", "item_name", "qty", "uom", "rate", "amount"],
        order_by="parent asc, idx asc",
        limit_page_length=0,
    ):
        items_by_draft.setdefault(item["parent"], []).append(item)

    return [
        _serialize_pos_draft_summary(row, items_by_draft.get(row["name"]) or [])
        for row in rows
    ]


@frappe.whitelist()
def get_pos_draft(invoice_name):
    """Read a single held draft in cart shape."""
    return _serialize_pos_draft(_get_pos_draft_doc(invoice_name))


@frappe.whitelist()
def get_pos_draft_states(invoice_names):
    """Docstatus of the given invoices, keyed by name; unknown names are omitted.

    Lets the POS reconcile a hold kept in the browser cache against the Sales
    Invoice it is bound to - a hold whose invoice was submitted elsewhere (or by
    this device's own offline queue) is spent, and one whose invoice was
    cancelled or deleted has nothing left to update. See pruneBoundDrafts in
    stores/posDrafts.js.
    """
    names = json.loads(invoice_names) if isinstance(invoice_names, str) else invoice_names

    if not names:
        return {}

    return {
        row["name"]: cint(row["docstatus"])
        for row in frappe.get_all(
            "Sales Invoice",
            # is_pos scopes this to tickets the POS could have held, so it cannot
            # be used to probe unrelated documents.
            filters={"name": ["in", list(names)], "is_pos": 1},
            fields=["name", "docstatus"],
            limit_page_length=0,
        )
    }


@frappe.whitelist()
def delete_pos_draft(invoice_name):
    """Delete a single held draft."""
    doc = _get_pos_draft_doc(invoice_name, ptype="delete")

    frappe.delete_doc("Sales Invoice", doc.name, force=1)
    frappe.db.commit()

    return {"deleted": doc.name}


@frappe.whitelist()
def delete_all_pos_drafts(pos_profile=None, pos_opening_shift=None):
    """Clear held drafts for this profile.

    Held drafts are shared - every cashier on the profile can see and resume one
    (see get_pos_drafts), and the stock POS roles let a cashier read and delete
    invoices raised by colleagues. Clear All must therefore not become a way for
    one cashier to wipe the tickets another cashier parked: it removes only the
    caller's own drafts unless the caller holds one of POS_DRAFT_MANAGER_ROLES.

    Returns the deleted and failed names plus `skipped`, the number of other
    cashiers' drafts that were deliberately left in place, so the POS can tell
    the user why the list did not empty completely.
    """
    _assert_pos_profile_access(pos_profile)

    owner_only = not _can_delete_others_drafts()

    names = _pos_draft_names(
        pos_profile=pos_profile,
        pos_opening_shift=pos_opening_shift,
        owner=frappe.session.user if owner_only else None,
    )

    skipped = 0
    if owner_only:
        visible = _pos_draft_names(
            pos_profile=pos_profile, pos_opening_shift=pos_opening_shift
        )
        skipped = max(len(visible) - len(names), 0)

    deleted, failed = [], []
    for name in names:
        try:
            frappe.delete_doc("Sales Invoice", name, force=1)
            deleted.append(name)
        except Exception as e:
            failed.append(name)
            frappe.log_error(
                f"Failed to delete held draft {name}: {e}",
                "POS Draft Delete Error",
            )

    if deleted:
        frappe.db.commit()

    return {"deleted": deleted, "failed": failed, "skipped": skipped}


# ==========================================
# Return Invoice Management
# ==========================================


@frappe.whitelist()
def get_returnable_invoices(limit=0):
    """Get list of invoices that have items available for return.

    """
    # Performance: Use SQL aggregation to calculate returned quantities in one query
    # This eliminates N+1 queries by joining return invoices and aggregating in the database

    query = """
        SELECT
            si.name,
            si.customer,
            si.customer_name,
            si.posting_date,
            si.grand_total,
            si.status,
            COALESCE(SUM(CASE WHEN ret_item.qty IS NOT NULL THEN ABS(ret_item.qty) ELSE 0 END), 0) as total_returned_qty,
            COALESCE(SUM(CASE WHEN si_item.qty IS NOT NULL THEN si_item.qty ELSE 0 END), 0) as total_original_qty,
            GROUP_CONCAT(DISTINCT CONCAT_WS(' ', si_item.item_code, si_item.item_name) SEPARATOR ' ') as items_search
        FROM `tabSales Invoice` si
        LEFT JOIN `tabSales Invoice Item` si_item ON si_item.parent = si.name
        LEFT JOIN `tabSales Invoice` ret_si ON ret_si.return_against = si.name
            AND ret_si.docstatus = 1
            AND ret_si.is_return = 1
        LEFT JOIN `tabSales Invoice Item` ret_item ON ret_item.parent = ret_si.name
            AND (ret_item.sales_invoice_item = si_item.name OR ret_item.item_code = si_item.item_code)
        WHERE si.docstatus = 1
            AND si.is_return = 0
            AND si.is_pos = 1
        GROUP BY si.name
        HAVING total_original_qty > total_returned_qty
        ORDER BY si.posting_date DESC, si.creation DESC
    """

    values = []
    if cint(limit) > 0:
        query += " LIMIT %s"
        values.append(cint(limit))

    returnable_invoices = frappe.db.sql(query, values, as_dict=1)

    return returnable_invoices


@frappe.whitelist()
def get_invoice_for_return(invoice_name):
    """Get invoice with return tracking - calculates remaining qty for each item."""
    if not frappe.db.exists("Sales Invoice", invoice_name):
        frappe.throw(_("Invoice {0} does not exist").format(invoice_name))

    # Get the original invoice
    invoice = frappe.get_doc("Sales Invoice", invoice_name)

    # Performance: Use SQL aggregation to calculate returned quantities in one query
    # This eliminates N+1 queries by aggregating all return items at once
    returned_qty_query = """
        SELECT
            COALESCE(ret_item.sales_invoice_item, ret_item.item_code) as key_field,
            SUM(ABS(ret_item.qty)) as returned_qty
        FROM `tabSales Invoice` ret_si
        INNER JOIN `tabSales Invoice Item` ret_item ON ret_item.parent = ret_si.name
        WHERE ret_si.return_against = %s
            AND ret_si.docstatus = 1
            AND ret_si.is_return = 1
        GROUP BY key_field
    """

    returned_qty_results = frappe.db.sql(returned_qty_query, [invoice_name], as_dict=1)
    returned_qty = {row["key_field"]: row["returned_qty"] for row in returned_qty_results}

    # Calculate remaining quantities
    invoice_dict = invoice.as_dict()
    updated_items = []

    for item in invoice_dict.get("items", []):
        # Check how much has been returned using the item's name (row ID)
        already_returned = returned_qty.get(item.name, 0)
        remaining_qty = item.qty - already_returned

        if remaining_qty > 0:
            item_copy = item.copy()
            item_copy["original_qty"] = item.qty
            item_copy["qty"] = remaining_qty
            item_copy["already_returned"] = already_returned
            updated_items.append(item_copy)

    invoice_dict["items"] = updated_items
    return invoice_dict


@frappe.whitelist()
def search_invoices_for_return(
    invoice_name=None,
    company=None,
    customer_name=None,
    customer_id=None,
    mobile_no=None,
    from_date=None,
    to_date=None,
    min_amount=None,
    max_amount=None,
    page=1,
    doctype="Sales Invoice",
):
    """Search for invoices that can be returned with pagination."""
    # Start with base filters
    filters = {
        "docstatus": 1,
        "is_return": 0,
    }

    if company:
        filters["company"] = company

    # Convert page to integer
    if page and isinstance(page, str):
        page = int(page)
    else:
        page = 1

    # Items per page
    page_length = 100
    start = (page - 1) * page_length

    # Add invoice name filter
    if invoice_name:
        filters["name"] = ["like", f"%{invoice_name}%"]

    # Add date range filters
    if from_date:
        filters["posting_date"] = [">=", from_date]

    if to_date:
        if "posting_date" in filters:
            filters["posting_date"] = ["between", [from_date, to_date]]
        else:
            filters["posting_date"] = ["<=", to_date]

    # Add amount filters
    if min_amount:
        filters["grand_total"] = [">=", float(min_amount)]

    if max_amount:
        if "grand_total" in filters:
            filters["grand_total"] = ["between", [float(min_amount), float(max_amount)]]
        else:
            filters["grand_total"] = ["<=", float(max_amount)]

    # If any customer search criteria is provided, find matching customers
    customer_ids = []
    if customer_name or customer_id or mobile_no:
        conditions = []
        params = {}

        if customer_name:
            conditions.append("customer_name LIKE %(customer_name)s")
            params["customer_name"] = f"%{customer_name}%"

        if customer_id:
            conditions.append("name LIKE %(customer_id)s")
            params["customer_id"] = f"%{customer_id}%"

        if mobile_no:
            conditions.append("mobile_no LIKE %(mobile_no)s")
            params["mobile_no"] = f"%{mobile_no}%"

        where_clause = " OR ".join(conditions)
        customer_query = f"""
			SELECT name
			FROM `tabCustomer`
			WHERE {where_clause}
			LIMIT 100
		"""

        customers = frappe.db.sql(customer_query, params, as_dict=True)
        customer_ids = [c.name for c in customers]

        if customer_ids:
            filters["customer"] = ["in", customer_ids]
        elif any([customer_name, customer_id, mobile_no]):
            return {"invoices": [], "has_more": False}

    # Count total invoices
    total_count_query = frappe.get_list(
        doctype,
        filters=filters,
        fields=["count(name) as total_count"],
        as_list=False,
    )
    total_count = total_count_query[0].total_count if total_count_query else 0

    # Get invoices with pagination
    invoices_list = frappe.get_list(
        doctype,
        filters=filters,
        fields=["name"],
        limit_start=start,
        limit_page_length=page_length,
        order_by="posting_date desc, name desc",
    )

    if not invoices_list:
        return {"invoices": [], "has_more": False}

    # Performance: Batch query all returned quantities for all invoices at once
    # This eliminates N+1 queries by aggregating return data in a single SQL call
    invoice_names = [inv["name"] for inv in invoices_list]

    returned_qty_query = """
        SELECT
            ret_si.return_against as invoice_name,
            ret_item.item_code,
            SUM(ABS(ret_item.qty)) as returned_qty
        FROM `tabSales Invoice` ret_si
        INNER JOIN `tabSales Invoice Item` ret_item ON ret_item.parent = ret_si.name
        WHERE ret_si.return_against IN %s
            AND ret_si.docstatus = 1
            AND ret_si.is_return = 1
        GROUP BY ret_si.return_against, ret_item.item_code
    """

    returned_qty_results = frappe.db.sql(returned_qty_query, [invoice_names], as_dict=1)

    # Build a map of invoice_name -> {item_code: returned_qty}
    returned_qty_map = {}
    for row in returned_qty_results:
        inv_name = row["invoice_name"]
        if inv_name not in returned_qty_map:
            returned_qty_map[inv_name] = {}
        returned_qty_map[inv_name][row["item_code"]] = row["returned_qty"]

    # Process and return results
    data = []

    for invoice in invoices_list:
        invoice_doc = frappe.get_doc(doctype, invoice.name)
        returned_qty = returned_qty_map.get(invoice.name, {})

        if returned_qty:
            # Filter items with remaining qty
            filtered_items = []
            for item in invoice_doc.items:
                already_returned = returned_qty.get(item.item_code, 0)
                remaining_qty = item.qty - already_returned

                if remaining_qty > 0:
                    new_item = item.as_dict().copy()
                    new_item["qty"] = remaining_qty
                    new_item["amount"] = remaining_qty * item.rate
                    if item.get("stock_qty"):
                        new_item["stock_qty"] = (
                            item.stock_qty / item.qty * remaining_qty
                            if item.qty
                            else remaining_qty
                        )
                    filtered_items.append(frappe._dict(new_item))

            if filtered_items:
                filtered_invoice = frappe.get_doc(doctype, invoice.name)
                filtered_invoice.items = filtered_items
                data.append(filtered_invoice)
        else:
            data.append(invoice_doc)

    # Check if there are more results
    has_more = (start + page_length) < total_count

    return {"invoices": data, "has_more": has_more}


# ==========================================
def _brand_has_pricing_rule(brand):
    """Return True if any enabled selling Pricing Rule targets this brand."""
    if not brand:
        return False
    return bool(
        frappe.db.sql(
            """
            SELECT 1
            FROM `tabPricing Rule Brand` prb
            INNER JOIN `tabPricing Rule` pr ON pr.name = prb.parent
            WHERE prb.brand = %s AND pr.disable = 0 AND pr.selling = 1
            LIMIT 1
            """,
            (brand,),
        )
    )


def _get_item_offer_brand(item_code, parent_brand=None):
    """Return the brand to use when matching Brand pricing rules / offers.

    Priority mirrors taraknath/overrides/pricing_rule.py: use the item's
    custom_sub_brand when it has one AND a pricing rule targets that sub-brand;
    otherwise fall back to the item's brand. So a sub-brand only "wins" when it
    actually has an offer - if it has none, brand offers still apply.
    """
    parent = parent_brand
    if parent is None and item_code:
        parent = frappe.get_cached_value("Item", item_code, "brand")

    sub_brand = (
        frappe.db.get_value("Item", item_code, "custom_sub_brand")
        if item_code
        else None
    )

    if sub_brand and _brand_has_pricing_rule(sub_brand):
        return sub_brand

    return parent


def _check_item_matches_rule(item_doc, rule_name):
    try:
        full_rule = frappe.get_cached_doc("Pricing Rule", rule_name)
        if full_rule.disable:
            return False

        apply_on = full_rule.apply_on
        if apply_on == "Transaction":
            return True

        item_code = item_doc.get("item_code")

        if apply_on == "Item Code":
            rule_items = [d.item_code for d in (full_rule.get("items") or []) if d.item_code]
            return item_code in rule_items

        elif apply_on == "Item Group":
            rule_groups = [d.item_group for d in (full_rule.get("item_groups") or []) if d.item_group]
            item_group = item_doc.get("item_group")
            if not item_group and item_code:
                item_group = frappe.get_cached_value("Item", item_code, "item_group")
            if item_group and item_group in rule_groups:
                return True
            if item_group:
                from erpnext.setup.doctype.item_group.item_group import get_parent_item_groups
                parent_groups = get_parent_item_groups(item_group) or []
                if any(g in rule_groups for g in parent_groups):
                    return True

        elif apply_on == "Brand":
            rule_brands = [d.brand for d in (full_rule.get("brands") or []) if d.brand]
            # Guard: match on custom_sub_brand when present, else the item's brand.
            match_brand = _get_item_offer_brand(item_code, item_doc.get("brand"))
            return bool(match_brand and match_brand in rule_brands)
    except Exception:
        pass
    return False


@frappe.whitelist()
def apply_offers(invoice_data, selected_offers=None):
    """Calculate and apply promotional offers using ERPNext Pricing Rules.

    Args:
            invoice_data (str | dict): Sales Invoice payload used for offer evaluation.
            selected_offers (str | list | None): Optional collection of Pricing Rule names.
                    When provided, results are filtered to only include these rules.
                    ERPNext handles all conflict resolution based on priority.
    """
    try:
        if isinstance(invoice_data, str):
            invoice_data = json.loads(invoice_data or "{}")

        invoice = frappe._dict(invoice_data or {})
        items = invoice.get("items") or []

        if isinstance(selected_offers, str):
            try:
                selected_offers = json.loads(selected_offers)
            except ValueError:
                selected_offers = [selected_offers]

        if isinstance(selected_offers, (list, tuple, set)):
            selected_offer_names = {
                cstr(name) for name in selected_offers if cstr(name)
            }
        else:
            selected_offer_names = set()

        if not items:
            return {"items": []}

        if not invoice.get("pos_profile") or not erpnext_apply_pricing_rule:
            # Either no POS profile supplied or ERPNext promotional engine unavailable
            return {"items": items}

        profile = frappe.get_doc("POS Profile", invoice.get("pos_profile"))

        pricing_items = []
        index_map = []
        prepared_items = [frappe._dict(row) for row in items]

        for idx, item in enumerate(prepared_items):
            item_code = item.get("item_code")
            qty = flt(item.get("qty") or item.get("quantity") or 0)

            if not item_code or qty <= 0:
                continue

            try:
                cached = frappe.get_cached_value(
                    "Item",
                    item_code,
                    ["item_name", "item_group", "brand", "stock_uom"],
                    as_dict=1,
                )
            except frappe.DoesNotExistError:
                cached = None

            conversion_factor = flt(item.get("conversion_factor") or 1) or 1
            price_list_rate = flt(item.get("price_list_rate") or item.get("rate") or 0)

            pricing_items.append(
                frappe._dict(
                    {
                        "doctype": "Sales Invoice Item",
                        "name": item.get("name") or f"POS-{idx}",
                        "item_code": item_code,
                        "item_name": (
                            cached.item_name if cached else item.get("item_name")
                        ),
                        "item_group": (
                            cached.item_group if cached else item.get("item_group")
                        ),
                        # Pass the item's brand as-is. taraknath's _get_pricing_rules
                        # override resolves Brand rules against custom_sub_brand first
                        # and falls back to the brand when the sub-brand has no rule.
                        "brand": (cached.brand if cached else item.get("brand")),
                        "qty": qty,
                        "stock_qty": qty * conversion_factor,
                        "conversion_factor": conversion_factor,
                        "uom": item.get("uom")
                        or item.get("stock_uom")
                        or (cached.stock_uom if cached else None),
                        "stock_uom": item.get("stock_uom")
                        or (cached.stock_uom if cached else None),
                        "price_list_rate": price_list_rate,
                        "base_price_list_rate": price_list_rate,
                        "rate": flt(item.get("rate") or price_list_rate),
                        "base_rate": flt(item.get("rate") or price_list_rate),
                        "discount_percentage": 0,
                        "discount_amount": 0,
                        "warehouse": item.get("warehouse") or profile.warehouse,
                        "parenttype": invoice.get("doctype") or "Sales Invoice",
                    }
                )
            )
            index_map.append(idx)

            # Clear previously applied promotional metadata if the
            # current quantity can no longer satisfy the rule.
            item.discount_percentage = 0
            item.discount_amount = 0
            item.pricing_rules = []
            item.applied_promotional_schemes = []

        if not pricing_items:
            return {"items": items}

        company_currency = frappe.get_cached_value(
            "Company", profile.company, "default_currency"
        )

        # Get customer details if customer is provided
        customer = invoice.get("customer")
        customer_group = invoice.get("customer_group")
        territory = invoice.get("territory")

        if customer and not customer_group:
            # Fetch customer_group from customer
            try:
                customer_data = frappe.get_cached_value(
                    "Customer", customer, ["customer_group", "territory"], as_dict=1
                )
                if customer_data:
                    customer_group = customer_data.get("customer_group")
                    if not territory:
                        territory = customer_data.get("territory")
            except Exception:
                pass

        # If still no customer_group, use default
        if not customer_group:
            customer_group = "All Customer Groups"

        pricing_args = frappe._dict(
            {
                "doctype": invoice.get("doctype") or "Sales Invoice",
                "name": invoice.get("name") or "POS-INVOICE",
                "company": profile.company,
                "transaction_date": invoice.get("posting_date") or nowdate(),
                "posting_date": invoice.get("posting_date") or nowdate(),
                "currency": invoice.get("currency")
                or profile.get("currency")
                or company_currency,
                "conversion_rate": flt(invoice.get("conversion_rate") or 1) or 1,
                "plc_conversion_rate": flt(invoice.get("plc_conversion_rate") or 1)
                or 1,
                "price_list": invoice.get("price_list")
                or profile.get("selling_price_list"),
                "customer": customer,
                "customer_group": customer_group,
                "territory": territory,
                "items": pricing_items,
            }
        )

        # Call ERPNext pricing engine - it handles all conflicts based on priority
        pricing_results = erpnext_apply_pricing_rule(pricing_args) or []

        if not pricing_results:
            return {"items": items}

        raw_rule_names = set()
        for result in pricing_results:
            if not result:
                continue
            rules = []
            if erpnext_get_applied_pricing_rules:
                rules = erpnext_get_applied_pricing_rules(result.get("pricing_rules"))
            else:
                raw_rules = result.get("pricing_rules") or []
                if isinstance(raw_rules, str):
                    if raw_rules.startswith("["):
                        rules = json.loads(raw_rules)
                    else:
                        rules = [r.strip() for r in raw_rules.split(",") if r.strip()]
                elif isinstance(raw_rules, (list, tuple, set)):
                    rules = list(raw_rules)
            raw_rule_names.update(rules)

        all_target_rule_names = set(raw_rule_names) | set(selected_offer_names)

        rule_map = {}
        if all_target_rule_names:
            rule_records = frappe.get_all(
                "Pricing Rule",
                filters={"name": ["in", list(all_target_rule_names)]},
                fields=[
                    "name",
                    "title",
                    "promotional_scheme",
                    "coupon_code_based",
                    "promotional_scheme_id",
                    "price_or_product_discount",
                    "apply_on",
                    "rate_or_discount",
                    "discount_percentage",
                    "discount_amount",
                    "rate",
                    "applicable_for",
                    "customer",
                    "customer_group",
                    "territory",
                ],
            )

            # A Pricing Rule can be restricted via "Applicable For"
            # (Customer / Customer Group / Territory). Drop rules that do not
            # target this customer, otherwise the selected-offer fallback below
            # (_check_item_matches_rule) - which only matches on item/brand -
            # could apply another customer group's discount.
            allowed_customer_groups = []
            allowed_territories = []
            if customer:
                from pos_next.api.offers import (
                    _get_tree_lineage,
                    _offer_matches_customer,
                )

                customer_details = (
                    frappe.db.get_value(
                        "Customer",
                        customer,
                        ["customer_group", "territory"],
                        as_dict=True,
                    )
                    or {}
                )
                allowed_customer_groups = _get_tree_lineage(
                    "Customer Group",
                    customer_group or customer_details.get("customer_group"),
                )
                allowed_territories = _get_tree_lineage(
                    "Territory", territory or customer_details.get("territory")
                )

            for record in rule_records:
                if record.coupon_code_based:
                    continue
                if customer and not _offer_matches_customer(
                    record, customer, allowed_customer_groups, allowed_territories
                ):
                    continue
                rule_map[record.name] = record

        if selected_offer_names:
            # Restrict available rules to the ones explicitly selected from the UI.
            rule_map = {
                name: details
                for name, details in rule_map.items()
                if name in selected_offer_names
                or (details.get("promotional_scheme") and details.get("promotional_scheme") in selected_offer_names)
                or (details.get("promotional_scheme_id") and details.get("promotional_scheme_id") in selected_offer_names)
            }

        if not rule_map:
            return {"items": items}

        applied_rules = set()
        free_items = []

        for item_index in range(len(prepared_items)):
            item_doc = prepared_items[item_index]
            result = pricing_results[item_index] if item_index < len(pricing_results) else {}

            rule_names = []
            if result:
                if erpnext_get_applied_pricing_rules:
                    rule_names = erpnext_get_applied_pricing_rules(
                        result.get("pricing_rules")
                    )
                else:
                    raw_rules = result.get("pricing_rules") or []
                    if isinstance(raw_rules, str):
                        if raw_rules.startswith("["):
                            rule_names = json.loads(raw_rules)
                        else:
                            rule_names = [
                                r.strip() for r in raw_rules.split(",") if r.strip()
                            ]
                    elif isinstance(raw_rules, (list, tuple, set)):
                        rule_names = list(raw_rules)

            applicable_rule_names = [
                name for name in rule_names or [] if name in rule_map
            ]

            if selected_offer_names and not applicable_rule_names:
                for sel_name in rule_map.keys():
                    if _check_item_matches_rule(item_doc, sel_name):
                        applicable_rule_names.append(sel_name)

            if not applicable_rule_names:
                continue

            applied_rules.update(applicable_rule_names)

            qty = flt(item_doc.get("qty") or item_doc.get("quantity") or 0)
            price_list_rate = flt(
                (result and result.get("price_list_rate"))
                or item_doc.get("price_list_rate")
                or item_doc.get("rate")
                or 0
            )

            # Get discount from result or fetch from pricing rule
            discount_percentage = flt((result and result.get("discount_percentage")) or 0)
            per_unit_discount = flt((result and result.get("discount_amount")) or 0)

            if (
                not discount_percentage
                and not per_unit_discount
                and applicable_rule_names
            ):
                for rule_name in applicable_rule_names:
                    rule_doc = rule_map.get(rule_name)
                    if not rule_doc:
                        continue

                    # Fetch full pricing rule to get discount values
                    full_rule = frappe.get_cached_doc("Pricing Rule", rule_name)

                    if (
                        full_rule.rate_or_discount == "Discount Percentage"
                        and full_rule.discount_percentage
                    ):
                        discount_percentage += flt(full_rule.discount_percentage)
                    elif (
                        full_rule.rate_or_discount == "Discount Amount"
                        and full_rule.discount_amount
                    ):
                        per_unit_discount += flt(full_rule.discount_amount)
                    elif full_rule.rate_or_discount == "Rate" and full_rule.rate:
                        # Apply fixed rate
                        price_list_rate = flt(full_rule.rate)

            line_discount_amount = 0
            if discount_percentage and qty and price_list_rate:
                line_discount_amount = price_list_rate * qty * discount_percentage / 100
            elif per_unit_discount and qty:
                line_discount_amount = per_unit_discount * qty
            else:
                line_discount_amount = per_unit_discount

            if (
                not discount_percentage
                and line_discount_amount
                and qty
                and price_list_rate
            ):
                base_amount = price_list_rate * qty
                if base_amount:
                    discount_percentage = (line_discount_amount / base_amount) * 100

            item_doc.discount_percentage = discount_percentage
            item_doc.discount_amount = line_discount_amount
            item_doc.price_list_rate = price_list_rate
            item_doc.rate = flt(item_doc.get("rate") or price_list_rate)
            item_doc.pricing_rules = applicable_rule_names

            item_doc.applied_promotional_schemes = list(
                {
                    rule_map[name].promotional_scheme
                    for name in applicable_rule_names
                    if rule_map[name].promotional_scheme
                }
            )

            for free_item in (result and result.get("free_item_data")) or []:
                rule_name = free_item.get("pricing_rules")
                if not rule_name or rule_name not in rule_map:
                    continue
                free_item_doc = frappe._dict(free_item)
                free_item_doc.applied_promotional_scheme = rule_map[
                    rule_name
                ].promotional_scheme
                free_items.append(free_item_doc)

        return {
            "items": [dict(item) for item in prepared_items],
            "free_items": [dict(item) for item in free_items],
            "applied_pricing_rules": sorted(applied_rules),
        }
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Apply Offers Error")
        frappe.throw(_("Error applying offers: {0}").format(str(e)))
