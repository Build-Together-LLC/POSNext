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

let mockResourceData = []
let resourceConfig = null

vi.mock("frappe-ui", () => ({
	Button: { template: "<button><slot /></button>" },
	Dialog: {
		props: ["modelValue"],
		template:
			'<div v-if="modelValue"><slot name="body-content" /><slot name="actions" /></div>',
	},
	Input: {
		props: ["modelValue"],
		template:
			'<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
	},
	call: vi.fn(),
	createResource: (config) => {
		resourceConfig = config
		return {
			loading: false,
			data: mockResourceData,
			reload: vi.fn(() => {
				config.onSuccess?.(mockResourceData)
			}),
		}
	},
}))

import { flushPromises, mount } from "@vue/test-utils"
import { nextTick } from "vue"
import InvoiceHistoryDialog from "@/components/sale/InvoiceHistoryDialog.vue"

describe("InvoiceHistoryDialog - Is Doc Printed Status", () => {
	beforeEach(() => {
		mockResourceData = [
			{
				name: "ACC-SINV-2026-00001",
				customer: "CUST-0001",
				customer_name: "Alice",
				posting_date: "2026-11-04",
				posting_time: "10:00:00",
				grand_total: 100,
				status: "Paid",
				docstatus: 1,
				is_return: 0,
				is_doc_printed: "No",
			},
			{
				name: "ACC-SINV-2026-00002",
				customer: "CUST-0002",
				customer_name: "Bob",
				posting_date: "2026-11-04",
				posting_time: "11:00:00",
				grand_total: 200,
				status: "Paid",
				docstatus: 1,
				is_return: 0,
				is_doc_printed: "Yes",
			},
		]
	})

	function mountDialog() {
		const wrapper = mount(InvoiceHistoryDialog, {
			props: {
				modelValue: true,
				posProfile: "Main POS",
				currency: "USD",
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
		resourceConfig?.onSuccess?.(mockResourceData)
		return wrapper
	}

	it("renders 'Is Doc Printed' Yes/No status badges", async () => {
		const wrapper = mountDialog()
		await flushPromises()

		const text = wrapper.text()
		expect(text).toContain("Is Doc Printed: No")
		expect(text).toContain("Is Doc Printed: Yes")
	})

	it("updates status to Yes only after successful print execution via callback", async () => {
		const wrapper = mountDialog()
		await flushPromises()

		// Verify initial status
		expect(wrapper.text()).toContain("Is Doc Printed: No")

		// Find print button for first invoice
		const printBtn = wrapper
			.findAll("button")
			.find((btn) => btn.attributes("title") === "Print")
		expect(printBtn).toBeDefined()

		await printBtn.trigger("click")

		const emitted = wrapper.emitted("print-invoice")
		expect(emitted).toBeDefined()
		expect(emitted[0][0].name).toBe("ACC-SINV-2026-00001")

		// Merely clicking print keeps status as "No"
		expect(wrapper.text()).toContain("Is Doc Printed: No")

		// Print succeeds and invokes callback
		const callback = emitted[0][1]
		expect(typeof callback).toBe("function")
		callback()
		await nextTick()

		// Both invoices are now printed
		expect(wrapper.text()).not.toContain("Is Doc Printed: No")
		expect(wrapper.text()).toContain("Is Doc Printed: Yes")
	})
})
