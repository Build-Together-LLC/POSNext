import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createTestingPinia } from "@pinia/testing"

const showError = vi.fn()
const showSuccess = vi.fn()
const showLocked = vi.fn()
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
		showLocked,
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

const SAMPLE_DRAFTS_WITH_LOCK = [
	{
		draft_id: "DRAFT-001",
		customer: { name: "CUST-001", customer_name: "John Doe" },
		created_at: "2026-10-09 10:00:00",
		grand_total: 100,
		items: [{ item_name: "Widget", qty: 2, rate: 50 }],
		is_locked: true,
		is_locked_by_me: false,
		locked_by: "Alice Cashier",
	},
	{
		draft_id: "DRAFT-002",
		customer: { name: "CUST-002", customer_name: "Jane Smith" },
		created_at: "2026-10-09 11:00:00",
		grand_total: 200,
		items: [{ item_name: "Gadget", qty: 4, rate: 50 }],
		is_locked: false,
		is_locked_by_me: false,
		locked_by: null,
	},
	{
		draft_id: "DRAFT-003",
		customer: { name: "CUST-003", customer_name: "Bob Brown" },
		created_at: "2026-10-09 12:00:00",
		grand_total: 300,
		items: [{ item_name: "Tool", qty: 1, rate: 300 }],
		is_locked: true,
		is_locked_by_me: true,
		locked_by: "Current Cashier",
	},
]

describe("DraftInvoicesDialog draft locking", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders locked badge for draft locked by another user", async () => {
		const pinia = createTestingPinia({ createSpy: vi.fn })
		const draftsStore = usePOSDraftsStore(pinia)
		draftsStore.drafts = SAMPLE_DRAFTS_WITH_LOCK

		const wrapper = mount(DraftInvoicesDialog, {
			props: { modelValue: true, currency: "USD" },
			global: {
				plugins: [pinia],
				config: { globalProperties: { __: globalThis.__ } },
			},
		})

		await flushPromises()

		const text = wrapper.text()
		expect(text).toContain("Locked")
		expect(text).toContain("DRAFT-001")
	})

	it("prevents loading locked draft and shows locked toast with lock icon", async () => {
		const pinia = createTestingPinia({ createSpy: vi.fn })
		const draftsStore = usePOSDraftsStore(pinia)
		draftsStore.drafts = SAMPLE_DRAFTS_WITH_LOCK

		const wrapper = mount(DraftInvoicesDialog, {
			props: { modelValue: true, currency: "USD" },
			global: {
				plugins: [pinia],
				config: { globalProperties: { __: globalThis.__ } },
			},
		})

		await flushPromises()

		// Find the card for DRAFT-001 (locked by another user)
		const cards = wrapper.findAll(".bg-white.border")
		expect(cards.length).toBe(3)

		// Click on DRAFT-001
		await cards[0].trigger("click")

		// It should NOT emit load-draft
		expect(wrapper.emitted("load-draft")).toBeUndefined()

		// It should call showLocked with appropriate message
		expect(showLocked).toHaveBeenCalledWith(
			expect.stringContaining("Alice Cashier"),
			"Draft Locked",
		)
	})

	it("allows loading unlocked draft or draft locked by current user", async () => {
		const pinia = createTestingPinia({ createSpy: vi.fn })
		const draftsStore = usePOSDraftsStore(pinia)
		draftsStore.drafts = SAMPLE_DRAFTS_WITH_LOCK

		const wrapper = mount(DraftInvoicesDialog, {
			props: { modelValue: true, currency: "USD" },
			global: {
				plugins: [pinia],
				config: { globalProperties: { __: globalThis.__ } },
			},
		})

		await flushPromises()

		const cards = wrapper.findAll(".bg-white.border")

		// Click on DRAFT-002 (unlocked)
		await cards[1].trigger("click")
		expect(wrapper.emitted("load-draft")).toHaveLength(1)
		expect(wrapper.emitted("load-draft")[0][0].draft_id).toBe("DRAFT-002")

		// Click on DRAFT-003 (locked by me)
		await cards[2].trigger("click")
		expect(wrapper.emitted("load-draft")).toHaveLength(2)
		expect(wrapper.emitted("load-draft")[1][0].draft_id).toBe("DRAFT-003")
	})

	it("prevents deleting a draft locked by another user", async () => {
		const pinia = createTestingPinia({ createSpy: vi.fn })
		const draftsStore = usePOSDraftsStore(pinia)
		draftsStore.drafts = SAMPLE_DRAFTS_WITH_LOCK

		const wrapper = mount(DraftInvoicesDialog, {
			props: { modelValue: true, currency: "USD" },
			global: {
				plugins: [pinia],
				config: { globalProperties: { __: globalThis.__ } },
			},
		})

		await flushPromises()

		const deleteButtons = wrapper.findAll("button[title='Delete draft']")
		expect(deleteButtons.length).toBe(3)

		// Attempt to delete DRAFT-001 (locked by Alice)
		await deleteButtons[0].trigger("click")

		expect(showLocked).toHaveBeenCalledWith(
			expect.stringContaining("Alice Cashier"),
			"Draft Locked",
		)
		expect(draftsStore.deleteDraft).not.toHaveBeenCalled()
	})
})
