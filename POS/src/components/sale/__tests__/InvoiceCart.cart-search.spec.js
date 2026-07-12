import { describe, expect, it, vi, beforeAll } from "vitest"
import { mount } from "@vue/test-utils"
import { createTestingPinia } from "@pinia/testing"

// Frappe injects `__` as a global translation helper at runtime.
beforeAll(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce((acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)), text)
})

// Stub the frappe-ui / offline plumbing the component pulls in at import time.
vi.mock("frappe-ui", () => ({
	FeatherIcon: { template: "<i />" },
	createResource: () => ({
		fetch: vi.fn(),
		reload: vi.fn(),
		submit: vi.fn(),
		data: null,
		loading: false,
	}),
}))
vi.mock("@/utils/offline", () => ({ isOffline: () => false }))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: { getCustomers: vi.fn() } }))
vi.mock("@/utils/currency", () => ({ formatCurrency: (v) => `₹ ${Number(v).toFixed(2)}` }))
vi.mock("../EditItemDialog.vue", () => ({ default: { template: "<div />" } }))

import InvoiceCart from "../InvoiceCart.vue"

const ITEMS = [
	{ item_code: ".1010058/D", item_name: "BR.PADLE BOLT CLASIC TB RR DIS", qty: 1, uom: "Nos", rate: 105, amount: 105 },
	{ item_code: ".1100133/C", item_name: "CH.COV REBON METEOR", qty: 1, uom: "Nos", rate: 145, amount: 145 },
	{ item_code: ".1010050/C", item_name: "CANISTER CLASIC BS4", qty: 2, uom: "Nos", rate: 387, amount: 774 },
]

function mountCart() {
	return mount(InvoiceCart, {
		props: { items: ITEMS, customer: null, appliedOffers: [] },
		global: {
			plugins: [createTestingPinia({ createSpy: vi.fn })],
			stubs: { EditItemDialog: true, FeatherIcon: true, teleport: true },
			config: { globalProperties: { __: globalThis.__ } },
		},
	})
}

// Cart lines are hidden with v-show, which toggles inline `display: none`.
const visibleCodes = (wrapper) =>
	wrapper
		.findAll('[data-test="cart-line"]')
		.filter((el) => el.element.style.display !== "none")
		.map((el) => el.text())

describe("InvoiceCart — item code + search in cart", () => {
	it("renders the item code on every cart line", () => {
		const wrapper = mountCart()
		const text = wrapper.text()

		for (const item of ITEMS) {
			expect(text).toContain(item.item_code)
			expect(text).toContain(item.item_name)
		}
	})

	it("filters cart lines by item code, and restores them when cleared", async () => {
		const wrapper = mountCart()
		const input = wrapper.find('input[aria-label="Search items in cart"]')

		await input.setValue(".1010058")
		let shown = visibleCodes(wrapper)
		expect(shown).toHaveLength(1)
		expect(shown[0]).toContain(".1010058/D")

		// Clearing restores the full cart.
		await input.setValue("")
		expect(visibleCodes(wrapper)).toHaveLength(ITEMS.length)
	})

	it("filters by item name too, and is case-insensitive", async () => {
		const wrapper = mountCart()
		const input = wrapper.find('input[aria-label="Search items in cart"]')

		await input.setValue("canister")
		const shown = visibleCodes(wrapper)
		expect(shown).toHaveLength(1)
		expect(shown[0]).toContain("CANISTER CLASIC BS4")
	})

	it("shows a 'not in cart' hint when nothing matches", async () => {
		const wrapper = mountCart()
		const input = wrapper.find('input[aria-label="Search items in cart"]')

		await input.setValue(".9999999")
		expect(visibleCodes(wrapper)).toHaveLength(0)
		expect(wrapper.text()).toContain("Not in cart")
	})
})
