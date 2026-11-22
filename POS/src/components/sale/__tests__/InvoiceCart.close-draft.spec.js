import { describe, expect, it, vi, beforeAll } from "vitest"
import { mount } from "@vue/test-utils"
import { createTestingPinia } from "@pinia/testing"

beforeAll(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce((acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)), text)
})

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
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showError: vi.fn(),
		showWarning: vi.fn(),
		showSuccess: vi.fn(),
	}),
}))
vi.mock("../EditItemDialog.vue", () => ({ default: { template: "<div />" } }))

import InvoiceCart from "../InvoiceCart.vue"

function mountCart(props = {}) {
	return mount(InvoiceCart, {
		props: { items: [], customer: null, appliedOffers: [], ...props },
		global: {
			plugins: [createTestingPinia({ createSpy: vi.fn })],
			stubs: { EditItemDialog: true, FeatherIcon: true, teleport: true },
			config: { globalProperties: { __: globalThis.__ } },
		},
	})
}

describe("InvoiceCart - Close Draft Banner", () => {
	it("does not render banner when currentDraftId is null", () => {
		const wrapper = mountCart({ currentDraftId: null })
		expect(wrapper.text()).not.toContain("Editing Draft")
		expect(wrapper.text()).not.toContain("Close Draft")
	})

	it("renders banner with draft ID when currentDraftId is set", () => {
		const wrapper = mountCart({ currentDraftId: "ACC-SINV-2026-00042" })
		expect(wrapper.text()).toContain("Editing Draft: ACC-SINV-2026-00042")
		expect(wrapper.text()).toContain("Close Draft")
	})

	it("emits 'close-draft' when Close Draft button is clicked", async () => {
		const wrapper = mountCart({ currentDraftId: "ACC-SINV-2026-00042" })
		const closeBtn = wrapper.findAll("button").find(b => b.text().includes("Close Draft"))
		expect(closeBtn).toBeDefined()
		await closeBtn.trigger("click")
		expect(wrapper.emitted("close-draft")).toBeTruthy()
		expect(wrapper.emitted("close-draft").length).toBe(1)
	})
})
