import { describe, expect, it, vi, beforeEach } from "vitest"

const mockCall = vi.fn()
vi.mock("@/utils/apiWrapper", () => ({
	call: (...args) => mockCall(...args),
}))

import { markInvoicePrinted, printInvoice } from "../printInvoice"

describe("printInvoice - Is Doc Printed handling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls mark_invoice_printed on the backend", async () => {
		mockCall.mockResolvedValue({
			success: true,
			name: "ACC-SINV-0001",
			is_doc_printed: "Yes",
		})

		const res = await markInvoicePrinted("ACC-SINV-0001")
		expect(mockCall).toHaveBeenCalledWith(
			"pos_next.api.invoices.mark_invoice_printed",
			{
				invoice_name: "ACC-SINV-0001",
			},
		)
		expect(res.is_doc_printed).toBe("Yes")
	})

	it("does not call backend when invoiceName is empty", async () => {
		const res = await markInvoicePrinted("")
		expect(mockCall).not.toHaveBeenCalled()
		expect(res).toBeNull()
	})

	it("fails printInvoice when invoiceData is invalid without marking as printed", async () => {
		await expect(printInvoice(null)).rejects.toThrow("Invalid invoice data")
		expect(mockCall).not.toHaveBeenCalled()
	})
})
