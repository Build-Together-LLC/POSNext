import { call } from "@/utils/apiWrapper"
import { ref } from "vue"

// Comfortably inside the server's 60s TTL, so a lock never lapses while the screen is still open.
const HEARTBEAT_MS = 25000

// Single-editor lock for documents two tills can reach at once.
const lockedBy = ref(null)
let timer = null
let held = null

function getCookie(name) {
	if (typeof document === "undefined") return null
	const value = `; ${document.cookie}`
	const parts = value.split(`; ${name}=`)
	if (parts.length === 2) {
		return parts.pop().split(";").shift() || null
	}
	return null
}

function sendReleaseBeacon(doctype, name) {
	if (!doctype || !name) return
	try {
		const csrfToken =
			(typeof window !== "undefined" && (window.csrf_token || window.frappe?.csrf_token)) ||
			getCookie("csrf_token")

		const headers = {
			"Content-Type": "application/json",
		}
		if (csrfToken && csrfToken !== "None") {
			headers["X-Frappe-CSRF-Token"] = csrfToken
		}

		// 1. fetch with keepalive: true — POST request with CSRF token
		if (typeof fetch === "function") {
			fetch("/api/method/pos_next.api.edit_lock.release", {
				method: "POST",
				headers,
				body: JSON.stringify({ doctype, name }),
				keepalive: true,
				credentials: "same-origin",
			}).catch(() => {})
		} else if (typeof navigator !== "undefined" && navigator.sendBeacon) {
			// 2. navigator.sendBeacon fallback with CSRF token in FormData
			const data = new FormData()
			data.append("doctype", doctype)
			data.append("name", name)
			if (csrfToken && csrfToken !== "None") {
				data.append("csrf_token", csrfToken)
			}
			navigator.sendBeacon("/api/method/pos_next.api.edit_lock.release", data)
		}
	} catch (_) {}
}

// Setup beforeunload and pagehide to immediately release lock when tab/browser closes
if (typeof window !== "undefined") {
	const handleUnload = () => {
		if (held && held.doctype && held.name) {
			sendReleaseBeacon(held.doctype, held.name)
		}
	}
	window.addEventListener("beforeunload", handleUnload)
	window.addEventListener("pagehide", handleUnload)
}

export function useEditLock() {
	async function request(method, doctype, name) {
		try {
			return await call(`pos_next.api.edit_lock.${method}`, { doctype, name })
		} catch (error) {
			// A call that never landed is not a held lock. Say so explicitly, so a failure can
			// never be read as a successful claim.
			return { ok: false, locked: false, reason: "request-failed" }
		}
	}

	function stopHeartbeat() {
		if (timer) clearInterval(timer)
		timer = null
	}

	// Give up whatever we are holding. Safe to call when we hold nothing.
	async function release() {
		stopHeartbeat()

		if (!held) return

		const { doctype, name } = held
		held = null
		lockedBy.value = null

		await request("release", doctype, name)
	}

	// Take the document. Returns false, and fills lockedBy, when someone else has it.
	async function acquire(doctype, name) {
		if (!doctype || !name) return true

		if (held && held.doctype === doctype && held.name === name) {
			if (!timer) {
				timer = setInterval(() => request("claim", doctype, name), HEARTBEAT_MS)
			}
			return true
		}

		await release()

		const res = await request("claim", doctype, name)
		if (res?.locked) {
			lockedBy.value = res
			return false
		}

		lockedBy.value = null
		held = { doctype, name }

		stopHeartbeat()
		timer = setInterval(() => request("claim", doctype, name), HEARTBEAT_MS)

		return true
	}

	function isHolding(doctype, name) {
		return Boolean(held && held.doctype === doctype && held.name === name)
	}

	return {
		acquire,
		release,
		lockedBy,
		isHolding,
		heldLock: () => held,
	}
}
