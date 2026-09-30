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

vi.mock("frappe-ui", () => ({
	createResource: () => ({
		fetch: vi.fn(),
		reload: vi.fn(),
		submit: vi.fn(),
		data: null,
		loading: false,
	}),
}))
vi.mock("@/utils/offline", () => ({ isOffline: () => false }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showError: vi.fn(),
		showWarning: vi.fn(),
		showSuccess: vi.fn(),
	}),
}))
// Stock validation is off in these tests: the point here is line identity.
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({ shouldEnforceStockValidation: () => false }),
}))
vi.mock("@/stores/stock", () => ({
	useStockStore: () => ({ server: new Map(), reserved: new Map() }),
}))

const { useInvoice } = await import("@/composables/useInvoice")

/**
 * One item, two batches, a different MRP on each - the Auto Rider shape.
 * Batch "1" sells at 0.80, batch "1.15" at 1.15.
 */
const BATCH_A = {
	item_code: "30101236",
	item_name: "Test Item",
	uom: "Nos",
	stock_uom: "Nos",
	batch_no: "1-30101236",
	has_batch_no: 1,
	rate: 0.8,
	price_list_rate: 0.8,
	is_stock_item: 1,
}
const BATCH_B = {
	...BATCH_A,
	batch_no: "1.15-30101236",
	rate: 1.15,
	price_list_rate: 1.15,
}

describe("cart lines are identified by batch", () => {
	let inv

	beforeEach(() => {
		setActivePinia(createPinia())
		inv = useInvoice()
		inv.invoiceItems.value = []
	})

	it("keeps each batch on its own line at its own rate", () => {
		inv.addItem(BATCH_A, 5)
		inv.addItem(BATCH_B, 10)

		expect(inv.invoiceItems.value).toHaveLength(2)
		const [a, b] = inv.invoiceItems.value
		expect(a.batch_no).toBe("1-30101236")
		expect(a.quantity).toBe(5)
		expect(a.rate).toBe(0.8)
		expect(b.batch_no).toBe("1.15-30101236")
		expect(b.quantity).toBe(10)
		expect(b.rate).toBe(1.15)
	})

	it("tops up the same batch instead of opening a second line", () => {
		inv.addItem(BATCH_A, 5)
		inv.addItem(BATCH_A, 3)

		expect(inv.invoiceItems.value).toHaveLength(1)
		expect(inv.invoiceItems.value[0].quantity).toBe(8)
	})

	it("steps the quantity of the batch that was clicked", () => {
		inv.addItem(BATCH_A, 5)
		inv.addItem(BATCH_B, 10)

		inv.updateItemQuantity("30101236", 7, "Nos", "1.15-30101236")

		const byBatch = Object.fromEntries(
			inv.invoiceItems.value.map((i) => [i.batch_no, i.quantity]),
		)
		expect(byBatch["1-30101236"]).toBe(5)
		expect(byBatch["1.15-30101236"]).toBe(7)
	})

	it("removes only the batch that was removed", () => {
		inv.addItem(BATCH_A, 5)
		inv.addItem(BATCH_B, 10)

		inv.removeItem("30101236", "Nos", "1-30101236")

		expect(inv.invoiceItems.value).toHaveLength(1)
		expect(inv.invoiceItems.value[0].batch_no).toBe("1.15-30101236")
		expect(inv.invoiceItems.value[0].quantity).toBe(10)
	})

	it("still merges non-batch items by item and uom", () => {
		const plain = {
			item_code: "PLAIN",
			item_name: "Plain",
			uom: "Nos",
			stock_uom: "Nos",
			rate: 10,
			price_list_rate: 10,
			is_stock_item: 1,
		}
		inv.addItem(plain, 2)
		inv.addItem(plain, 3)

		expect(inv.invoiceItems.value).toHaveLength(1)
		expect(inv.invoiceItems.value[0].quantity).toBe(5)
	})
})
