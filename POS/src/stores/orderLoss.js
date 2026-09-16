import { call } from "@/utils/apiWrapper"
import { isOffline } from "@/utils/offline"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { defineStore } from "pinia"
import { computed, ref } from "vue"

/**
 * Loss of order — what customers asked for that the till could not sell.
 *
 * The POS refuses or clamps a quantity whenever the shelf cannot cover the ask.
 * That refusal is the only moment the demand exists: the cart ends up holding
 * what was actually sold, and an item with no stock at all never reaches the
 * cart at all. Every one of those guards calls recordShortfall() here, the
 * cashier confirms the number, and the row is written within seconds — before
 * anyone knows whether a sale will follow, which is what makes a customer
 * walking away empty-handed recordable.
 *
 * Quantities MERGE rather than accumulate (largest ask wins), so replaying a
 * flush after a timeout, or scanning the same empty shelf five times, cannot
 * inflate the number. The server merges the same way.
 */

const SESSION_STORAGE_KEY = "pos_next_order_loss_session"

// Long enough to collapse a "1 → 10 → 100 → backspace" typing burst into a
// single write, short enough that an abandoned cart is already recorded.
const FLUSH_DEBOUNCE_MS = 3000

/** Mirrors make_idempotency_key in pos_order_loss.py — the two must agree. */
function lossKey({ item_code, uom, warehouse, batch_no }) {
	return [item_code || "", uom || "", warehouse || "", batch_no || ""].join("::")
}

