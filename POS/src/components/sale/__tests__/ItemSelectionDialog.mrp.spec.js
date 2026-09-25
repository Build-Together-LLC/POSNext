import { beforeAll, describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"

// Frappe injects `__` as a global translation helper at runtime.
beforeAll(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce(
			(acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)),
			text,
		)
})

vi.mock("frappe-ui", () => ({
	Button: {
		props: ["disabled"],
		template:
			"<button :disabled='disabled' @click=\"$emit('click')\"><slot /></button>",
	},
	Dialog: {
		template: "<div><slot name='body-content' /><slot name='actions' /></div>",
	},
	createResource: () => ({ reload: vi.fn(), submit: vi.fn() }),
}))
vi.mock("@/utils/currency", () => ({
	formatCurrency: (v) => `₹ ${Number(v).toFixed(2)}`,
}))

import ItemSelectionDialog from "../ItemSelectionDialog.vue"

const ITEM = {
	item_code: "Q17910KVH760",
	item_name: "MIRROR ASSY",
	stock_uom: "Nos",
	rate: 400,
}

const MRP_OPTIONS = [
	{ rate: 400, price_list: "MRP", valid_from: "2026-08-12", is_default: true },
	{ rate: 500, price_list: "MRP", valid_from: "2026-08-13", is_default: false },
]

// Mounted closed and then opened: the dialog loads its options when it opens,
// which is how it is reached in the POS.
async function mountDialog(props = {}) {
	const wrapper = mount(ItemSelectionDialog, {
		props: {
			modelValue: false,
			item: ITEM,
			mode: "mrp",
			mrpOptions: MRP_OPTIONS,
			posProfile: "Aman",
			currency: "INR",
			...props,
		},
		global: {
			stubs: { TranslatedHTML: true },
			config: { globalProperties: { __: globalThis.__ } },
		},
	})
	await wrapper.setProps({ modelValue: true })
	return wrapper
}

// The confirm button, as rendered by the stubbed frappe-ui Button.
const confirmButton = (wrapper) =>
	wrapper.findAll("button").find((b) => b.text() === "Add to Cart")

describe("ItemSelectionDialog — choosing which MRP to bill at", () => {
	it("offers every MRP the item is stocked under", async () => {
		const text = (await mountDialog()).text()

		expect(text).toContain("₹ 400.00")
		expect(text).toContain("₹ 500.00")
		expect(text).toContain("Other MRP")
	})

	it("emits the chosen MRP and quantity", async () => {
		const wrapper = await mountDialog()

		// The second rate in the list: 500.
		await wrapper
			.findAll("button")
			.find((b) => b.text().includes("₹ 500.00"))
			.trigger("click")
		await confirmButton(wrapper).trigger("click")

		const emitted = wrapper.emitted("option-selected")
		expect(emitted).toBeTruthy()
		expect(emitted.at(-1)[0]).toMatchObject({
			type: "mrp",
			rate: 500,
			quantity: 1,
		})
	})

	it("starts on the rate the cart would otherwise have used", async () => {
		const wrapper = await mountDialog()

		// Nothing is picked: confirming straight away has to bill exactly what
		// adding the item normally would.
		await confirmButton(wrapper).trigger("click")

		expect(wrapper.emitted("option-selected").at(-1)[0]).toMatchObject({
			rate: 400,
		})
	})

	it("bills an MRP the price list does not carry, typed by the cashier", async () => {
		const wrapper = await mountDialog()

		const custom = wrapper.findAll('input[type="number"]').at(-1)
		await custom.trigger("focus")
		await custom.setValue(560)
		await confirmButton(wrapper).trigger("click")

		expect(wrapper.emitted("option-selected").at(-1)[0]).toMatchObject({
			type: "mrp",
			rate: 560,
			isCustom: true,
		})
	})

	it("keeps the quantity the cashier already typed at the UOM step", async () => {
		const wrapper = await mountDialog({ initialQuantity: 4 })

		await confirmButton(wrapper).trigger("click")

		expect(wrapper.emitted("option-selected").at(-1)[0]).toMatchObject({
			rate: 400,
			quantity: 4,
		})
	})

	it("will not bill a zero MRP", async () => {
		const wrapper = await mountDialog({ mrpOptions: [] })

		const custom = wrapper.findAll('input[type="number"]').at(-1)
		await custom.trigger("focus")
		await custom.setValue(0)
		await confirmButton(wrapper).trigger("click")

		expect(wrapper.emitted("option-selected")).toBeFalsy()
	})
})
