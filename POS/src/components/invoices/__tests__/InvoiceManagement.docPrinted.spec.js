import { beforeEach, describe, expect, it, vi } from "vitest"

const translate = (text, args) =>
	(args || []).reduce(
		(acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)),
		text,
	)

vi.hoisted(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce(
			(acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)),
			text,
		)
})

vi.mock("@/utils/offline", () => ({ isOffline: () => false }))
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: { getCustomers: vi.fn(), getItems: vi.fn() },
}))

let currentInvoices = []
const mockCall = vi.fn((endpoint) => {
	if (endpoint === "pos_next.api.invoices.get_invoices") {
		return Promise.resolve(currentInvoices)
	}
	return Promise.resolve([])
})

vi.mock("frappe-ui", () => ({
	Button: { template: "<button><slot /></button>" },
	Dialog: {
		props: ["modelValue"],
		template:
			'<div v-if="modelValue"><slot name="body-content" /><slot name="actions" /></div>',
	},
	call: (...args) => mockCall(...args),
	createResource: () => ({ submit: vi.fn(), reload: vi.fn(), fetch: vi.fn() }),
}))

import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import InvoiceManagement from "@/components/invoices/InvoiceManagement.vue"
import { useInvoiceFiltersStore } from "@/stores/invoiceFilters"

describe("InvoiceManagement - Is Doc Printed Status", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		localStorage.clear()
		const filterStore = useInvoiceFiltersStore()
		filterStore.clearDateFilter()
	})

	const sampleInvoices = [
		{
			name: "ACC-SINV-2026-00001",
			customer: "CUST-0001",
			customer_name: "Alice",
			posting_date: "2026-11-04",
			posting_time: "10:00:00",
			status: "Paid",
			grand_total: 100,
			paid_amount: 100,
			outstanding_amount: 0,
			is_return: 0,
			is_doc_printed: "No",
			items: [{ item_code: "ITEM-A", item_name: "Item A" }],
		},
		{
			name: "ACC-SINV-2026-00002",
			customer: "CUST-0002",
			customer_name: "Bob",
			posting_date: "2026-11-04",
			posting_time: "11:00:00",
			status: "Paid",
			grand_total: 200,
			paid_amount: 200,
			outstanding_amount: 0,
			is_return: 0,
			is_doc_printed: "Yes",
			items: [{ item_code: "ITEM-B", item_name: "Item B" }],
		},
	]

	function mountInvoiceManagement(props = {}) {
		currentInvoices = props.historyInvoices || sampleInvoices
		return mount(InvoiceManagement, {
			props: {
				modelValue: true,
				posProfile: "Main POS",
				historyInvoices: currentInvoices,
				...props,
			},
			global: {
				config: {
					globalProperties: {
						__: translate,
					},
				},
				mocks: {
					__: translate,
				},
			},
		})
	}

	it("renders 'Is Doc Printed' column header and Yes/No values in table view", async () => {
		const wrapper = mountInvoiceManagement()

		// Switch to History tab and list (table) view
		wrapper.vm.activeTab = "history"
		wrapper.vm.viewMode = "list"
		await flushPromises()

		// Verify table header
		const headers = wrapper.findAll("th").map((th) => th.text())
		expect(headers).toContain("Is Doc Printed")

		// Verify cell contents
		const rows = wrapper.findAll("tbody tr")
		expect(rows).toHaveLength(2)

		// First invoice is unprinted -> No
		expect(rows[0].text()).toContain("ACC-SINV-2026-00001")
		expect(rows[0].text()).toContain("No")

		// Second invoice is printed -> Yes
		expect(rows[1].text()).toContain("ACC-SINV-2026-00002")
		expect(rows[1].text()).toContain("Yes")
	})

	it("renders 'Is Doc Printed' status in card view", async () => {
		const wrapper = mountInvoiceManagement()

		// Switch to History tab and card view
		wrapper.vm.activeTab = "history"
		wrapper.vm.viewMode = "card"
		await flushPromises()

		const text = wrapper.text()
		expect(text).toContain("Is Doc Printed: No")
		expect(text).toContain("Is Doc Printed: Yes")
	})

	it("updates status to Yes only after successful print execution via callback", async () => {
		const unprinted = {
			name: "ACC-SINV-2026-00003",
			customer: "CUST-0003",
			customer_name: "Charlie",
			posting_date: "2026-11-04",
			posting_time: "14:00:00",
			status: "Paid",
			grand_total: 300,
			is_return: 0,
			is_doc_printed: "No",
			items: [],
		}

		const wrapper = mountInvoiceManagement({
			historyInvoices: [unprinted],
		})

		wrapper.vm.activeTab = "history"
		wrapper.vm.viewMode = "list"
		await flushPromises()

		// Initially "No"
		expect(wrapper.text()).toContain("No")
		expect(unprinted.is_doc_printed).toBe("No")

		// Find print button in table
		const printBtn = wrapper
			.findAll("button")
			.find((btn) => btn.attributes("title") === "Print")
		expect(printBtn).toBeDefined()

		await printBtn.trigger("click")

		// Merely clicking emits the event with invoice and onSuccess callback
		const emitted = wrapper.emitted("print-invoice")
		expect(emitted).toBeDefined()
		expect(emitted[0][0].name).toBe("ACC-SINV-2026-00003")

		// Before print success callback, status remains "No"
		expect(unprinted.is_doc_printed).toBe("No")

		// Simulate print operation succeeding (executing callback)
		const callback = emitted[0][1]
		expect(typeof callback).toBe("function")
		callback()
		await nextTick()

		// Now status is "Yes"
		expect(unprinted.is_doc_printed).toBe("Yes")
		expect(wrapper.text()).toContain("Yes")
	})
})
