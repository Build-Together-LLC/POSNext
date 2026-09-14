import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const call = vi.fn(() => Promise.resolve({ enabled: true, rows: [], skipped: [] }))

vi.mock("@/utils/apiWrapper", () => ({ call: (...args) => call(...args) }))
vi.mock("@/utils/offline", () => ({ isOffline: () => false }))

// The store reaches the cart lazily (posCart imports it back), so the cart is
// stubbed rather than instantiated.
vi.mock("@/stores/posCart", () => ({
	usePOSCartStore: () => ({
		posProfile: "Main",
		posOpeningShift: "SHIFT-01",
		customer: { name: "CUST-001" },
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

	it("asks before recording anything", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)

		expect(store.pendingPrompt.demanded_qty).toBe(12)
		expect(store.shortfalls.size).toBe(0)
	})

	it("records what the cashier confirms", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)

		expect(store.shortfalls.size).toBe(1)
		expect(store.pendingPrompt).toBe(null)
		expect([...store.shortfalls.values()][0].demanded_qty).toBe(12)
	})

	it("records the corrected quantity, not the typed one", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 1000)
		store.confirmPrompt(10)

		expect([...store.shortfalls.values()][0].demanded_qty).toBe(10)
	})

	it("records nothing when the correction is within stock", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12, 5)
		store.confirmPrompt(4)

		expect(store.shortfalls.size).toBe(0)
	})

	it("records nothing when the cashier says it was not a loss", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.dismissPrompt()

		expect(store.shortfalls.size).toBe(0)
	})

	it("does not ask twice about an item already declined", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.dismissPrompt()

		shortfall(store, 12)

		expect(store.pendingPrompt).toBe(null)
		expect(store.shortfalls.size).toBe(0)
	})

	it("folds a repeated shortfall into the row, without asking again", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)

		shortfall(store, 3)

		expect(store.pendingPrompt).toBe(null)
		expect(store.shortfalls.size).toBe(1)
	})

	it("keeps the largest ask, so a repeat cannot shrink or inflate it", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)

		shortfall(store, 3)
		shortfall(store, 20)

		const entry = [...store.shortfalls.values()][0]
		expect(entry.demanded_qty).toBe(20)
	})

	it("queues a second item instead of losing it", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		shortfall(store, 8, 2, { ...ITEM, item_code: "GADGET", item_name: "Gadget" })

		expect(store.pendingPrompt.item_code).toBe("WIDGET")
		store.confirmPrompt(12)
		expect(store.pendingPrompt.item_code).toBe("GADGET")
	})

	it("ignores a quantity the till could have covered", () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 4, 5)

		expect(store.pendingPrompt).toBe(null)
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

	it("collapses a typing burst into one write", async () => {
		const store = usePOSOrderLossStore()
		shortfall(store, 12)
		store.confirmPrompt(12)
		shortfall(store, 100)
		shortfall(store, 1000)

		expect(call).not.toHaveBeenCalled()

		await vi.runAllTimersAsync()

		expect(call).toHaveBeenCalledTimes(1)
		const [method, payload] = call.mock.calls[0]
		expect(method).toBe("pos_next.api.order_loss.record_losses")
		expect(JSON.parse(payload.losses)).toHaveLength(1)
		expect(payload.pos_profile).toBe("Main")
		expect(payload.cart_session_id).toBe(store.sessionId)
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
		// The ended cart's losses were written before the rotation.
		expect(call).toHaveBeenCalledTimes(1)
	})

	it("shares one session with the invoice a held ticket is resumed from", () => {
		const store = usePOSOrderLossStore()
		store.bindToDraft("SINV-26-00042")

		expect(store.sessionId).toBe("ol-inv-SINV-26-00042")
	})
})