function newSessionId() {
	return `ol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const usePOSOrderLossStore = defineStore("posOrderLoss", () => {
	const settingsStore = usePOSSettingsStore()

	// Survives a page reload so an F5 mid-cart does not orphan the rows already
	// written, or start a second session for the same customer.
	const sessionId = ref(
		(typeof localStorage !== "undefined" &&
			localStorage.getItem(SESSION_STORAGE_KEY)) ||
			newSessionId(),
	)

	// key -> entry the cashier has confirmed. Kept after a flush so a later
	// shortfall for the same item merges instead of prompting again.
	const shortfalls = ref(new Map())

	// Shortfalls waiting to be confirmed. More than one only when a burst of
	// refusals arrives while the dialog is open.
	const queue = ref([])

	const flushing = ref(false)
	const lastFlushError = ref(null)
	let flushTimer = null

	const pendingPrompt = computed(() => queue.value[0] || null)

	const sessionTotals = computed(() => {
		let lostQty = 0
		let lostValue = 0

		for (const entry of shortfalls.value.values()) {
			const lost = Math.max(entry.demanded_qty - entry.available_qty, 0)
			lostQty += lost
			lostValue += lost * (entry.rate || 0)
		}

		return { items: shortfalls.value.size, lostQty, lostValue }
	})

	function persistSession(id) {
		try {
			localStorage.setItem(SESSION_STORAGE_KEY, id)
		} catch {
			// Private mode or storage full: the session still works for this tab.
		}
	}

	/**
	 * Start a fresh sale. Flush anything outstanding first — those rows belong
	 * to the cart that just ended.
	 */
	async function startNewSession() {
		await flush({ force: true }).catch(() => {})

		sessionId.value = newSessionId()
		shortfalls.value = new Map()
		queue.value = []
		persistSession(sessionId.value)
	}

	/**
	 * Bind to a held invoice, so rows recorded before the hold and after it is
	 * resumed belong to the same sale and reconcile together.
	 */
	function bindToDraft(invoiceName) {
		if (!invoiceName) return

		sessionId.value = `ol-inv-${invoiceName}`
		persistSession(sessionId.value)
	}

	/**
	 * Hold this cart's losses against the invoice it was just held as.
	 *
	 * Everything recorded before the hold is the same customer's as everything
	 * recorded after it is resumed, so the rows move onto the invoice's session.
	 * Without that, resuming the draft would start a second row per item instead
	 * of updating the one already there.
	 */
	async function bindToInvoice(invoiceName) {
		const target = invoiceName ? `ol-inv-${invoiceName}` : null
		if (!target || target === sessionId.value) return

		const previous = sessionId.value

		// Get what is in hand onto the server first, or it would be written under
		// the old session moments after the move.
		await flush({ force: true }).catch(() => {})

		try {
			const cartStore = await getCartStore()
			if (cartStore.posProfile) {
				await call("pos_next.api.order_loss.rebind_session", {
					old_session: previous,
					new_session: target,
					pos_profile: cartStore.posProfile,
				})
			}
		} catch (error) {
			console.warn("Loss of order: could not move rows onto the held invoice", error)
		}

		sessionId.value = target
		persistSession(target)
	}

	/**
	 * A shortfall just happened. Ask the cashier, unless this item is already
	 * being tracked for this sale.
	 *
	 * @param {Object} args
	 * @param {Object} args.item - The cart line or item tile that came up short
	 * @param {number} args.requestedQty - What the customer asked for
	 * @param {number} args.availableQty - What the till could actually give
	 * @param {string} args.source - Which till action detected it
	 * @param {string} [args.reason]
	 */
	function recordShortfall({ item, requestedQty, availableQty, source, reason }) {
		if (!settingsStore.shouldRecordOrderLoss()) return
		if (!item?.item_code) return

		const demanded = Number(requestedQty) || 0
		const available = Math.max(Number(availableQty) || 0, 0)

		if (demanded <= available) return

		const ceiling = settingsStore.orderLossMaxDemandQty()
		if (ceiling && demanded > ceiling) return

		const entry = {
			item_code: item.item_code,
			item_name: item.item_name || item.item_code,
			uom: item.uom || item.stock_uom || null,
			warehouse: item.warehouse || null,
			batch_no: item.batch_no || null,
			conversion_factor: Number(item.conversion_factor) || 1,
			rate: Number(item.price_list_rate ?? item.rate) || 0,
			demanded_qty: demanded,
			available_qty: available,
			source: source || "Manual",
			reason: reason || (available <= 0 ? "Out of Stock" : "Insufficient Stock"),
		}

		const key = lossKey(entry)

		// Every change of quantity is a new ask and gets its own prompt, so the
		// recorded demand always matches what the customer last asked for. Only a
		// prompt for the very same quantity is skipped - one action must not put
		// the same question up twice.
		if (queue.value.some((q) => lossKey(q) === key && q.demanded_qty === demanded)) {
			return
		}

		queue.value = [...queue.value, entry]
	}

	/**
	 * Put an entry in the ledger. The latest confirmed ask wins: 200 corrected to
	 * 300 is a customer who wants 300, and the server updates the same row.
	 */
	function commit(entry) {
		const key = lossKey(entry)
		const existing = shortfalls.value.get(key)

		const merged = existing
			? { ...existing, ...entry, rate: entry.rate || existing.rate }
			: { ...entry }

		shortfalls.value.set(key, merged)
		shortfalls.value = new Map(shortfalls.value)

		scheduleFlush()
	}

	/** The cashier confirmed the prompt, possibly correcting the quantity. */
	function confirmPrompt(demandedQty) {
		const entry = queue.value[0]
		if (!entry) return

		const demanded = Number(demandedQty) || entry.demanded_qty

		queue.value = queue.value.slice(1)

		if (demanded <= entry.available_qty) {
			// Corrected down to something the till can cover: nothing is lost any
			// more, so stop sending it. A row already on the server is cleared up
			// by the reconcile at checkout, which drops rows that lost nothing.
			shortfalls.value.delete(lossKey(entry))
			shortfalls.value = new Map(shortfalls.value)
			return
		}

		commit({ ...entry, demanded_qty: demanded })
	}

	/**
	 * The cashier said this ask was not a loss. Only this one: changing the
	 * quantity again asks again, because that is a different ask.
	 */
	function dismissPrompt() {
		if (!queue.value.length) return

		queue.value = queue.value.slice(1)
	}

	function scheduleFlush() {
		if (flushTimer) clearTimeout(flushTimer)
		flushTimer = setTimeout(() => flush().catch(() => {}), FLUSH_DEBOUNCE_MS)
	}

	/**
	 * Send the ledger to the server. Entries are kept, not cleared: the server
	 * upserts on the same key, so re-sending is a no-op, and keeping them lets a
	 * later shortfall for the same item merge correctly.
	 */
	async function flush({ force = false } = {}) {
		if (flushTimer) {
			clearTimeout(flushTimer)
			flushTimer = null
		}

		if (!settingsStore.shouldRecordOrderLoss()) return null
		if (shortfalls.value.size === 0) return null
		if (flushing.value && !force) return null

		const cartStore = await getCartStore()

		const entries = [...shortfalls.value.values()]
		const context = {
			pos_profile: cartStore.posProfile,
			cart_session_id: sessionId.value,
			pos_opening_shift: cartStore.posOpeningShift || null,
			customer: cartStore.customer?.name || cartStore.customer || null,
		}

		if (!context.pos_profile) return null

		// A disconnected till still knows what it could not sell. Hold it on the
		// device and let the reconnect sync push it up.
		if (isOffline()) {
			await queueOffline(entries, context)
			return null
		}

		flushing.value = true
		try {
			const result = await call("pos_next.api.order_loss.record_losses", {
				...context,
				losses: JSON.stringify(entries),
			})
			lastFlushError.value = null
			return result
		} catch (error) {
			// Recording demand must never interrupt a sale. Park it on the device
			// so a server that is up but unhappy does not lose the record.
			lastFlushError.value = error
			console.warn("Loss of order: could not record shortfalls", error)
			await queueOffline(entries, context)
			return null
		} finally {
			flushing.value = false
		}
	}

	async function queueOffline(entries, context) {
		try {
			const { saveOfflineOrderLosses } = await import("@/utils/offline")
			await saveOfflineOrderLosses(entries, context)
		} catch (error) {
			console.warn("Loss of order: could not queue shortfalls", error)
		}
	}

	// Imported lazily: posCart imports this store, so importing it back at module
	// scope would be a cycle.
	async function getCartStore() {
		const { usePOSCartStore } = await import("@/stores/posCart")
		return usePOSCartStore()
	}

	return {
		sessionId,
		shortfalls,
		queue,
		pendingPrompt,
		sessionTotals,
		flushing,
		lastFlushError,
		recordShortfall,
		confirmPrompt,
		dismissPrompt,
		flush,
		startNewSession,
		bindToDraft,
		bindToInvoice,
	}
})
