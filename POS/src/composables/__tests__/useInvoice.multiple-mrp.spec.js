import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

// Frappe injects `__` as a global translation helper at runtime.
beforeAll(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce(
			(acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)),
			text,
		)
})

// Stub the plumbing the composable pulls in at import time.
vi.mock("frappe-ui", () => ({
	createResource: () => ({ submit: vi.fn(), reload: vi.fn(), fetch: vi.fn() }),
}))
vi.mock("@/utils/offline", () => ({ isOffline: () => false }))
vi.mock("@/stores/orderLoss", () => ({
	usePOSOrderLossStore: () => ({
		recordShortfall: vi.fn(),
		startNewSession: vi.fn(() => Promise.resolve()),
	}),
}))
vi.mock("@/stores/serialNumber", () => ({
	useSerialNumberStore: () => ({ returnSerials: vi.fn() }),
}))
vi.mock("@/stores/stock", () => ({
	useStockStore: () => ({ server: new Map(), reserved: new Map() }),
}))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showError: vi.fn(),
		showSuccess: vi.fn(),
		showWarning: vi.fn(),
	}),
}))

// The POS Setting under test.
let multipleMrpAllowed = true
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({
		allowsMultipleMrp: () => multipleMrpAllowed,
		shouldEnforceStockValidation: () => false,
	}),
}))

import { useInvoice } from "../useInvoice"

const ITEM = {
	item_code: "Q17910KVH760",
	item_name: "MIRROR ASSY",
	stock_uom: "Nos",
	uom: "Nos",
	rate: 400,
	price_list_rate: 400,
}

describe("cart lines when one item carries several MRPs", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		multipleMrpAllowed = true
	})

	it("bills the same item at two MRPs as two lines", () => {
		const { invoiceItems, addItem, subtotal } = useInvoice()

		addItem(ITEM, 2, { rate: 500 })
		addItem(ITEM, 3, { rate: 400 })

		expect(invoiceItems.value).toHaveLength(2)
		expect(invoiceItems.value.map((i) => i.rate)).toEqual([500, 400])
		expect(invoiceItems.value.map((i) => i.price_list_rate)).toEqual([500, 400])
		expect(invoiceItems.value.map((i) => i.quantity)).toEqual([2, 3])
		// 2 x 500 + 3 x 400
		expect(subtotal.value).toBe(2200)
	})

	it("still adds to the existing line when the MRP is the same", () => {
		const { invoiceItems, addItem } = useInvoice()

		addItem(ITEM, 2, { rate: 500 })
		addItem(ITEM, 1, { rate: 500 })

		expect(invoiceItems.value).toHaveLength(1)
		expect(invoiceItems.value[0].quantity).toBe(3)
	})

	it("keeps lines apart on request, even at the same MRP", () => {
		const { invoiceItems, addItem } = useInvoice()

		addItem(ITEM, 2, { rate: 500 })
		addItem(ITEM, 1, { rate: 500, forceNewLine: true })

		expect(invoiceItems.value).toHaveLength(2)
		expect(invoiceItems.value[0].line_id).not.toBe(
			invoiceItems.value[1].line_id,
		)
	})

	it("merges by item as before when the setting is off", () => {
		multipleMrpAllowed = false
		const { invoiceItems, addItem } = useInvoice()

		addItem(ITEM, 2, { rate: 500 })
		addItem(ITEM, 3, { rate: 400 })

		expect(invoiceItems.value).toHaveLength(1)
		expect(invoiceItems.value[0].quantity).toBe(5)
	})

	it("removes only the line asked for, leaving the item's other MRP", () => {
		const { invoiceItems, addItem, removeItem, subtotal } = useInvoice()

		addItem(ITEM, 2, { rate: 500 })
		addItem(ITEM, 3, { rate: 400 })
		removeItem(invoiceItems.value[0].line_id)

		expect(invoiceItems.value).toHaveLength(1)
		expect(invoiceItems.value[0].rate).toBe(400)
		expect(subtotal.value).toBe(1200)
	})

	it("changes the quantity of one MRP line without touching the other", () => {
		const { invoiceItems, addItem, updateItemQuantity, subtotal } = useInvoice()

		addItem(ITEM, 2, { rate: 500 })
		addItem(ITEM, 3, { rate: 400 })
		updateItemQuantity(invoiceItems.value[1].line_id, 1)

		expect(invoiceItems.value.map((i) => i.quantity)).toEqual([2, 1])
		// 2 x 500 + 1 x 400
		expect(subtotal.value).toBe(1400)
	})

	it("still answers to an item code, for callers that have no line id", () => {
		const { invoiceItems, addItem, updateItemQuantity } = useInvoice()

		addItem(ITEM, 2, { rate: 500 })
		addItem(ITEM, 3, { rate: 400 })
		// Lands on the first line for the item - the pre-existing behaviour.
		updateItemQuantity(ITEM.item_code, 7)

		expect(invoiceItems.value.map((i) => i.quantity)).toEqual([7, 3])
	})

	it("gives a resumed draft's lines ids of their own", () => {
		const { invoiceItems, rebuildIncrementalCache, removeItem } = useInvoice()

		// Shape a held draft arrives in: no line ids, two rates for one item.
		invoiceItems.value = [
			{ ...ITEM, quantity: 2, rate: 500, price_list_rate: 500 },
			{ ...ITEM, quantity: 3, rate: 400, price_list_rate: 400 },
		]
		rebuildIncrementalCache()

		const ids = invoiceItems.value.map((i) => i.line_id)
		expect(ids.every(Boolean)).toBe(true)
		expect(new Set(ids).size).toBe(2)

		removeItem(ids[1])
		expect(invoiceItems.value).toHaveLength(1)
		expect(invoiceItems.value[0].rate).toBe(500)
	})
})
