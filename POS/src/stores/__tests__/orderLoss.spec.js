import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const call = vi.fn(() =>
	Promise.resolve({ enabled: true, rows: [], skipped: [] }),
)

vi.mock("@/utils/apiWrapper", () => ({ call: (...args) => call(...args) }))
vi.mock("@/utils/offline", () => ({ isOffline: () => false }))

// The store reaches the cart lazily (posCart imports it back), so the cart is
// stubbed rather than instantiated.
vi.mock("@/stores/posCart", () => ({
	usePOSCartStore: () => ({
		posProfile: "Main",
		posOpeningShift: "SHIFT-01",
		customer: { name: "CUST-001" },
		invoiceItems: [{ item_code: "WIDGET", uom: "Nos", quantity: 5 }],
	}),
}))

let recordingEnabled = true
let ceiling = 0

vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({
		shouldRecordOrderLoss: () => recordingEnabled,
		orderLossMaxDemandQty: () => ceiling,
	}),
}))

import { usePOSOrderLossStore } from "../orderLoss"

const ITEM = {
	item_code: "WIDGET",
	item_name: "Widget",
	uom: "Nos",
	warehouse: "Stores - T",
	rate: 50,
}

function shortfall(store, requestedQty, availableQty = 5, item = ITEM) {
	store.recordShortfall({
		item,
		requestedQty,
		availableQty,
		source: "Cart Add",
	})
}

