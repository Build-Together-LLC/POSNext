import { describe, expect, it, vi, beforeEach } from "vitest"
import { createPinia, setActivePinia } from "pinia"

vi.mock("frappe-ui", () => ({
	createResource: vi.fn(() => ({
		submit: vi.fn(),
		reload: vi.fn(),
		fetch: vi.fn(),
		loading: false,
		data: null,
		error: null,
	})),
	call: vi.fn(),
	Button: {},
	Dialog: {},
}))

const showSuccess = vi.fn()
const showError = vi.fn()
const showLocked = vi.fn()

let mockAcquireResult = true
let mockLockedBy = null
const mockAcquire = vi.fn().mockImplementation(() => Promise.resolve(mockAcquireResult))
const mockRelease = vi.fn().mockImplementation(() => Promise.resolve(true))

vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showSuccess,
		showError,
		showWarning: vi.fn(),
		showLocked,
	}),
}))

vi.mock("@/composables/useEditLock", () => ({
	useEditLock: () => ({
		acquire: mockAcquire,
		release: mockRelease,
		lockedBy: { value: mockLockedBy },
	}),
}))

vi.mock("@/utils/serverDraftManager", () => ({
	getServerDraftById: vi.fn().mockResolvedValue({
		items: [{ item_code: "ITEM-001", quantity: 2, rate: 100 }],
		customer: { name: "CUST-001" },
		modified: "2026-11-17 12:00:00",
		additional_discount: 0,
		coupon_code: null,
	}),
	getAllServerDrafts: vi.fn().mockResolvedValue([]),
	saveServerDraft: vi.fn(),
	deleteServerDraft: vi.fn(),
	getServerDraftStates: vi.fn().mockResolvedValue({}),
	clearAllServerDrafts: vi.fn(),
}))

vi.mock("@/utils/draftManager", () => ({
	getAllDrafts: vi.fn().mockResolvedValue([]),
	getDraftById: vi.fn().mockResolvedValue(null),
	saveDraft: vi.fn(),
	updateDraft: vi.fn(),
	deleteDraft: vi.fn(),
	clearAllDrafts: vi.fn(),
}))

vi.mock("@/utils/offline", () => ({
	isOffline: () => false,
}))

vi.mock("@/utils/offline/sync", () => ({
	getOfflineInvoices: vi.fn().mockResolvedValue([]),
}))

vi.mock("@/stores/posCart", () => ({
	usePOSCartStore: () => ({
		posProfile: "Main",
		posOpeningShift: "SHIFT-01",
		customer: { name: "CUST-001" },
		invoiceItems: [],
	}),
}))

import { usePOSDraftsStore } from "../posDrafts"

describe("posDrafts store locking", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		vi.clearAllMocks()
		mockAcquireResult = true
		mockLockedBy = null
		globalThis.__ = (text, args) =>
			(args || []).reduce((acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)), text)
	})

	it("acquires edit lock when loading a server draft", async () => {
		const store = usePOSDraftsStore()
		const draft = {
			server_draft: true,
			draft_id: "ACC-SINV-2026-00001",
			invoice_name: "ACC-SINV-2026-00001",
		}

		const result = await store.loadDraft(draft)

		expect(mockAcquire).toHaveBeenCalledWith("Sales Invoice", "ACC-SINV-2026-00001")
		expect(result).not.toBeNull()
		expect(result.items).toHaveLength(1)
		expect(showSuccess).toHaveBeenCalled()
	})

	it("returns null and displays showLocked message when draft is locked by another user", async () => {
		mockAcquireResult = false
		mockLockedBy = {
			user: "other_cashier",
			full_name: "Bob Cashier",
			message: "This draft is currently being edited by Bob Cashier. Please try again later.",
		}

		const store = usePOSDraftsStore()
		const draft = {
			server_draft: true,
			draft_id: "ACC-SINV-2026-00002",
			invoice_name: "ACC-SINV-2026-00002",
		}

		const result = await store.loadDraft(draft)

		expect(mockAcquire).toHaveBeenCalledWith("Sales Invoice", "ACC-SINV-2026-00002")
		expect(result).toBeNull()
		expect(showLocked).toHaveBeenCalledWith(
			expect.stringContaining("Bob Cashier"),
			"Draft Locked",
		)
	})

	it("releases lock when releaseDraftLock is called", async () => {
		const store = usePOSDraftsStore()
		await store.releaseDraftLock()

		expect(mockRelease).toHaveBeenCalled()
	})
})
