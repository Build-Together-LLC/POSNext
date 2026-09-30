import { describe, expect, it, vi } from "vitest"

vi.mock("frappe-ui", () => ({ createResource: () => ({ submit: vi.fn(), auto: false }) }))
vi.mock("@/utils/offline", () => ({ isOffline: () => false }))
vi.mock("@/stores/serialNumber", () => ({ useSerialNumberStore: () => ({ returnSerials: vi.fn() }) }))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => ({ allowMultipleBatchesPerItem: false }),
}))
vi.mock("@/stores/stock", () => ({ useStockStore: () => ({}) }))
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ show: vi.fn() }) }))

const { useInvoice } = await import("../useInvoice.js")

const GST_HEADS = [
	{ account_head: "Output Tax SGST", charge_type: "On Net Total", rate: 0 },
	{ account_head: "Output Tax CGST", charge_type: "On Net Total", rate: 0 },
]

function cart({ inclusive = true, headRates = GST_HEADS } = {}) {
	const invoice = useInvoice()
	invoice.taxRules.value = headRates
	invoice.taxInclusive.value = inclusive
	return invoice
}

describe("cart totals with item-level tax rates", () => {
	it("shows the taxable subtotal and the embedded tax for inclusive prices", () => {
		const invoice = cart()
		invoice.addItem(
			{ item_code: "56DK31Y9", price_list_rate: 492, item_tax_rate_total: 18, uom: "PCS" },
			1,
		)
		invoice.addItem(
			{ item_code: "DK141028", price_list_rate: 7.2, item_tax_rate_total: 18, uom: "PCS" },
			1,
		)
		for (const line of invoice.invoiceItems.value) {
			line.discount_percentage = 10
			invoice.recalculateItem(line)
		}
		invoice.rebuildIncrementalCache()

		expect(invoice.subtotal.value).toBeCloseTo(380.75, 2)
		expect(invoice.totalTax.value).toBeCloseTo(68.53, 2)
		expect(invoice.grandTotal.value).toBeCloseTo(449.28, 2)
		expect(invoice.roundedTotal.value).toBe(449)
		expect(invoice.roundOff.value).toBeCloseTo(-0.28, 2)
		expect(invoice.totalDiscount.value).toBeCloseTo(49.92, 2)
	})

	it("adds tax on top when prices are exclusive", () => {
		const invoice = cart({ inclusive: false })
		invoice.addItem(
			{ item_code: "TEST-100", price_list_rate: 100, item_tax_rate_total: 18, uom: "PCS" },
			2,
		)

		expect(invoice.subtotal.value).toBeCloseTo(200, 2)
		expect(invoice.totalTax.value).toBeCloseTo(36, 2)
		expect(invoice.grandTotal.value).toBeCloseTo(236, 2)
	})

	it("falls back to the account-head rate when the item carries none", () => {
		const invoice = cart({
			inclusive: false,
			headRates: [{ account_head: "VAT", charge_type: "On Net Total", rate: 5 }],
		})
		invoice.addItem({ item_code: "NO-TEMPLATE", price_list_rate: 100, uom: "PCS" }, 1)

		expect(invoice.subtotal.value).toBeCloseTo(100, 2)
		expect(invoice.totalTax.value).toBeCloseTo(5, 2)
		expect(invoice.grandTotal.value).toBeCloseTo(105, 2)
	})

	it("taxes each line at its own rate in a mixed cart", () => {
		const invoice = cart()
		invoice.addItem(
			{ item_code: "GST18", price_list_rate: 118, item_tax_rate_total: 18, uom: "PCS" },
			1,
		)
		invoice.addItem(
			{ item_code: "GST28", price_list_rate: 128, item_tax_rate_total: 28, uom: "PCS" },
			1,
		)

		expect(invoice.subtotal.value).toBeCloseTo(200, 2)
		expect(invoice.totalTax.value).toBeCloseTo(46, 2)
		expect(invoice.grandTotal.value).toBeCloseTo(246, 2)
	})
})