describe("loss of order ledger", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		localStorage.clear()
		call.mockClear()
		recordingEnabled = true
		ceiling = 0
		vi.useFakeTimers()
	})

	// Each test leaves its debounced flush pending; without this they all fire
	// inside whichever later test advances the clock.
	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it("automatically records shortfall without asking", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 20, 10)

		expect(store.shortfalls.size).toBe(1)
		expect([...store.shortfalls.values()][0].demanded_qty).toBe(20)
		expect([...store.shortfalls.values()][0].available_qty).toBe(10)
	})

	it("updates existing record when quantity is changed", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 20, 10)
		expect([...store.shortfalls.values()][0].demanded_qty).toBe(20)

		shortfall(store, 30, 10)
		expect(store.shortfalls.size).toBe(1)
		expect([...store.shortfalls.values()][0].demanded_qty).toBe(30)
	})

	it("records the latest ask, not the largest", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 30, 10)
		expect([...store.shortfalls.values()][0].demanded_qty).toBe(30)

		shortfall(store, 15, 10)
		expect(store.shortfalls.size).toBe(1)
		expect([...store.shortfalls.values()][0].demanded_qty).toBe(15)
	})

	it("drops the entry when the ask is corrected back within stock", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 20, 10)
		expect(store.shortfalls.size).toBe(1)

		shortfall(store, 5, 10)
		expect(store.shortfalls.size).toBe(0)
	})

	it("records multiple short items in the ledger", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12, 5)
		shortfall(store, 8, 2, {
			...ITEM,
			item_code: "GADGET",
			item_name: "Gadget",
		})

		expect(store.shortfalls.size).toBe(2)
		expect(store.getShortfall(ITEM)?.demanded_qty).toBe(12)
		expect(
			store.getShortfall({ item_code: "GADGET" })?.demanded_qty,
		).toBe(8)
	})

	it("ignores a quantity the till could have covered", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 4, 5)

		expect(store.shortfalls.size).toBe(0)
	})

	it("ignores demand above the profile's mistype ceiling", () => {
		ceiling = 100
		const store = usePOSOrderLossStore()
		shortfall(store, 1000)

		expect(store.pendingPrompt).toBe(null)
	})

	it("does nothing at all when the feature is off", () => {
		recordingEnabled = false
		const store = usePOSOrderLossStore()
		shortfall(store, 12)

		expect(store.pendingPrompt).toBe(null)
		expect(store.shortfalls.size).toBe(0)
	})

	it("does not flush automatically while typing, only records when flushed on checkout or hold", async () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)
		shortfall(store, 100)
		shortfall(store, 1000)

		// Timers should not trigger background auto-flush while typing
		await vi.runAllTimersAsync()
		expect(call).not.toHaveBeenCalled()

		// Flushing explicitly on checkout / hold writes the latest ask to the server
		await store.flush({ force: true })
		expect(call).toHaveBeenCalledTimes(1)
		const [method, payload] = call.mock.calls[0]
		expect(method).toBe("pos_next.api.order_loss.record_losses")
		expect(JSON.parse(payload.losses)).toHaveLength(1)
		expect(payload.pos_profile).toBe("Main")
		expect(payload.cart_session_id).toBe(store.sessionId)
	})

	it("reports what the cart is holding as the sale, not zero", async () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 30, 5)
		store.confirmPrompt(30)

		await store.flush({ force: true })

		const [, payload] = call.mock.calls[0]
		const [sent] = JSON.parse(payload.losses)
		expect(sent.demanded_qty).toBe(30)
		// The 5 on the cart are being sold; only the rest is lost.
		expect(sent.sold_qty).toBe(5)
	})

	it("keeps the sale going when the server rejects the write", async () => {
		call.mockRejectedValueOnce(new Error("boom"))
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)

		await expect(store.flush({ force: true })).resolves.toBe(null)
		expect(store.lastFlushError).toBeInstanceOf(Error)
		expect(store.shortfalls.size).toBe(1)
	})

	it("starts a clean ledger for the next customer", async () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)
		const firstSession = store.sessionId

		await store.startNewSession()

		expect(store.sessionId).not.toBe(firstSession)
		expect(store.shortfalls.size).toBe(0)
		expect(call).not.toHaveBeenCalled()
	})

	it("shares one session with the invoice a held ticket is resumed from", () => {
		const store = usePOSOrderLossStore()
		store.bindToDraft("SINV-26-00042")

		expect(store.sessionId).toBe("ol-inv-SINV-26-00042")
	})

	it("carries the cart's rows onto the invoice it is held as", async () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)
		const cartSession = store.sessionId

		await store.bindToInvoice("SINV-26-00042")

		expect(store.sessionId).toBe("ol-inv-SINV-26-00042")

		const rebind = call.mock.calls.find(
			([method]) => method === "pos_next.api.order_loss.rebind_session",
		)
		expect(rebind[1]).toMatchObject({
			old_session: cartSession,
			new_session: "ol-inv-SINV-26-00042",
			pos_profile: "Main",
		})
	})

	it("does not re-send clean entries on subsequent flushes in the steady state", async () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)

		await store.flush({ force: true })
		expect(call).toHaveBeenCalledTimes(1)

		// Next normal flush with no changes should be a no-op
		await store.flush()
		expect(call).toHaveBeenCalledTimes(1)

		// Debounce timer expiring without changes should also not trigger another call
		await vi.runAllTimersAsync()
		expect(call).toHaveBeenCalledTimes(1)
	})

	it("re-flushes when an entry is updated with a new quantity", async () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)

		await store.flush({ force: true })
		expect(call).toHaveBeenCalledTimes(1)

		// Customer asks for 20 more
		shortfall(store, 32)
		store.confirmPrompt(32)

		await store.flush()
		expect(call).toHaveBeenCalledTimes(2)
		const [, payload] = call.mock.calls[1]
		const [sent] = JSON.parse(payload.losses)
		expect(sent.demanded_qty).toBe(32)
	})

	it("loads existing session losses when resuming a draft and updates the existing record", async () => {
		const store = usePOSOrderLossStore()
		call.mockImplementation((method) => {
			if (method === "pos_next.api.order_loss.get_order_losses") {
				return Promise.resolve([
					{
						item_code: "WIDGET",
						item_name: "Widget",
						uom: "Nos",
						warehouse: "Stores - T",
						demanded_qty: 20,
						available_qty: 10,
						sold_qty: 10,
						rate: 50,
						cart_session_id: "ol-inv-SINV-26-00042",
					},
				])
			}
			return Promise.resolve({ enabled: true, rows: [], skipped: [] })
		})

		await store.bindToDraft("SINV-26-00042")
		expect(store.sessionId).toBe("ol-inv-SINV-26-00042")
		expect(store.shortfalls.size).toBe(1)

		const existing = store.getShortfall(ITEM)
		expect(existing.demanded_qty).toBe(20)
		expect(existing.available_qty).toBe(10)

		// Updating quantity to 30 updates the existing shortfall entry
		shortfall(store, 30, 10)
		expect(store.shortfalls.size).toBe(1)
		expect(store.getShortfall(ITEM).demanded_qty).toBe(30)
	})

	it("prompts the cashier with a popup when item has 0 stock initially", () => {
		const store = usePOSOrderLossStore()
		expect(store.pendingPrompt).toBe(null)

		store.promptShortfall({
			item: ITEM,
			requestedQty: 1,
			availableQty: 0,
			source: "Item Tile",
		})

		expect(store.pendingPrompt).not.toBe(null)
		expect(store.pendingPrompt.item_code).toBe(ITEM.item_code)
		expect(store.pendingPrompt.demanded_qty).toBe(1)
		expect(store.pendingPrompt.available_qty).toBe(0)

		// Cashier changes demanded qty to 5, rate to 125 and confirms
		store.confirmPrompt(5, 125)

		expect(store.pendingPrompt).toBe(null)
		expect(store.shortfalls.size).toBe(1)
		expect(store.getShortfall(ITEM).demanded_qty).toBe(5)
		expect(store.getShortfall(ITEM).available_qty).toBe(0)
		expect(store.getShortfall(ITEM).rate).toBe(125)
	})

	it("clears prompt without recording when cashier dismisses prompt as not a loss", () => {
		const store = usePOSOrderLossStore()

		store.promptShortfall({
			item: ITEM,
			requestedQty: 1,
			availableQty: 0,
			source: "Item Tile",
		})

		expect(store.pendingPrompt).not.toBe(null)

		// Cashier clicks "Not a loss"
		store.dismissPrompt()

		expect(store.pendingPrompt).toBe(null)
		expect(store.shortfalls.size).toBe(0)
	})

	it("updates available_qty when passed to confirmPrompt", () => {
		const store = usePOSOrderLossStore()

		store.promptShortfall({
			item: ITEM,
			requestedQty: 1,
			availableQty: 0,
			source: "Item Tile",
		})

		// Available was 3 and reached 0 in cart, demanded 10, rate 150
		store.confirmPrompt(10, 150, 3)

		expect(store.pendingPrompt).toBe(null)
		expect(store.shortfalls.size).toBe(1)
		expect(store.getShortfall(ITEM).demanded_qty).toBe(10)
		expect(store.getShortfall(ITEM).available_qty).toBe(3)
		expect(store.getShortfall(ITEM).rate).toBe(150)
	})

	it("records 0-stock demand directly using unique session IDs for each recording so they do not overwrite each other", async () => {
		const store = usePOSOrderLossStore()
		call.mockClear()

		await store.recordDirectLoss({
			item: ITEM,
			demandedQty: 200,
			rate: 50,
			availableQty: 0,
		})

		expect(call).toHaveBeenCalledTimes(1)
		const firstCall = call.mock.calls[0]
		const firstSession = firstCall[1].cart_session_id
		const firstLosses = JSON.parse(firstCall[1].losses)
		expect(firstLosses[0].demanded_qty).toBe(200)

		await store.recordDirectLoss({
			item: ITEM,
			demandedQty: 300,
			rate: 50,
			availableQty: 0,
		})

		expect(call).toHaveBeenCalledTimes(2)
		const secondCall = call.mock.calls[1]
		const secondSession = secondCall[1].cart_session_id
		const secondLosses = JSON.parse(secondCall[1].losses)
		expect(secondLosses[0].demanded_qty).toBe(300)

		// Each direct recording gets its own unique session ID so backend treats them as distinct records
		expect(secondSession).not.toBe(firstSession)
		// Direct losses do not pollute the current cart shortfalls
		expect(store.shortfalls.size).toBe(0)
	})

	it("does not prompt again when shortfall for the item is already recorded in shortfalls map", () => {
		const store = usePOSOrderLossStore()
		store.recordShortfall({ item: ITEM, requestedQty: 10, availableQty: 2 })
		expect(store.shortfalls.size).toBe(1)

		store.promptShortfall({ item: ITEM, requestedQty: 10, availableQty: 2 })
		expect(store.pendingPrompt).toBe(null)
	})
})

