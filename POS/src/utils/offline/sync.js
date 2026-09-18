import { call } from "@/utils/apiWrapper"
import { db, getSetting, setSetting } from "./db"
import { offlineState } from "./offlineState"

// Ping server to check connectivity
export const pingServer = async () => {
	if (typeof window === "undefined") return true

	try {
		// Quick ping to check if server is reachable
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), 3000) // 3 second timeout

		const response = await fetch("/api/method/pos_next.api.ping", {
			method: "GET",
			signal: controller.signal,
		})

		clearTimeout(timeoutId)
		const isOnline = response.ok
		// Update centralized state (handles window sync automatically)
		offlineState.setServerOnline(isOnline)
		return isOnline
	} catch (error) {
		// Server unreachable
		offlineState.setServerOnline(false)
		return false
	}
}

// Check if offline - uses centralized state manager
export const isOffline = () => {
	if (typeof window === "undefined") return false
	return offlineState.isOffline
}

// NOTE: Periodic server ping is now handled by the offline worker
// This prevents duplicate pings and centralizes the logic

// Save invoice to offline queue
export const saveOfflineInvoice = async (invoiceData) => {
	try {
		// Validate invoice has items
		if (!invoiceData.items || invoiceData.items.length === 0) {
			throw new Error("Cannot save empty invoice")
		}

		// Clean data (remove reactive properties)
		const cleanData = JSON.parse(JSON.stringify(invoiceData))

		// Add to queue
		await db.invoice_queue.add({
			data: cleanData,
			timestamp: Date.now(),
			synced: false,
			retry_count: 0,
		})

		// Update local stock
		await updateLocalStock(cleanData.items)

		console.log("Invoice saved to offline queue")
		return true
	} catch (error) {
		console.error("Error saving offline invoice:", error)
		throw error
	}
}

// Get pending offline invoices
export const getOfflineInvoices = async () => {
	try {
		// Use filter instead of where/equals for boolean values
		const invoices = await db.invoice_queue
			.filter((invoice) => invoice.synced === false)
			.toArray()
		return invoices
	} catch (error) {
		console.error("Error getting offline invoices:", error)
		return []
	}
}

// Get offline invoice count
export const getOfflineInvoiceCount = async () => {
	try {
		// Use filter instead of where/equals for boolean values
		const count = await db.invoice_queue
			.filter((invoice) => invoice.synced === false)
			.count()
		return count
	} catch (error) {
		console.error("Error getting offline invoice count:", error)
		return 0
	}
}

