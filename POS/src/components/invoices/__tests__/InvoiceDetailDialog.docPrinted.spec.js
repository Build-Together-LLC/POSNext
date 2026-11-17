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

let invoiceDatabase = {}
const mockCall = vi.fn((endpoint, params) => {
	if (endpoint === "pos_next.api.invoices.get_invoice") {
		const inv = invoiceDatabase[params.invoice_name]
		return Promise.resolve(inv ? JSON.parse(JSON.stringify(inv)) : null)
	}
	return Promise.resolve(null)
})

vi.mock("frappe-ui", () => ({
	Button: { template: "<button><slot /></button>" },
	Dialog: {
		props: ["modelValue"],
		template:
			'<div v-if="modelValue"><slot name="body-content" /><slot name="actions" /></div>',
	},
	call: (...args) => mockCall(...args),
}))

import { flushPromises, mount } from "@vue/test-utils"
import { nextTick } from "vue"
import InvoiceDetailDialog from "@/components/invoices/InvoiceDetailDialog.vue"

describe("InvoiceDetailDialog - Is Doc Printed Status", () => {
	beforeEach(() => {
		invoiceDatabase = {
			"ACC-SINV-2026-00001": {
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
				items: [
					{
						item_code: "ITEM-A",
						item_name: "Item A",
						qty: 1,
						rate: 100,
						amount: 100,
					},
				],
			},
			"ACC-SINV-2026-00002": {
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
				items: [
					{
						item_code: "ITEM-B",
						item_name: "Item B",
						qty: 2,
						rate: 100,
						amount: 200,
					},
				],
			},
		}
	})

	function mountDialog(props = {}) {
		return mount(InvoiceDetailDialog, {
			props: {
				modelValue: true,
				invoiceName: "ACC-SINV-2026-00001",
				posProfile: "Main POS",
				currency: "USD",
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

	it("displays 'No' in invoice details for unprinted invoices", async () => {
		const wrapper = mountDialog({ invoiceName: "ACC-SINV-2026-00001" })
		await flushPromises()

		const text = wrapper.text()
		expect(text).toContain("Is Doc Printed: No")
		expect(text).toContain("Is Doc Printed:")
	})

	it("displays 'Yes' in invoice details for printed invoices", async () => {
		const wrapper = mountDialog({ invoiceName: "ACC-SINV-2026-00002" })
		await flushPromises()

		const text = wrapper.text()
		expect(text).toContain("Is Doc Printed: Yes")
	})

	it("updates status to Yes only after successful print execution", async () => {
		const wrapper = mountDialog({ invoiceName: "ACC-SINV-2026-00001" })
		await flushPromises()

		// Before printing: unprinted displays No
		expect(wrapper.text()).toContain("Is Doc Printed: No")

		// Find print button in actions
		const printBtn = wrapper
			.findAll("button")
			.find((btn) => btn.text().includes("Print"))
		expect(printBtn).toBeDefined()

		await printBtn.trigger("click")

		// Emits print-invoice with callback
		const emitted = wrapper.emitted("print-invoice")
		expect(emitted).toBeDefined()
		expect(emitted[0][0].name).toBe("ACC-SINV-2026-00001")

		// Merely clicking print does NOT update status immediately
		expect(wrapper.text()).toContain("Is Doc Printed: No")

		// Successful print operation invokes the callback and persists to backend
		invoiceDatabase["ACC-SINV-2026-00001"].is_doc_printed = "Yes"
		const callback = emitted[0][1]
		expect(typeof callback).toBe("function")
		callback()
		await nextTick()

		// Details immediately updates to Yes
		expect(wrapper.text()).toContain("Is Doc Printed: Yes")
	})

	it("preserves correct status when reopening or refreshing", async () => {
		// Start with an invoice printed in DB
		invoiceDatabase["ACC-SINV-2026-00001"].is_doc_printed = "Yes"

		const wrapper = mountDialog({ invoiceName: "ACC-SINV-2026-00001" })
		await flushPromises()

		// Reopened invoice preserves Yes
		expect(wrapper.text()).toContain("Is Doc Printed: Yes")
	})
})
