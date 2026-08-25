import { describe, expect, it, vi, beforeAll } from "vitest"
import { mount } from "@vue/test-utils"
import { createTestingPinia } from "@pinia/testing"

// Frappe injects `__` as a global translation helper at runtime.
beforeAll(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce(
			(acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)),
			text,
		)
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
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: {
		getCustomers: vi.fn(),
		searchCachedCustomers: vi.fn().mockResolvedValue([]),
	},
}))
vi.mock("@/utils/currency", () => ({
	formatCurrency: (v) => `₹ ${Number(v).toFixed(2)}`,
}))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showError: vi.fn(),
		showWarning: vi.fn(),
		showSuccess: vi.fn(),
	}),
}))
vi.mock("../EditItemDialog.vue", () => ({ default: { template: "<div />" } }))

import InvoiceCart from "../InvoiceCart.vue"

const ITEMS = [
	{
		item_code: "HE53100KTC900S",
		item_name: "HANDLE BAR SSPL/GLM OM",
		quantity: 1,
		uom: "Nos",
		rate: 505,
		amount: 505,
	},
	{
		item_code: "AS1760F",
		item_name: "F REST ASSY PUL FR/RH",
		quantity: 1,
		uom: "Nos",
		rate: 120,
		amount: 120,
	},
	{
		item_code: "AS1310A",
		item_name: "BRK ROD SPL",
		quantity: 1,
		uom: "Nos",
		rate: 71,
		amount: 71,
	},
]

function mountCart(items = ITEMS) {
	return mount(InvoiceCart, {
		props: { items, customer: null, appliedOffers: [] },
		global: {
			plugins: [createTestingPinia({ createSpy: vi.fn })],
			stubs: {
				EditItemDialog: true,
				FeatherIcon: true,
				teleport: true,
				Dialog: {
					props: ["modelValue", "options"],
					template:
						'<div v-if="modelValue" data-test="dialog" :data-size="options?.size"><slot name="body-content" /><slot name="actions" /></div>',
				},
				Button: { template: "<button><slot /></button>" },
			},
			config: { globalProperties: { __: globalThis.__ } },
		},
	})
}

const checkboxes = (wrapper) =>
	wrapper.findAll('[data-test="cart-line-review"]')
const isChecked = (box) => box.attributes("aria-checked") === "true"

describe("InvoiceCart — per-line review checkbox", () => {
	it("renders one unchecked checkbox for every cart line", () => {
		const wrapper = mountCart()
		const boxes = checkboxes(wrapper)

		expect(boxes).toHaveLength(ITEMS.length)
		for (const box of boxes) {
			expect(box.attributes("role")).toBe("checkbox")
			expect(isChecked(box)).toBe(false)
			expect(box.find("svg").exists()).toBe(false)
		}
	})

	it("toggles a single line and shows a green tick when checked", async () => {
		const wrapper = mountCart()
		const [first, second] = checkboxes(wrapper)

		await first.trigger("click")
		expect(isChecked(first)).toBe(true)
		expect(first.classes()).toContain("bg-green-600")
		expect(first.find("svg").exists()).toBe(true)
		// Only the clicked line is affected.
		expect(isChecked(second)).toBe(false)

		await first.trigger("click")
		expect(isChecked(first)).toBe(false)
		expect(first.find("svg").exists()).toBe(false)
	})

	it("does not open the edit dialog when the checkbox is clicked", async () => {
		const wrapper = mountCart()
		const line = wrapper.find('[data-test="cart-line"]')

		await line.find('[data-test="cart-line-review"]').trigger("click")
		expect(wrapper.vm.editingItem).toBeFalsy()
	})

	it("forgets the tick when the line leaves the cart", async () => {
		const wrapper = mountCart()
		// Lines are displayed newest-first: index 0 is the last item in props.
		const removedCode = ITEMS[ITEMS.length - 1].item_code
		const first = checkboxes(wrapper)[0]
		await first.trigger("click")
		expect(isChecked(first)).toBe(true)

		// Remove the ticked line, then add it back: it must come back unticked.
		await wrapper.setProps({
			items: ITEMS.filter((i) => i.item_code !== removedCode),
		})
		expect(checkboxes(wrapper)).toHaveLength(ITEMS.length - 1)
		await wrapper.setProps({ items: ITEMS })
		expect(isChecked(checkboxes(wrapper)[0])).toBe(false)
	})

	it("clears every tick when the cart is emptied (e.g. after submit)", async () => {
		const wrapper = mountCart()
		for (const box of checkboxes(wrapper)) await box.trigger("click")
		expect(checkboxes(wrapper).every(isChecked)).toBe(true)

		await wrapper.setProps({ items: [] })
		await wrapper.setProps({ items: ITEMS })
		expect(checkboxes(wrapper).some(isChecked)).toBe(false)
	})
})

