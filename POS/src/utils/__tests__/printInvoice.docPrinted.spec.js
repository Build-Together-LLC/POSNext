import { describe, expect, it, vi, beforeEach } from "vitest"

const mockCall = vi.fn()
vi.mock("@/utils/apiWrapper", () => ({
	call: (...args) => mockCall(...args),
}))

import { markInvoicePrinted, printInvoice, markDraftPrinted } from "../printInvoice"

describe("printInvoice - Is Doc Printed handling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls mark_invoice_printed on the backend", async () => {
		mockCall.mockResolvedValue({
			success: true,
			name: "ACC-SINV-0001",
			is_doc_printed: "Yes",
			doc_print_count: 1,
		})

		const res = await markInvoicePrinted("ACC-SINV-0001")
		expect(mockCall).toHaveBeenCalledWith(
			"pos_next.api.invoices.mark_invoice_printed",
			{
				invoice_name: "ACC-SINV-0001",
			},
		)
		expect(res.is_doc_printed).toBe("Yes")
		expect(res.doc_print_count).toBe(1)
	})

	it("does not call backend when invoiceName is empty and returns failure", async () => {
		const res = await markInvoicePrinted("")
		expect(mockCall).not.toHaveBeenCalled()
		expect(res.success).toBe(false)
	})

	it("returns failure when backend call rejects", async () => {
		mockCall.mockRejectedValue(new Error("Server timeout"))
		const res = await markInvoicePrinted("ACC-SINV-0001")
		expect(res.success).toBe(false)
		expect(res.error).toBe("Server timeout")
	})

	it("returns failure when backend returns success: false", async () => {
		mockCall.mockResolvedValue({ success: false, error: "Permission denied" })
		const res = await markInvoicePrinted("ACC-SINV-0001")
		expect(res.success).toBe(false)
		expect(res.error).toBe("Permission denied")
	})

	it("fails printInvoice when invoiceData is invalid without marking as printed", async () => {
		await expect(printInvoice(null)).rejects.toThrow("Invalid invoice data")
		expect(mockCall).not.toHaveBeenCalled()
	})

	it("calls mark_draft_printed on backend for server draft and increments count", async () => {
		mockCall.mockResolvedValue({
			success: true,
			name: "DRAFT-0001",
			is_draft_printed: "Yes",
			draft_print_count: 2,
		})

		const draft = {
			draft_id: "DRAFT-0001",
			server_draft: true,
			invoice_name: "DRAFT-0001",
			is_draft_printed: "Yes",
			draft_print_count: 1,
		}

		const res = await markDraftPrinted(draft)
		expect(mockCall).toHaveBeenCalledWith(
			"pos_next.api.invoices.mark_draft_printed",
			{
				invoice_name: "DRAFT-0001",
				draft_id: "DRAFT-0001",
			},
		)
		expect(res.success).toBe(true)
		expect(res.is_draft_printed).toBe("Yes")
		expect(draft.draft_print_count).toBe(2)
	})

	it("marks local draft as printed with incremented count", async () => {
		const localDraft = {
			draft_id: "271126123456",
			is_draft_printed: "No",
			draft_print_count: 0,
		}

		const res = await markDraftPrinted(localDraft)
		expect(res.success).toBe(true)
		expect(res.is_draft_printed).toBe("Yes")
		expect(localDraft.is_draft_printed).toBe("Yes")
		expect(localDraft.draft_print_count).toBe(1)
	})
})
