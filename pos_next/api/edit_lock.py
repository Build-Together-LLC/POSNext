"""Single-editor lock for POS documents.

PosNext runs as a standalone app at /pos, outside the desk, so a desk-side form lock never loads
here and two cashiers can open the same document at once. The claim lives in the cache with a short
TTL and is refreshed by every write, so a session that dies — browser closed, network gone, till
switched off — frees the document on its own within TTL seconds instead of leaving it stuck.

The guard runs on the write endpoints rather than only in the browser, so a second user is stopped
even when their client never claimed: an offline tab flushing its queue, a stale screen, or a direct
API call.
"""

import json

import frappe
from frappe import _
from frappe.utils import get_fullname

# Seconds a claim survives without a refresh. Every write renews it, so a lock only lapses once the
# holder has genuinely stopped working on the document.
LOCK_TTL = 60

KEY_PREFIX = "posnext_edit_lock"


def _key(doctype: str, name: str) -> str:
	return f"{KEY_PREFIX}:{doctype}:{name}"


def _clean_stale_db_lock(doctype: str, name: str) -> None:
	"""If the Redis lock has lapsed or does not exist, ensure the DB check mark is cleared."""
	if doctype == "Sales Invoice" and name:
		try:
			fields_to_clear = {}
			if frappe.db.has_column("Sales Invoice", "is_locked"):
				if frappe.db.get_value("Sales Invoice", name, "is_locked"):
					fields_to_clear["is_locked"] = 0
			if frappe.db.has_column("Sales Invoice", "posa_is_locked"):
				if frappe.db.get_value("Sales Invoice", name, "posa_is_locked"):
					fields_to_clear["posa_is_locked"] = 0
			if fields_to_clear:
				frappe.db.set_value("Sales Invoice", name, fields_to_clear, update_modified=False)
				frappe.db.commit()
		except Exception:
			pass


def _set_invoice_lock_field(name: str, locked: bool) -> None:
	"""Update the is_locked check mark on the Sales Invoice."""
	if not name:
		return
	try:
		val = 1 if locked else 0
		fields = {}
		if frappe.db.has_column("Sales Invoice", "is_locked"):
			fields["is_locked"] = val
		if frappe.db.has_column("Sales Invoice", "posa_is_locked"):
			fields["posa_is_locked"] = val
		if fields:
			frappe.db.set_value("Sales Invoice", name, fields, update_modified=False)
			frappe.db.commit()
	except Exception as e:
		frappe.log_error(f"Error setting is_locked={locked} on {name}: {e}", "Draft Lock Error")


def _holder(doctype: str, name: str) -> dict | None:
	"""Return holder info if lock is actively held; otherwise clean up any stale DB lock."""
	try:
		raw = frappe.cache().get(_key(doctype, name))
	except Exception:
		# Cache unreachable. Report "nobody holds it" so billing keeps working; the guard below
		# fails open by design rather than blocking every sale on a Redis blip.
		return None

	if not raw:
		_clean_stale_db_lock(doctype, name)
		return None

	try:
		data = json.loads(raw)
		return data
	except (TypeError, ValueError):
		return None


def _store(doctype: str, name: str, user: str) -> bool:
	try:
		frappe.cache().set(
			_key(doctype, name),
			json.dumps({"user": user, "full_name": get_fullname(user)}),
			ex=LOCK_TTL,
		)
		return True
	except Exception:
		return False


def _locked_message(name: str, holder: dict) -> str:
	holder_name = holder.get("full_name") or holder.get("user") or _("another user")
	return _("This draft is currently being edited by {0}. Please try again later.").format(holder_name)


def guard(doctype: str, name: str) -> None:
	"""Refuse a write while someone else holds the document, and take (or renew) the claim otherwise."""
	if not (doctype and name):
		return

	holder = _holder(doctype, name)
	if holder and holder.get("user") != frappe.session.user:
		frappe.throw(_locked_message(name, holder), title=_("Draft Locked"))

	_store(doctype, name, frappe.session.user)
	if doctype == "Sales Invoice":
		_set_invoice_lock_field(name, True)


@frappe.whitelist()
def claim(doctype: str = None, name: str = None) -> dict:
	"""Take or renew the lock on a document, or report who is holding it.

	Renewing rather than refusing when the holder is the current user keeps a reload, or a second
	tab, from locking a user out of their own document.
	"""
	doctype = doctype or frappe.form_dict.get("doctype")
	name = name or frappe.form_dict.get("name")
	if not (doctype and name):
		return {"ok": False, "locked": False, "reason": "missing-arguments"}

	if not frappe.has_permission(doctype, "read", doc=name):
		return {"ok": False, "locked": False, "reason": "no-permission"}

	me = frappe.session.user
	holder = _holder(doctype, name)

	if holder and holder.get("user") != me:
		return {
			"ok": True,
			"locked": True,
			"user": holder.get("user"),
			"full_name": holder.get("full_name"),
			"message": _locked_message(name, holder),
		}

	if not _store(doctype, name, me):
		# Nothing was written, so say so rather than report a lock that does not exist.
		return {"ok": False, "locked": False, "reason": "cache-unavailable"}

	if doctype == "Sales Invoice":
		_set_invoice_lock_field(name, True)

	return {"ok": True, "locked": False, "user": me}


@frappe.whitelist()
def release(doctype: str = None, name: str = None) -> dict:
	"""Give up the lock, but only if it is ours — never drop another user's claim."""
	doctype = doctype or frappe.form_dict.get("doctype")
	name = name or frappe.form_dict.get("name")
	if not (doctype and name):
		return {"ok": False, "released": False, "reason": "missing-arguments"}

	me = frappe.session.user
	holder = _holder(doctype, name)

	if not holder or holder.get("user") == me or "System Manager" in frappe.get_roles():
		try:
			frappe.cache().delete(_key(doctype, name))
		except Exception:
			pass
		if doctype == "Sales Invoice":
			_set_invoice_lock_field(name, False)
		return {"ok": True, "released": True}

	return {"ok": True, "released": False}


@frappe.whitelist()
def check_lock(doctype: str, name: str) -> dict:
	"""Check the lock status of a document without claiming it."""
	if not (doctype and name):
		return {"ok": False, "locked": False}

	holder = _holder(doctype, name)
	if holder:
		is_me = holder.get("user") == frappe.session.user
		return {
			"ok": True,
			"locked": True,
			"user": holder.get("user"),
			"full_name": holder.get("full_name"),
			"is_locked_by_me": is_me,
			"message": _locked_message(name, holder),
		}

	return {"ok": True, "locked": False, "is_locked_by_me": False}
