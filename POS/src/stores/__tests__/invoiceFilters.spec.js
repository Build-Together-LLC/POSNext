import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { useInvoiceFiltersStore } from "../invoiceFilters"

const mockCall = vi.fn()
vi.mock("@/utils/apiWrapper", () => ({
	call: (...args) => mockCall(...args),
}))

describe("Invoice Filters Store", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		mockCall.mockReset()
		localStorage.clear()
	})

	it("initializes with current month as default date filter", () => {
		const store = useInvoiceFiltersStore()
		const today = new Date()
		const year = today.getFullYear()
		const month = String(today.getMonth() + 1).padStart(2, "0")

		expect(store.dateFrom).toBe(`${year}-${month}-01`)
		expect(store.dateTo).toBeTruthy()
		expect(store.hasActiveFilters).toBe(true)
	})

	it("supports quick date filter setToday", () => {
		const store = useInvoiceFiltersStore()
		store.setToday()
		const today = new Date()
		const year = today.getFullYear()
		const month = String(today.getMonth() + 1).padStart(2, "0")
		const day = String(today.getDate()).padStart(2, "0")
		const formatted = `${year}-${month}-${day}`

		expect(store.dateFrom).toBe(formatted)
		expect(store.dateTo).toBe(formatted)
	})

	it("sets customer and customerLabel", () => {
		const store = useInvoiceFiltersStore()
		store.setCustomer("CUST-0001", "John Doe")

		expect(store.customer).toBe("CUST-0001")
		expect(store.customerLabel).toBe("John Doe")

		const customerSummary = store.filterSummary.find((s) => s.type === "customer")
		expect(customerSummary).toBeTruthy()
		expect(customerSummary.label).toBe("John Doe")
		expect(customerSummary.value).toBe("CUST-0001")
	})

	it("sets product and productLabel", () => {
		const store = useInvoiceFiltersStore()
		store.setProduct("ITEM-001", "Acme Widget")

		expect(store.product).toBe("ITEM-001")
		expect(store.productLabel).toBe("Acme Widget")

		const productSummary = store.filterSummary.find((s) => s.type === "product")
		expect(productSummary).toBeTruthy()
		expect(productSummary.label).toBe("Acme Widget")
		expect(productSummary.value).toBe("ITEM-001")
	})

	it("sets financial year from API if available", async () => {
		mockCall.mockResolvedValueOnce({
			year_start_date: "2026-04-01",
			year_end_date: "2027-03-31",
		})

		const store = useInvoiceFiltersStore()
		await store.setFinancialYear("Test Company")

		expect(mockCall).toHaveBeenCalledWith(
			"pos_next.api.invoices.get_fiscal_year_dates",
			{ company: "Test Company" },
		)
		expect(store.dateFrom).toBe("2026-04-01")
		expect(store.dateTo).toBe("2027-03-31")
	})

	it("falls back to calculation when financial year API fails", async () => {
		mockCall.mockRejectedValueOnce(new Error("Network Error"))

		const store = useInvoiceFiltersStore()
		await store.setFinancialYear("Test Company")

		expect(store.dateFrom).toMatch(/^\d{4}-04-01$/)
		expect(store.dateTo).toMatch(/^\d{4}-03-31$/)
	})

	it("clears all filters and resets to default month", () => {
		const store = useInvoiceFiltersStore()
		store.setCustomer("CUST-0001", "John")
		store.setProduct("ITEM-001", "Widget")
		store.status = "Paid"
		store.searchTerm = "INV-001"

		store.clearAllFilters()

		expect(store.customer).toBe("")
		expect(store.customerLabel).toBe("")
		expect(store.product).toBe("")
		expect(store.productLabel).toBe("")
		expect(store.status).toBe("")
		expect(store.searchTerm).toBe("")

		// Date is reset to this month
		const today = new Date()
		const year = today.getFullYear()
		const month = String(today.getMonth() + 1).padStart(2, "0")
		expect(store.dateFrom).toBe(`${year}-${month}-01`)
	})

	it("saves and loads filter presets", () => {
		const store = useInvoiceFiltersStore()
		store.setCustomer("CUST-0001", "John Doe")
		store.setProduct("ITEM-001", "Widget")
		store.status = "Paid"

		store.saveCurrentFilters("My Preset")
		expect(store.savedFilters.length).toBe(1)

		store.clearAllFilters(false)
		expect(store.customer).toBe("")

		store.loadFilterPreset("My Preset")
		expect(store.customer).toBe("CUST-0001")
		expect(store.customerLabel).toBe("John Doe")
		expect(store.product).toBe("ITEM-001")
		expect(store.productLabel).toBe("Widget")
		expect(store.status).toBe("Paid")
	})
})