// Sync offline invoices to server
export const syncOfflineInvoices = async () => {
	if (isOffline()) {
		console.log("Cannot sync while offline")
		return { success: 0, failed: 0 }
	}

	const pendingInvoices = await getOfflineInvoices()
	if (pendingInvoices.length === 0) {
		return { success: 0, failed: 0 }
	}

	let successCount = 0
	let failedCount = 0
	const errors = []
	// (session, invoice) pairs to settle once the loss rows are up as well.
	const syncedSessions = []

	for (const invoice of pendingInvoices) {
		try {
			// Transform items: map 'quantity' to 'qty' for ERPNext compatibility
			// Offline storage uses 'quantity' (cart format) but server expects 'qty'
			const invoiceData = { ...invoice.data }

			// Dropped on purpose: this sale is already paid for and may be days old,
			// so a stale-draft refusal would strand the money in the queue for good.
			delete invoiceData.modified

			if (invoiceData.items && Array.isArray(invoiceData.items)) {
				// `pricing_rules` is an array on a cart line but a Small Text field on
				// Sales Invoice Item, so leaving it in place fails the whole submit
				// with "Value for Pricing Rules cannot be a list". New queue entries
				// are built by buildInvoicePayload and never carry it; this lifts it
				// out of anything queued before that, which would otherwise keep
				// failing forever.
				const rulesPerItem = invoiceData.items.map((item) =>
					Array.isArray(item.pricing_rules) ? item.pricing_rules.filter(Boolean) : [],
				)

				if (rulesPerItem.some((rules) => rules.length > 0)) {
					invoiceData.applied_pricing_rules =
						invoiceData.applied_pricing_rules || rulesPerItem
				}

				invoiceData.items = invoiceData.items.map(({ pricing_rules, ...item }) => ({
					...item,
					qty: item.quantity || item.qty || 1,
				}))
			}

			// The session this cart recorded its lost demand under. Sent so the
			// server can settle those rows against the sale, and remembered here
			// in case the loss rows themselves have not been flushed yet.
			const orderLossSession = invoiceData.order_loss_session || null
			delete invoiceData.order_loss_session

			// Submit invoice to server
			// The API expects 'data' parameter with nested 'invoice' and 'data' keys
			const response = await call("pos_next.api.invoices.submit_invoice", {
				data: JSON.stringify({
					invoice: invoiceData,
					data: orderLossSession
						? { order_loss_session: orderLossSession }
						: {},
				}),
			})

			if (response.message || response.name) {
				// Mark as synced
				await db.invoice_queue.update(invoice.id, { synced: true })

				if (orderLossSession) {
					syncedSessions.push({
						session: orderLossSession,
						invoice: response.name || response.message,
					})
				}

				successCount++
				console.log(
					`Invoice ${invoice.id} synced successfully as ${response.name || response.message}`,
				)
			}
		} catch (error) {
			console.error(`Error syncing invoice ${invoice.id}:`, error)

			// Store error details
			errors.push({
				invoiceId: invoice.id,
				customer: invoice.data.customer || "Walk-in Customer",
				error: error,
			})

			// Increment retry count
			await db.invoice_queue.update(invoice.id, {
				retry_count: (invoice.retry_count || 0) + 1,
			})

			failedCount++

			// If retry count exceeds threshold, mark as failed
			if ((invoice.retry_count || 0) >= 3) {
				await db.invoice_queue.update(invoice.id, {
					sync_failed: true,
					error: error.message,
				})
			}
		}
	}

	// Clean up synced invoices older than 7 days
	const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
	await db.invoice_queue
		.filter((item) => item.synced === true && item.timestamp < weekAgo)
		.delete()

	// The sale reached the server before the demand it fell short of, so the
	// reconcile that ran on submit found nothing to settle. Push the loss rows
	// up and run it again - it is idempotent, so the repeat costs nothing.
	if (syncedSessions.length > 0) {
		await syncOfflineOrderLosses()

		for (const { session, invoice } of syncedSessions) {
			try {
				await call("pos_next.api.order_loss.reconcile_invoice", {
					sales_invoice: invoice,
					cart_session_id: session,
				})
			} catch (error) {
				console.warn("Could not settle lost demand for", invoice, error)
			}
		}
	}

	return { success: successCount, failed: failedCount, errors }
}

// Hold lost demand on the device until the connection is back.
//
// Keyed on the idempotency key, so a shortfall that is recorded again before
// the queue drains overwrites its own row rather than adding a second one -
// the same merge the server does.
export const saveOfflineOrderLosses = async (
	losses,
	{ pos_profile, cart_session_id, pos_opening_shift, customer },
) => {
	if (!losses || losses.length === 0) return true

	try {
		const now = Date.now()

		const rows = losses.map((loss) => ({
			...JSON.parse(JSON.stringify(loss)),
			idempotency_key: [
				cart_session_id,
				loss.item_code,
				loss.uom || "",
				loss.warehouse || "",
				loss.batch_no || "",
			].join("::"),
			pos_profile,
			cart_session_id,
			pos_opening_shift: pos_opening_shift || null,
			customer: customer || null,
			timestamp: now,
			synced: false,
			retry_count: 0,
		}))

		// Keep the real time of the shortfall: this may not reach the server for
		// days, and "when the customer asked" is the whole point of the record.
		for (const row of rows) {
			if (!row.posting_date) {
				const at = new Date()
				row.posting_date = at.toISOString().slice(0, 10)
				row.posting_time = at.toTimeString().slice(0, 8)
			}
		}

		await db.order_loss_queue.bulkPut(rows)
		return true
	} catch (error) {
		console.error("Error queueing lost demand:", error)
		return false
	}
}

export const getOfflineOrderLossCount = async () => {
	try {
		return await db.order_loss_queue.filter((row) => row.synced === false).count()
	} catch (error) {
		console.error("Error counting queued lost demand:", error)
		return 0
	}
}

