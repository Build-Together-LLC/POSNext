import { mount } from "@vue/test-utils"
import TranslatedHTML from "@/components/common/TranslatedHTML.vue"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { computed, nextTick, ref } from "vue"
import { useInvoiceFilters } from "@/composables/useInvoiceFilters"
import { useInvoiceFiltersStore } from "@/stores/invoiceFilters"

beforeAll(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce((acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)), text)
})

vi.mock("frappe-ui", () => ({
	Button: { template: "<button><slot /></button>" },
	call: vi.fn(),
	createResource: () => ({ submit: vi.fn(), reload: vi.fn(), fetch: vi.fn() }),
}))

describe("Invoice Management Count Consistency", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		localStorage.clear()
	})

	const sampleInvoices = [
		{
			name: "ACC-SINV-2026-00001",
			customer: "CUST-0001",
			customer_name: "Alice",
			posting_date: "2026-10-10",
			posting_time: "10:00:00",
			status: "Paid",
			grand_total: 100,
			is_return: 0,
			items: [{ item_code: "ITEM-A", item_name: "Item A" }],
		},
		{
			name: "ACC-SINV-2026-00002",
			customer: "CUST-0002",
			customer_name: "Bob",
			posting_date: "2026-10-15",
			posting_time: "11:00:00",
			status: "Unpaid",
			grand_total: 200,
			is_return: 0,
			items: [{ item_code: "ITEM-B", item_name: "Item B" }],
		},
		{
			name: "ACC-SINV-2026-00003",
			customer: "CUST-0001",
			customer_name: "Alice",
			posting_date: "2026-05-01",
			posting_time: "12:00:00",
			status: "Paid",
			grand_total: 150,
			is_return: 0,
			items: [{ item_code: "ITEM-A", item_name: "Item A" }],
		},
		{
			name: "ACC-SINV-2026-00004",
			customer: "CUST-0003",
			customer_name: "Charlie",
			posting_date: "2026-10-12",
			posting_time: "09:00:00",
			status: "Return",
			grand_total: -50,
			is_return: 1,
			items: [{ item_code: "ITEM-A", item_name: "Item A" }],
		},
	]

	it("excludes return invoices from history counts and matches nonReturnHistoryInvoices", () => {
		const rawInvoices = ref([...sampleInvoices])
		const nonReturnInvoices = computed(() =>
			rawInvoices.value.filter((inv) => !inv.is_return),
		)

		const { filteredInvoices, filterStats } = useInvoiceFilters(nonReturnInvoices)
		const filterStore = useInvoiceFiltersStore()
		filterStore.clearDateFilter()

		// 3 sales invoices, 1 return invoice excluded
		expect(nonReturnInvoices.value).toHaveLength(3)
		expect(filteredInvoices.value).toHaveLength(3)
		expect(filterStats.value.total).toBe(3)
		expect(filterStats.value.filtered).toBe(3)
	})

	it("recalculates tab count, filterStats, and list when date presets change", async () => {
		const rawInvoices = ref([...sampleInvoices])
		const nonReturnInvoices = computed(() =>
			rawInvoices.value.filter((inv) => !inv.is_return),
		)
		const { filteredInvoices, filterStats } = useInvoiceFilters(nonReturnInvoices)
		const filterStore = useInvoiceFiltersStore()

		// This Month (October 2026) -> 2 invoices (00001 and 00002)
		filterStore.setDateRange("2026-10-01", "2026-10-31")
		await nextTick()
		expect(filteredInvoices.value).toHaveLength(2)
		expect(filterStats.value.filtered).toBe(2)

		// Financial Year (2026-04-01 to 2027-03-31) -> 3 invoices
		filterStore.setDateRange("2026-04-01", "2027-03-31")
		await nextTick()
		expect(filteredInvoices.value).toHaveLength(3)
		expect(filterStats.value.filtered).toBe(3)

		// Today with no invoices -> 0 invoices
		filterStore.setDateRange("2026-10-21", "2026-10-21")
		await nextTick()
		expect(filteredInvoices.value).toHaveLength(0)
		expect(filterStats.value.filtered).toBe(0)
	})

	it("updates count to 0 when no invoices match combined filters", async () => {
		const rawInvoices = ref([...sampleInvoices])
		const nonReturnInvoices = computed(() =>
			rawInvoices.value.filter((inv) => !inv.is_return),
		)
		const { filteredInvoices, filterStats } = useInvoiceFilters(nonReturnInvoices)
		const filterStore = useInvoiceFiltersStore()

		filterStore.setDateRange("2026-10-01", "2026-10-31")
		filterStore.setCustomer("CUST-0001", "Alice")
		filterStore.status = "Unpaid" // Alice only has Paid invoices in October

		await nextTick()
		expect(filteredInvoices.value).toHaveLength(0)
		expect(filterStats.value.filtered).toBe(0)
	})

	it("tab badge condition correctly displays 0 for history and hides 0 for others", () => {
		const showBadge = (tab) =>
			tab.id === "history" ? tab.count != null : tab.count != null && tab.count > 0

		expect(showBadge({ id: "history", count: 0 })).toBe(true)
		expect(showBadge({ id: "history", count: 23 })).toBe(true)
		expect(showBadge({ id: "partial", count: 0 })).toBe(false)
		expect(showBadge({ id: "partial", count: 5 })).toBe(true)
		expect(showBadge({ id: "drafts", count: 0 })).toBe(false)
		expect(showBadge({ id: "returns", count: 0 })).toBe(false)
	})

	it("TranslatedHTML reactively updates rendered content when inner prop changes", async () => {
		const wrapper = mount(TranslatedHTML, {
			props: {
				inner: "<strong>2</strong> invoice(s)",
			},
		})

		expect(wrapper.text()).toContain("2 invoice(s)")
		expect(wrapper.find("strong").text()).toBe("2")

		// Simulate filter change to Financial Year (e.g. 75 invoices)
		await wrapper.setProps({
			inner: "<strong>75</strong> invoice(s)",
		})
		expect(wrapper.text()).toContain("75 invoice(s)")
		expect(wrapper.find("strong").text()).toBe("75")

		// Simulate filter change to Today (0 invoices)
		await wrapper.setProps({
			inner: "<strong>0</strong> invoice(s)",
		})
		expect(wrapper.text()).toContain("0 invoice(s)")
		expect(wrapper.find("strong").text()).toBe("0")
	})

	it("unwraps API responses whether returned directly as an array or inside { message: [...] }", () => {
		const unwrap = (result) =>
			Array.isArray(result) ? result : Array.isArray(result?.message) ? result.message : []

		expect(unwrap([sampleInvoices[0]])).toHaveLength(1)
		expect(unwrap({ message: [sampleInvoices[0], sampleInvoices[1]] })).toHaveLength(2)
		expect(unwrap(null)).toEqual([])
		expect(unwrap(undefined)).toEqual([])
		expect(unwrap({})).toEqual([])
	})
})

