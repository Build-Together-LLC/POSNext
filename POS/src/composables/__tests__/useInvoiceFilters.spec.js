import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"

beforeAll(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce(
			(acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)),
			text,
		)
})

vi.mock("frappe-ui", () => ({
	createResource: () => ({ submit: vi.fn(), reload: vi.fn(), fetch: vi.fn() }),
	call: vi.fn(),
}))

import { useInvoiceFilters, DATE_PRESETS } from "../useInvoiceFilters"
import { useInvoiceFiltersStore } from "@/stores/invoiceFilters"

describe("useInvoiceFilters Composable", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
	})

	const mockInvoices = [
		{
			name: "ACC-SINV-2026-00001",
			customer: "CUST-0001",
			customer_name: "Alice Smith",
			posting_date: "2026-10-10",
			status: "Paid",
			grand_total: 150,
			items: [
				{ item_code: "ITEM-A", item_name: "Apple Watch", qty: 1, rate: 150 },
			],
		},
		{
			name: "ACC-SINV-2026-00002",
			customer: "CUST-0002",
			customer_name: "Bob Jones",
			posting_date: "2026-10-12",
			status: "Unpaid",
			grand_total: 300,
			items: [
				{ item_code: "ITEM-B", item_name: "Bluetooth Speaker", qty: 2, rate: 150 },
			],
		},
		{
			name: "ACC-SINV-2026-00003",
			customer: "CUST-0001",
			customer_name: "Alice Smith",
			posting_date: "2026-09-15",
			status: "Partly Paid",
			grand_total: 500,
			items: [
				{ item_code: "ITEM-C", item_name: "Camera Tripod", qty: 1, rate: 500 },
			],
		},
	]

	it("exports DATE_PRESETS including This Month and Financial Year", () => {
		expect(DATE_PRESETS.some((p) => p.value === "month")).toBe(true)
		expect(DATE_PRESETS.some((p) => p.value === "fy")).toBe(true)
	})

	it("computes uniqueCustomers and uniqueProducts from invoice list", () => {
		const invoices = ref(mockInvoices)
		const { uniqueCustomers, uniqueProducts } = useInvoiceFilters(invoices)

		expect(uniqueCustomers.value).toEqual([
			{ value: "CUST-0001", label: "Alice Smith" },
			{ value: "CUST-0002", label: "Bob Jones" },
		])

		expect(uniqueProducts.value).toHaveLength(3)
		expect(uniqueProducts.value.map((p) => p.value)).toContain("ITEM-A")
		expect(uniqueProducts.value.map((p) => p.value)).toContain("ITEM-B")
		expect(uniqueProducts.value.map((p) => p.value)).toContain("ITEM-C")
	})

	it("filters by customer ID or customer name", () => {
		const invoices = ref(mockInvoices)
		const { filteredInvoices } = useInvoiceFilters(invoices)
		const store = useInvoiceFiltersStore()
		store.clearDateFilter() // disable default month for exact matching

		store.setCustomer("CUST-0002", "Bob Jones")
		expect(filteredInvoices.value).toHaveLength(1)
		expect(filteredInvoices.value[0].name).toBe("ACC-SINV-2026-00002")

		store.setCustomer("CUST-0001", "Alice Smith")
		expect(filteredInvoices.value).toHaveLength(2)
	})

	it("filters by exact product code", () => {
		const invoices = ref([
			...mockInvoices,
			{
				name: "ACC-SINV-2026-00004",
				customer: "CUST-0001",
				customer_name: "Alice Smith",
				posting_date: "2026-10-14",
				status: "Paid",
				grand_total: 100,
				items: [
					{ item_code: "DETTOL-500", item_name: "Dettol 100ml", qty: 1, rate: 100 },
				],
			},
		])
		const { filteredInvoices } = useInvoiceFilters(invoices)
		const store = useInvoiceFiltersStore()
		store.clearDateFilter()

		store.setProduct("ITEM-A", "Apple Watch")
		expect(filteredInvoices.value).toHaveLength(1)
		expect(filteredInvoices.value[0].name).toBe("ACC-SINV-2026-00001")

		store.setProduct("ITEM-B", "Bluetooth Speaker")
		expect(filteredInvoices.value).toHaveLength(1)
		expect(filteredInvoices.value[0].name).toBe("ACC-SINV-2026-00002")

		// Verify exact code match: selecting code "100" should NOT match item named "Dettol 100ml"
		store.setProduct("100", "100")
		expect(filteredInvoices.value).toHaveLength(0)

		// But selecting exact code "DETTOL-500" should match
		store.setProduct("DETTOL-500", "Dettol 100ml")
		expect(filteredInvoices.value).toHaveLength(1)
		expect(filteredInvoices.value[0].name).toBe("ACC-SINV-2026-00004")
	})

	it("filters by search term across invoice ID and customer name", () => {
		const invoices = ref(mockInvoices)
		const { filteredInvoices } = useInvoiceFilters(invoices)
		const store = useInvoiceFiltersStore()
		store.clearDateFilter()

		store.searchTerm = "00002"
		expect(filteredInvoices.value).toHaveLength(1)
		expect(filteredInvoices.value[0].name).toBe("ACC-SINV-2026-00002")

		store.searchTerm = "Alice"
		expect(filteredInvoices.value).toHaveLength(2)
	})

	it("filters by status", () => {
		const invoices = ref(mockInvoices)
		const { filteredInvoices } = useInvoiceFilters(invoices)
		const store = useInvoiceFiltersStore()
		store.clearDateFilter()

		store.status = "Unpaid"
		expect(filteredInvoices.value).toHaveLength(1)
		expect(filteredInvoices.value[0].name).toBe("ACC-SINV-2026-00002")
	})

	it("filters by date range accurately using timezone-safe string matching", () => {
		const invoices = ref(mockInvoices)
		const { filteredInvoices, filterStats } = useInvoiceFilters(invoices)
		const store = useInvoiceFiltersStore()

		// Specific day (Today simulation)
		store.setDateRange("2026-10-10", "2026-10-10")
		expect(filteredInvoices.value).toHaveLength(1)
		expect(filteredInvoices.value[0].name).toBe("ACC-SINV-2026-00001")
		expect(filterStats.value.filtered).toBe(1)
		expect(filterStats.value.total).toBe(3)

		// Day with 0 matching invoices
		store.setDateRange("2026-10-21", "2026-10-21")
		expect(filteredInvoices.value).toHaveLength(0)
		expect(filterStats.value.filtered).toBe(0)
		expect(filterStats.value.total).toBe(3)

		// Entire month (October 2026)
		store.setDateRange("2026-10-01", "2026-10-31")
		expect(filteredInvoices.value).toHaveLength(2)
		expect(filterStats.value.filtered).toBe(2)

		// Financial Year (2026-04-01 to 2027-03-31)
		store.setDateRange("2026-04-01", "2027-03-31")
		expect(filteredInvoices.value).toHaveLength(3)
		expect(filterStats.value.filtered).toBe(3)
		expect(filterStats.value.total).toBe(3)
	})

	it("maintains consistent counts and percentage in filterStats", () => {
		const invoices = ref(mockInvoices)
		const { filteredInvoices, filterStats } = useInvoiceFilters(invoices)
		const store = useInvoiceFiltersStore()
		store.clearDateFilter()

		// Initially all 3 match
		expect(filterStats.value.total).toBe(3)
		expect(filterStats.value.filtered).toBe(3)
		expect(filterStats.value.percentage).toBe(100)
		expect(filteredInvoices.value.length).toBe(filterStats.value.filtered)

		// Filter by customer CUST-0002 (1 invoice)
		store.setCustomer("CUST-0002", "Bob Jones")
		expect(filterStats.value.total).toBe(3)
		expect(filterStats.value.filtered).toBe(1)
		expect(filterStats.value.percentage).toBe(33)
		expect(filteredInvoices.value.length).toBe(filterStats.value.filtered)

		// Clear customer filter
		store.clearCustomerFilter()
		expect(filterStats.value.filtered).toBe(3)
		expect(filterStats.value.percentage).toBe(100)

		// Empty invoices array
		invoices.value = []
		expect(filterStats.value.total).toBe(0)
		expect(filterStats.value.filtered).toBe(0)
		expect(filterStats.value.percentage).toBe(0)
	})
})
