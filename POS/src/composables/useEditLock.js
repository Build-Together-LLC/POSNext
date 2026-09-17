import { call } from "@/utils/apiWrapper"
import { ref } from "vue"

// Comfortably inside the server's 60s TTL, so a lock never lapses while the screen is still open.
const HEARTBEAT_MS = 25000

// Single-editor lock for documents two tills can reach at once.
//
// This is the friendly half: it warns the second cashier before they start typing instead of
// letting them fill in a payment and fail on save. The binding half is the guard on the write
// endpoints — so if a claim here fails for any reason we let the user carry on and rely on the
// server to refuse, rather than blocking a sale over a cache blip.
export function useEditLock() {
	const lockedBy = ref(null)

	let timer = null
	let held = null

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

	return { acquire, release, lockedBy }
}