const checkoutButton = (wrapper) =>
	wrapper.find('[data-test="checkout-button"]')

describe("InvoiceCart — checkout only takes reviewed lines", () => {
	it("keeps Checkout disabled until at least one line is ticked", async () => {
		const wrapper = mountCart()
		const checkout = checkoutButton(wrapper)

		expect(checkout.attributes("disabled")).toBeDefined()
		expect(wrapper.find('[data-test="review-progress"]').text()).toContain(
			"0 of 3 items reviewed",
		)

		await checkboxes(wrapper)[0].trigger("click")
		expect(checkout.attributes("disabled")).toBeUndefined()
		expect(wrapper.find('[data-test="review-progress"]').text()).toContain(
			"1 of 3 items reviewed",
		)
	})

	it("proceeds straight to payment when every line is ticked", async () => {
		const wrapper = mountCart()
		for (const box of checkboxes(wrapper)) await box.trigger("click")

		await checkoutButton(wrapper).trigger("click")

		expect(wrapper.find('[data-test="dialog"]').exists()).toBe(false)
		expect(wrapper.emitted("remove-item")).toBeUndefined()
		expect(wrapper.emitted("proceed-to-payment")).toHaveLength(1)
	})

	it("asks before dropping unticked lines, and cancelling changes nothing", async () => {
		const wrapper = mountCart()
		await checkboxes(wrapper)[0].trigger("click")

		await checkoutButton(wrapper).trigger("click")
		const dialog = wrapper.find('[data-test="dialog"]')
		expect(dialog.exists()).toBe(true)
		// Lines are displayed newest-first, so ticking index 0 leaves the first two props items unticked.
		const listed = dialog.find('[data-test="unreviewed-list"]').text()
		expect(listed).toContain(ITEMS[0].item_code)
		expect(listed).toContain(ITEMS[1].item_code)
		expect(listed).not.toContain(ITEMS[2].item_code)

		await dialog.find('[data-test="unreviewed-cancel"]').trigger("click")
		expect(wrapper.find('[data-test="dialog"]').exists()).toBe(false)
		expect(wrapper.emitted("remove-item")).toBeUndefined()
		expect(wrapper.emitted("proceed-to-payment")).toBeUndefined()
	})

	it("removes every unticked line from the cart, then proceeds to payment", async () => {
		const wrapper = mountCart()
		await checkboxes(wrapper)[0].trigger("click")
		await checkoutButton(wrapper).trigger("click")

		await wrapper.find('[data-test="unreviewed-confirm"]').trigger("click")

		expect(wrapper.emitted("remove-item")).toEqual([
			[ITEMS[0].item_code, ITEMS[0].uom],
			[ITEMS[1].item_code, ITEMS[1].uom],
		])
		expect(wrapper.emitted("proceed-to-payment")).toHaveLength(1)
		expect(wrapper.find('[data-test="dialog"]').exists()).toBe(false)
	})
})

