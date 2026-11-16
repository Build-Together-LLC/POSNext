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

const mockShowWarning = vi.fn()
const mockShowError = vi.fn()
const mockShowSuccess = vi.fn()

vi.mock("@/composables/useToast", () => ({
	useToast: () => ({
		showWarning: mockShowWarning,
		showError: mockShowError,
		showSuccess: mockShowSuccess,
	}),
}))

const mockPrintWithProfile = vi.fn()
const mockPrintByName = vi.fn()
const mockMarkPrinted = vi.fn()

vi.mock("@/utils/printInvoice", () => ({
	printInvoiceWithProfileFormat: (...args) => mockPrintWithProfile(...args),
	printInvoiceByName: (...args) => mockPrintByName(...args),
	markInvoicePrinted: (...args) => mockMarkPrinted(...args),
}))

vi.mock("@/utils/offline", () => ({
	isOffline: () => false,
	offlineEvents: { on: vi.fn(), off: vi.fn() },
}))

vi.mock("@/utils/offline/workerClient", () => ({
	offlineWorker: {
		getCustomers: vi.fn(),
		getItems: vi.fn(),
		updateStockQuantities: vi.fn(),
		getOfflineInvoiceCount: vi.fn().mockResolvedValue(0),
	},
}))

vi.mock("@/composables/useRealtimeStock", () => ({
	useRealtimeStock: () => ({
		onStockUpdate: vi.fn(() => vi.fn()),
	}),
}))

vi.mock("@/composables/usePOSEvents", () => ({
	usePOSEvents: () => ({
		onWarehouseChanged: vi.fn(() => vi.fn()),
		onPricingChanged: vi.fn(() => vi.fn()),
		onStockPolicyChanged: vi.fn(() => vi.fn()),
		onSettingsChanged: vi.fn(() => vi.fn()),
		onSalesOperationsChanged: vi.fn(() => vi.fn()),
		onDisplayChanged: vi.fn(() => vi.fn()),
		onStockSyncConfigured: vi.fn(() => vi.fn()),
		onStockSyncUpdate: vi.fn(() => vi.fn()),
		on: vi.fn(() => vi.fn()),
		emit: vi.fn(),
	}),
}))

vi.mock("@/composables/useLocale", () => ({
	useLocale: () => ({
		currency: "USD",
		formatCurrency: (v) => `$${v}`,
	}),
}))

vi.mock("@/data/session", () => ({
	session: {
		user: "Administrator",
		logout: { loading: false, submit: vi.fn() },
	},
}))

vi.mock("@/utils/draftManager", () => ({
	getAllDrafts: vi.fn().mockResolvedValue([]),
	initDB: vi.fn().mockResolvedValue(true),
}))

vi.mock("@/data/user", () => ({
	useUserData: () => ({
		user: { name: "Administrator" },
	}),
}))

vi.mock("@/utils/apiWrapper", () => ({
	call: vi.fn().mockResolvedValue([]),
}))

vi.mock("frappe-ui", () => ({
	Button: { template: "<button><slot /></button>" },
	Dialog: {
		props: ["modelValue"],
		template: '<div v-if="modelValue"><slot /></div>',
	},
	createResource: () => ({
		submit: vi.fn(),
		reload: vi.fn(),
		fetch: vi.fn(),
		data: null,
		loading: false,
	}),
}))

import { shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import POSSale from "@/pages/POSSale.vue"

describe("POSSale - handlePrintInvoice", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		vi.clearAllMocks()
	})

	function mountPOSSale() {
		return shallowMount(POSSale, {
			global: {
				config: {
					globalProperties: {
						__: translate,
					},
				},
				mocks: {
					__: translate,
				},
				stubs: {
					ShiftClosingDialog: true,
					ShiftOpeningDialog: true,
					ClearCacheOverlay: true,
					LoadingSpinner: true,
					POSFooter: true,
					ManagementSlider: true,
					POSHeader: true,
					BatchSerialDialog: true,
					CouponDialog: true,
					CreateCustomerDialog: true,
					CustomerDialog: true,
					DraftInvoicesDialog: true,
					InvoiceCart: true,
					InvoiceHistoryDialog: true,
					ItemSelectionDialog: true,
					ItemsSelector: true,
					OffersDialog: true,
					OrderLossConfirmDialog: true,
					OrderLossDialog: true,
					UnlistedItemDialog: true,
					OfflineInvoicesDialog: true,
					PaymentDialog: true,
					PromotionManagement: true,
					ReturnInvoiceDialog: true,
					WarehouseAvailabilityDialog: true,
					POSSettings: true,
					InvoiceManagement: true,
					InvoiceDetailDialog: true,
					POSReportsDialog: true,
				},
			},
		})
	}

	it("success path: marks printed and updates status to Yes when print and server save succeed", async () => {
		mockPrintWithProfile.mockResolvedValue(true)
		mockMarkPrinted.mockResolvedValue({ success: true, is_doc_printed: "Yes" })

		const wrapper = mountPOSSale()
		const invoice = {
			name: "ACC-SINV-2026-00001",
			items: [{ item_code: "ITEM-A" }],
			is_doc_printed: "No",
		}
		const callback = vi.fn()

		await wrapper.vm.handlePrintInvoice(invoice, callback)

		expect(mockPrintWithProfile).toHaveBeenCalledWith(invoice)
		expect(mockMarkPrinted).toHaveBeenCalledWith("ACC-SINV-2026-00001")
		expect(invoice.is_doc_printed).toBe("Yes")
		expect(callback).toHaveBeenCalledTimes(1)
		expect(mockShowWarning).not.toHaveBeenCalled()
	})

	it("failure path: does not mark as Yes and shows warning when server save fails", async () => {
		mockPrintWithProfile.mockResolvedValue(true)
		mockMarkPrinted.mockResolvedValue({ success: false, error: "Network error" })

		const wrapper = mountPOSSale()
		const invoice = {
			name: "ACC-SINV-2026-00001",
			items: [{ item_code: "ITEM-A" }],
			is_doc_printed: "No",
		}
		const callback = vi.fn()

		await wrapper.vm.handlePrintInvoice(invoice, callback)

		expect(mockPrintWithProfile).toHaveBeenCalledWith(invoice)
		expect(mockMarkPrinted).toHaveBeenCalledWith("ACC-SINV-2026-00001")
		// Status must remain "No" on failure
		expect(invoice.is_doc_printed).toBe("No")
		// Callback must not be executed
		expect(callback).not.toHaveBeenCalled()
		// Small warning must be shown
		expect(mockShowWarning).toHaveBeenCalledWith(
			"Invoice printed, but failed to update printed status on server.",
		)
	})

	it("failure path: does not call markInvoicePrinted if printing itself fails", async () => {
		mockPrintWithProfile.mockResolvedValue(false)

		const wrapper = mountPOSSale()
		const invoice = {
			name: "ACC-SINV-2026-00001",
			items: [{ item_code: "ITEM-A" }],
			is_doc_printed: "No",
		}
		const callback = vi.fn()

		await wrapper.vm.handlePrintInvoice(invoice, callback)

		expect(mockPrintWithProfile).toHaveBeenCalledWith(invoice)
		expect(mockMarkPrinted).not.toHaveBeenCalled()
		expect(invoice.is_doc_printed).toBe("No")
		expect(callback).not.toHaveBeenCalled()
		expect(mockShowWarning).not.toHaveBeenCalled()
	})
})