// Push queued lost demand up, one request per cart.
export const syncOfflineOrderLosses = async () => {
	if (isOffline()) return { success: 0, failed: 0 }

	let rows = []
	try {
		rows = await db.order_loss_queue.filter((row) => row.synced === false).toArray()
	} catch (error) {
		console.error("Error reading queued lost demand:", error)
		return { success: 0, failed: 0 }
	}

	if (rows.length === 0) return { success: 0, failed: 0 }

	const carts = new Map()
	for (const row of rows) {
		const key = `${row.pos_profile}::${row.cart_session_id}`
		if (!carts.has(key)) carts.set(key, [])
		carts.get(key).push(row)
	}

	let success = 0
	let failed = 0

	for (const cart of carts.values()) {
		const { pos_profile, cart_session_id, pos_opening_shift, customer } = cart[0]

		try {
			await call("pos_next.api.order_loss.record_losses", {
				losses: JSON.stringify(cart),
				pos_profile,
				cart_session_id,
				pos_opening_shift: pos_opening_shift || null,
				customer: customer || null,
			})

			for (const row of cart) {
				await db.order_loss_queue.update(row.idempotency_key, { synced: true })
			}
			success += cart.length
		} catch (error) {
			console.error("Error syncing lost demand:", error)
			failed += cart.length

			for (const row of cart) {
				await db.order_loss_queue.update(row.idempotency_key, {
					retry_count: (row.retry_count || 0) + 1,
					sync_failed: (row.retry_count || 0) >= 3,
					error: error.message,
				})
			}
		}
	}

	const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
	await db.order_loss_queue
		.filter((row) => row.synced === true && row.timestamp < weekAgo)
		.delete()

	return { success, failed }
}

// Delete offline invoice
export const deleteOfflineInvoice = async (id) => {
	try {
		await db.invoice_queue.delete(id)
		return true
	} catch (error) {
		console.error("Error deleting offline invoice:", error)
		return false
	}
}

// Update local stock after invoice
export const updateLocalStock = async (items) => {
	try {
		for (const item of items) {
			const stockKey = `${item.item_code}_${item.warehouse}`
			const currentStock = await db.stock.get({
				item_code: item.item_code,
				warehouse: item.warehouse,
			})

			const qty = item.quantity || item.qty || 0
			const newQty = (currentStock?.qty || 0) - qty

			await db.stock.put({
				item_code: item.item_code,
				warehouse: item.warehouse,
				qty: newQty,
				updated_at: Date.now(),
			})
		}
	} catch (error) {
		console.error("Error updating local stock:", error)
	}
}

// Get local stock
export const getLocalStock = async (itemCode, warehouse) => {
	try {
		const stock = await db.stock.get({
			item_code: itemCode,
			warehouse: warehouse,
		})
		return stock?.qty || 0
	} catch (error) {
		console.error("Error getting local stock:", error)
		return 0
	}
}

// Save offline payment
export const saveOfflinePayment = async (paymentData) => {
	try {
		const cleanData = JSON.parse(JSON.stringify(paymentData))

		await db.payment_queue.add({
			data: cleanData,
			timestamp: Date.now(),
			synced: false,
			retry_count: 0,
		})

		console.log("Payment saved to offline queue")
		return true
	} catch (error) {
		console.error("Error saving offline payment:", error)
		throw error
	}
}

// Auto-sync when coming back online
if (typeof window !== "undefined") {
	// Listen to centralized offline state changes for auto-sync
	offlineState.subscribe(async (state) => {
		// Only sync when transitioning from offline to online
		if (!state.isOffline && state.source !== 'manual') {
			console.log("Back online, syncing pending invoices...")
			const result = await syncOfflineInvoices()

			// Dispatch event to notify components to update their pending count
			window.dispatchEvent(
				new CustomEvent("offlineInvoicesSynced", {
					detail: result,
				}),
			)

			if (result.success > 0) {
				console.log(`Successfully synced ${result.success} invoices`)
				if (window.frappe?.msgprint) {
					window.frappe.msgprint({
						title: __("Sync Complete"),
						message: `Successfully synced ${result.success} offline invoices`,
						indicator: "green",
					})
				}
			}
		}
	})
}