describe("InvoiceCart — unreviewed list stays scrollable when long", () => {
	const MANY = Array.from({ length: 12 }, (_, i) => ({
		item_code: `CODE-${i}`,
		item_name: `Item ${i}`,
		quantity: 1,
		uom: "Nos",
		rate: 10,
		amount: 10,
	}))

	it("bounds the list height with a scrollable container and shows a scroll hint", async () => {
		const wrapper = mountCart(MANY)
		await checkboxes(wrapper)[0].trigger("click")
		await checkoutButton(wrapper).trigger("click")

		const list = wrapper.find('[data-test="unreviewed-list"]')
		expect(list.findAll("li")).toHaveLength(MANY.length - 1)
		expect(list.classes()).toContain("max-h-64")
		expect(list.classes()).toContain("overflow-y-auto")
		expect(list.classes()).toContain("unreviewed-scroll")
		expect(wrapper.find('[data-test="unreviewed-scroll-hint"]').exists()).toBe(
			true,
		)
	})

	it("omits the scroll hint for a short list", async () => {
		const wrapper = mountCart()
		await checkboxes(wrapper)[0].trigger("click")
		await checkoutButton(wrapper).trigger("click")

		expect(wrapper.find('[data-test="unreviewed-list"]').exists()).toBe(true)
		expect(wrapper.find('[data-test="unreviewed-scroll-hint"]').exists()).toBe(
			false,
		)
	})
})

describe("InvoiceCart — unreviewed dialog can be expanded to read full names", () => {
	const LONG = Array.from({ length: 4 }, (_, i) => ({
		item_code: `Q83410AAH100U-${i}`,
		item_name: "ABS HLV CDDLX BLK WITH A VERY LONG DESCRIPTIVE NAME",
		quantity: 1,
		uom: "Nos",
		rate: 10,
		amount: 10,
	}))

	async function openDialog() {
		const wrapper = mountCart(LONG)
		await checkboxes(wrapper)[0].trigger("click")
		await checkoutButton(wrapper).trigger("click")
		return wrapper
	}

	it("opens at a readable size with names truncated and full text in the tooltip", async () => {
		const wrapper = await openDialog()
		expect(wrapper.find('[data-test="dialog"]').attributes("data-size")).toBe(
			"lg",
		)

		const name = wrapper.find('[data-test="unreviewed-name"]')
		expect(name.classes()).toContain("truncate")
		expect(name.attributes("title")).toBe(
			`${LONG[0].item_code} : ${LONG[0].item_name}`,
		)
	})

	it("expands to a wider dialog with wrapped names, and collapses back", async () => {
		const wrapper = await openDialog()
		const toggle = wrapper.find('[data-test="unreviewed-expand"]')
		expect(toggle.attributes("aria-expanded")).toBe("false")

		await toggle.trigger("click")
		expect(toggle.attributes("aria-expanded")).toBe("true")
		expect(wrapper.find('[data-test="dialog"]').attributes("data-size")).toBe(
			"3xl",
		)
		const name = wrapper.find('[data-test="unreviewed-name"]')
		expect(name.classes()).toContain("break-words")
		expect(name.classes()).not.toContain("truncate")
		expect(name.attributes("title")).toBeUndefined()
		expect(wrapper.find('[data-test="unreviewed-list"]').classes()).toContain(
			"max-h-[65vh]",
		)

		await toggle.trigger("click")
		expect(wrapper.find('[data-test="dialog"]').attributes("data-size")).toBe(
			"lg",
		)
		expect(wrapper.find('[data-test="unreviewed-name"]').classes()).toContain(
			"truncate",
		)
	})

	it("reopens compact after being closed while expanded", async () => {
		const wrapper = await openDialog()
		await wrapper.find('[data-test="unreviewed-expand"]').trigger("click")
		await wrapper.find('[data-test="unreviewed-cancel"]').trigger("click")

		await checkoutButton(wrapper).trigger("click")
		expect(wrapper.find('[data-test="dialog"]').attributes("data-size")).toBe(
			"lg",
		)
	})
})
