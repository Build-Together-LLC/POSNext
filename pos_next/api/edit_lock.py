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


# Read and write straight through the Redis client rather than frappe.cache().get_value(), which
# consults a request-local dict first. That local copy carries no expiry, so a lapsed claim could
# still read as held — exactly the "stays locked forever" case this is meant to avoid.
def _holder(doctype: str, name: str) -> dict | None:
	try:
		raw = frappe.cache().get(_key(doctype, name))
	except Exception:
		# Cache unreachable. Report "nobody holds it" so billing keeps working; the guard below
		# fails open by design rather than blocking every sale on a Redis blip.
		return None

	if not raw:
		return None

	try:
		return json.loads(raw)
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
	return _("{0} is being edited by {1} right now. Please try again in a moment.").format(
		name, holder.get("full_name") or holder.get("user")
	)


# Refuse a write while someone else holds the document, and take (or renew) the claim otherwise.
#
# Called from the write endpoints, so the first cashier to touch a document holds it for as long as
# they keep working on it and a second is turned away with a clear message. Every response carries
# an explicit "ok", so a caller can never read a failure as a successful claim.
def guard(doctype: str, name: str) -> None:
	if not (doctype and name):
		return

	holder = _holder(doctype, name)
	if holder and holder.get("user") != frappe.session.user:
		frappe.throw(_locked_message(name, holder), title=_("Document Locked"))

	_store(doctype, name, frappe.session.user)


@frappe.whitelist()
def claim(doctype: str, name: str) -> dict:
	"""Take or renew the lock on a document, or report who is holding it.

	Renewing rather than refusing when the holder is the current user keeps a reload, or a second
	tab, from locking a user out of their own document.
	"""
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

	return {"ok": True, "locked": False, "user": me}


@frappe.whitelist()
def release(doctype: str, name: str) -> dict:
	"""Give up the lock, but only if it is ours — never drop another user's claim."""
	if not (doctype and name):
		return {"ok": False, "released": False, "reason": "missing-arguments"}

	holder = _holder(doctype, name)
	if holder and holder.get("user") == frappe.session.user:
		try:
			frappe.cache().delete(_key(doctype, name))
		except Exception:
			return {"ok": False, "released": False, "reason": "cache-unavailable"}
		return {"ok": True, "released": True}

	return {"ok": True, "released": False}
