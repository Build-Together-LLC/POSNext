import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createTestingPinia } from "@pinia/testing"

const showError = vi.fn()
const showSuccess = vi.fn()
let mockCanDeleteInvoice = vi.fn().mockResolvedValue(true)

beforeAll(() => {
	globalThis.__ = (text, args) =>
		(args || []).reduce((acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)), text)
})

vi.mock("frappe-ui", () => ({
	Button: {
		props: ["variant", "theme"],
		template: '<button :data-theme="theme"><slot /></button>',
	},
	Dialog: {
		props: ["modelValue", "options"],
		template: '<div v-if="modelValue" class="dialog-stub"><slot name="body-content" /><slot name="actions" /></div>',
	},
	Input: {
		props: ["modelValue", "placeholder"],
		template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
	},
	createResource: () => ({
		fetch: vi.fn(),
		reload: vi.fn(),
		submit: vi.fn(),
		data: null,
		loading: false,
	}),
	call: vi.fn(),
}))

vi.mock("@/utils/offline", () => ({ isOffline: () => false }))
vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: { getCustomers: vi.fn() },
}))

vi.mock("@/utils/currency", () => ({
	formatCurrency: (v) => `$${Number(v).toFixed(2)}`,
}))

vi.mock("@/utils/printInvoice", () => ({
	printDraftReceipt: vi.fn(),
}))

vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showError,
		showSuccess,
		showWarning: vi.fn(),
	}),
}))

vi.mock("@/composables/usePermissions", () => ({
	usePOSPermissions: () => ({
		canDeleteInvoice: () => mockCanDeleteInvoice(),
	}),
	usePermissions: () => ({
		checkPermission: (doctype, perm) =>
			perm === "delete" ? mockCanDeleteInvoice() : Promise.resolve(true),
	}),
}))

import DraftInvoicesDialog from "../DraftInvoicesDialog.vue"
import { usePOSDraftsStore } from "@/stores/posDrafts"

const SAMPLE_DRAFTS = [
	{
		draft_id: "DRAFT-001",
		customer: { name: "CUST-001", customer_name: "John Doe" },
		created_at: "2026-10-09 10:00:00",
		grand_total: 100,
		items: [{ item_name: "Widget", qty: 2, rate: 50 }],
	},
	{
		draft_id: "DRAFT-002",
		customer: { name: "CUST-002", customer_name: "Jane Smith" },
		created_at: "2026-10-09 11:00:00",
		grand_total: 200,
		items: [{ item_name: "Gadget", qty: 4, rate: 50 }],
	},
]

describe("DraftInvoicesDialog delete permission", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders delete buttons and Clear All when user has delete permission", async () => {
		mockCanDeleteInvoice.mockResolvedValue(true)

		const pinia = createTestingPinia({ createSpy: vi.fn })
		const draftsStore = usePOSDraftsStore(pinia)
		draftsStore.drafts = SAMPLE_DRAFTS

		const wrapper = mount(DraftInvoicesDialog, {
			props: { modelValue: true, currency: "USD" },
			global: {
				plugins: [pinia],
				config: { globalProperties: { __: globalThis.__ } },
			},
		})

		await flushPromises()

		// Delete buttons for each draft
		const deleteDraftButtons = wrapper
			.findAll("button")
			.filter((b) => b.attributes("title") === "Delete draft")
		expect(deleteDraftButtons.length).toBe(SAMPLE_DRAFTS.length)

		// Clear All button
		const clearAllButtons = wrapper
			.findAll("button")
			.filter((b) => b.text().includes("Clear All"))
		expect(clearAllButtons.length).toBe(1)
	})

	it("hides delete buttons and Clear All when user lacks delete permission in ERP", async () => {
		mockCanDeleteInvoice.mockResolvedValue(false)

		const pinia = createTestingPinia({ createSpy: vi.fn })
		const draftsStore = usePOSDraftsStore(pinia)
		draftsStore.drafts = SAMPLE_DRAFTS

		const wrapper = mount(DraftInvoicesDialog, {
			props: { modelValue: true, currency: "USD" },
			global: {
				plugins: [pinia],
				config: { globalProperties: { __: globalThis.__ } },
			},
		})

		await flushPromises()

		// Delete buttons should be hidden
		const deleteDraftButtons = wrapper
			.findAll("button")
			.filter((b) => b.attributes("title") === "Delete draft")
		expect(deleteDraftButtons.length).toBe(0)

		// Clear All button should be hidden
		const clearAllButtons = wrapper
			.findAll("button")
			.filter((b) => b.text().includes("Clear All"))
		expect(clearAllButtons.length).toBe(0)
	})

	it("shows error toast if delete is attempted without permission", async () => {
		mockCanDeleteInvoice.mockResolvedValue(false)

		const pinia = createTestingPinia({ createSpy: vi.fn })
		const draftsStore = usePOSDraftsStore(pinia)
		draftsStore.drafts = SAMPLE_DRAFTS

		const wrapper = mount(DraftInvoicesDialog, {
			props: { modelValue: true, currency: "USD" },
			global: {
				plugins: [pinia],
				config: { globalProperties: { __: globalThis.__ } },
			},
		})

		await flushPromises()

		// Calling deleteDraft directly on store or wrapper methods
		await wrapper.vm.confirmDeleteDraft()
		expect(showError).toHaveBeenCalledWith("You don't have permission to delete draft invoices")
		expect(draftsStore.deleteDraft).not.toHaveBeenCalled()

		await wrapper.vm.confirmClearAll()
		expect(showError).toHaveBeenCalledWith("You don't have permission to delete draft invoices")
		expect(draftsStore.deleteAllDrafts).not.toHaveBeenCalled()
	})
})
