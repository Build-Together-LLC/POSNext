import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createTestingPinia } from "@pinia/testing"

const showError = vi.fn()
const showSuccess = vi.fn()
const showLocked = vi.fn()
const mockCanDeleteInvoice = vi.fn().mockResolvedValue(true)
const mockPrintDraftReceipt = vi.fn().mockResolvedValue(true)
const mockMarkDraftPrinted = vi.fn().mockImplementation((draft) => {
	const count = (draft.draft_print_count || 0) + 1
	draft.is_draft_printed = "Yes"
	draft.draft_print_count = count
	return Promise.resolve({
		success: true,
		is_draft_printed: "Yes",
		draft_print_count: count,
	})
})

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
	printDraftReceipt: (...args) => mockPrintDraftReceipt(...args),
	markDraftPrinted: (...args) => mockMarkDraftPrinted(...args),
}))

vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showError,
		showSuccess,
		showLocked,
		showWarning: vi.fn(),
	}),
}))

vi.mock("@/composables/usePermissions", () => ({
	usePOSPermissions: () => ({
		canDeleteInvoice: () => mockCanDeleteInvoice(),
	}),
	usePermissions: () => ({
		checkPermission: () => Promise.resolve(true),
	}),
}))

import DraftInvoicesDialog from "../DraftInvoicesDialog.vue"
import { usePOSDraftsStore } from "@/stores/posDrafts"

describe("DraftInvoicesDialog - Is Draft Printed and Count", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function mountDialog(drafts) {
		const pinia = createTestingPinia({
			createSpy: vi.fn,
			initialState: {
				posDrafts: {
					drafts,
				},
				posShift: {
					profileCompany: "Test Company",
					profileName: "Main POS",
				},
			},
		})

		const draftsStore = usePOSDraftsStore()
		draftsStore.loadDrafts = vi.fn().mockResolvedValue()
		draftsStore.hydrateDraft = vi.fn().mockImplementation((d) => Promise.resolve(d))

		return mount(DraftInvoicesDialog, {
			props: {
				modelValue: true,
				currency: "USD",
			},
			global: {
				plugins: [pinia],
				config: {
					globalProperties: {
						__: globalThis.__,
					},
				},
				mocks: {
					__: globalThis.__,
				},
			},
		})
	}

	it("renders 'Is Draft Printed: No' for unprinted draft", async () => {
		const drafts = [
			{
				draft_id: "DRAFT-001",
				customer: "Alice",
				created_at: "2026-11-27T10:00:00Z",
				items: [{ item_name: "Item A", quantity: 1, rate: 100 }],
				is_draft_printed: "No",
				draft_print_count: 0,
			},
		]

		const wrapper = mountDialog(drafts)
		await flushPromises()

		const text = wrapper.text()
		expect(text).toContain("DRAFT-001")
		expect(text).toContain("Is Draft Printed: No")
	})

	it("renders 'Is Draft Printed: Yes' with tick icon and round circle count for printed draft", async () => {
		const drafts = [
			{
				draft_id: "DRAFT-002",
				customer: "Bob",
				created_at: "2026-11-27T11:00:00Z",
				items: [{ item_name: "Item B", quantity: 2, rate: 50 }],
				is_draft_printed: "Yes",
				draft_print_count: 3,
			},
		]

		const wrapper = mountDialog(drafts)
		await flushPromises()

		const text = wrapper.text()
		expect(text).toContain("DRAFT-002")
		expect(text).toContain("Is Draft Printed: Yes")
		expect(text).toContain("3")
	})

	it("updates draft printed status and count upon clicking print draft", async () => {
		const draft = {
			draft_id: "DRAFT-003",
			customer: "Charlie",
			created_at: "2026-11-27T12:00:00Z",
			items: [{ item_name: "Item C", quantity: 1, rate: 75 }],
			is_draft_printed: "No",
			draft_print_count: 0,
		}

		const wrapper = mountDialog([draft])
		await flushPromises()

		expect(wrapper.text()).toContain("Is Draft Printed: No")

		const printBtn = wrapper.find('button[title="Print draft"]')
		expect(printBtn.exists()).toBe(true)

		await printBtn.trigger("click")
		await flushPromises()

		expect(mockPrintDraftReceipt).toHaveBeenCalled()
		expect(mockMarkDraftPrinted).toHaveBeenCalledWith(draft)
		expect(draft.is_draft_printed).toBe("Yes")
		expect(draft.draft_print_count).toBe(1)
		expect(wrapper.text()).toContain("Is Draft Printed: Yes")
		expect(wrapper.text()).toContain("1")
		expect(wrapper.emitted("drafts-updated")).toBeDefined()
	})
})
