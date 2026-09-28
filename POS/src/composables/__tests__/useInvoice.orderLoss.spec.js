import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

beforeAll(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce(
			(acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)),
			text,
		)
})

vi.mock("frappe-ui", () => ({
	createResource: () => ({ submit: vi.fn(), reload: vi.fn(), fetch: vi.fn() }),
}))
vi.mock("@/utils/offline", () => ({ isOffline: () => false }))
vi.mock("@/stores/serialNumber", () => ({
	useSerialNumberStore: () => ({ returnSerials: vi.fn() }),
}))

const stockServerMap = new Map()
const stockReservedMap = new Map()
vi.mock("@/stores/stock", () => ({
	useStockStore: () => ({
		server: stockServerMap,
		reserved: stockReservedMap,
	}),
}))

const showErrorMock = vi.fn()
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showError: showErrorMock,
		showSuccess: vi.fn(),
		showWarning: vi.fn(),
	}),
}))

let recordOrderLoss = true
let enforceStock = true
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({
		allowsMultipleMrp: () => true,
		shouldRecordOrderLoss: () => recordOrderLoss,
		shouldEnforceStockValidation: () => enforceStock,
	}),
}))

const recordedShortfalls = []
const removedShortfalls = []
vi.mock("@/stores/orderLoss", () => ({
	usePOSOrderLossStore: () => ({
		recordShortfall: (entry) => recordedShortfalls.push(entry),
		removeShortfall: (item) => removedShortfalls.push(item),
		getShortfall: (item) => recordedShortfalls.find(s => s.item?.item_code === item?.item_code) || null,
		shortfalls: new Map(),
	}),
}))

import { useInvoice } from "../useInvoice"

const ITEM = {
	item_code: "DN01",
	item_name: "A BAG HOOK 100CC BLK",
	stock_uom: "Nos",
	uom: "Nos",
	rate: 100,
	price_list_rate: 100,
	is_stock_item: true,
	actual_qty: 6,
}

describe("useInvoice quantity update with order loss tracking", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		stockServerMap.clear()
		stockReservedMap.clear()
		recordedShortfalls.length = 0
		removedShortfalls.length = 0
		showErrorMock.mockClear()
		recordOrderLoss = true
		enforceStock = true

		stockServerMap.set(ITEM.item_code, { qty: 6 })
		stockReservedMap.set(ITEM.item_code, 6)
	})

	it("clamps invoiced quantity to available stock, sets ordered_qty to 50, and records shortfall without toast when loss tracking is ON", () => {
		const { invoiceItems, addItem, updateItemQuantity, subtotal } = useInvoice()
		addItem(ITEM, 6)

		expect(invoiceItems.value[0].quantity).toBe(6)

		// Cashier types 50
		updateItemQuantity(invoiceItems.value[0].line_id, 50)

		expect(invoiceItems.value[0].quantity).toBe(6)
		expect(invoiceItems.value[0].ordered_qty).toBe(50)
		expect(subtotal.value).toBe(600) // 6 * 100
		expect(showErrorMock).not.toHaveBeenCalled()
		expect(recordedShortfalls.length).toBe(1)
		expect(recordedShortfalls[0].requestedQty).toBe(50)
		expect(recordedShortfalls[0].availableQty).toBe(6)
	})

	it("clears ordered_qty and removes shortfall when quantity is set within stock", () => {
		const { invoiceItems, addItem, updateItemQuantity, subtotal } = useInvoice()
		addItem(ITEM, 6)

		updateItemQuantity(invoiceItems.value[0].line_id, 50)
		expect(invoiceItems.value[0].ordered_qty).toBe(50)

		// Now cashier types 4
		updateItemQuantity(invoiceItems.value[0].line_id, 4)
		expect(invoiceItems.value[0].quantity).toBe(4)
		expect(invoiceItems.value[0].ordered_qty).toBeNull()
		expect(subtotal.value).toBe(400)
		expect(removedShortfalls.length).toBe(1)
	})

	it("shows error toast and clamps without setting ordered_qty when order loss tracking is OFF", () => {
		recordOrderLoss = false
		const { invoiceItems, addItem, updateItemQuantity } = useInvoice()
		addItem(ITEM, 6)

		updateItemQuantity(invoiceItems.value[0].line_id, 50)

		expect(showErrorMock).toHaveBeenCalledWith(
			expect.stringContaining('Only 6 available in stock')
		)
		expect(invoiceItems.value[0].quantity).toBe(6)
		expect(invoiceItems.value[0].ordered_qty).toBeNull()
		expect(recordedShortfalls.length).toBe(0)
	})

	it("always records loss and clamps billed quantity to stock (e.g. 6 available, 23 ordered -> 17 loss) when order loss is ON even if negative stock is allowed", () => {
		enforceStock = false // allow_negative_stock is on!
		recordOrderLoss = true // but track_order_loss checkmark is on!

		const { invoiceItems, addItem, updateItemQuantity, subtotal } = useInvoice()
		addItem(ITEM, 6)

		updateItemQuantity(invoiceItems.value[0].line_id, 23)

		expect(invoiceItems.value[0].quantity).toBe(6)
		expect(invoiceItems.value[0].ordered_qty).toBe(23)
		expect(subtotal.value).toBe(600)
		expect(showErrorMock).not.toHaveBeenCalled()
		expect(recordedShortfalls.length).toBe(1)
		expect(recordedShortfalls[0].requestedQty).toBe(23)
		expect(recordedShortfalls[0].availableQty).toBe(6)
	})
})
