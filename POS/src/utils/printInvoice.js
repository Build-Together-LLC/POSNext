import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"

const log = logger.create('PrintInvoice')

/**
 * Print invoice using Frappe's print format system
 * @param {Object} invoiceData - The invoice document data
 * @param {string} printFormat - The print format name (optional)
 * @param {string} letterhead - The letterhead name (optional)
 * @note Use "POS Next Receipt" format for thermal printer (80mm) or configure via POS Profile
 */
export async function printInvoice(
	invoiceData,
	printFormat = null,
	letterhead = null,
) {
	try {
		if (!invoiceData || !invoiceData.name) {
			throw new Error("Invalid invoice data")
		}

		const isDraft =
			invoiceData.is_draft ||
			invoiceData.docstatus === 0 ||
			invoiceData.status === "Draft" ||
			(invoiceData.name && (invoiceData.name.startsWith("DRAFT") || invoiceData.name === "DRAFT"))

		const doctype = invoiceData.doctype || "Sales Invoice"
		const format = isDraft ? "POS Next Draft Receipt" : (printFormat || "POS Next Receipt")

		// Build PDF print URL
		const params = new URLSearchParams({
			doctype: doctype,
			name: invoiceData.name,
			format: format,
			no_letterhead: letterhead ? 0 : 1,
			_lang: "en",
			trigger_print: 1,
			_t: Date.now(), // Cache buster to force fresh print format
		})

		if (letterhead) {
			params.append("letterhead", letterhead)
		}

		// Open PDF in new window - browser will handle print dialog
		const printUrl = `/printview?${params.toString()}`
		const printWindow = window.open(printUrl, "_blank", "width=800,height=600")

		if (!printWindow) {
			throw new Error(
				"Failed to open print window. Please check your popup blocker settings.",
			)
		}

		return true
	} catch (error) {
		log.error("Error printing with Frappe print format:", error)
		// Fallback to custom print format
		return printInvoiceCustom(invoiceData)
	}
}

/**
 * Generates and prints a custom POS receipt using a thermal printer layout.
 *
 * This fallback printer is used when Frappe's standard print format is unavailable.
 * The receipt is optimized for 80mm thermal printers with clean, readable formatting.
 *
 * Receipt Structure:
 * - Header: Company name and invoice type
 * - Info: Invoice number, date, customer, payment status
 * - Items: Each item shows quantity × original price = subtotal
 * - Discounts: Displayed as separate line items with negative amounts
 * - Totals: Subtotal, tax, and grand total
 * - Payments: Payment methods and amounts, change, outstanding balance
 * - Footer: Thank you message and branding
 *
 * @param {Object} invoiceData - The invoice document data from ERPNext
 * @param {string} invoiceData.name - Invoice number
 * @param {string} invoiceData.company - Company name
 * @param {Array} invoiceData.items - Invoice line items
 * @param {Array} invoiceData.payments - Payment records
 * @param {number} invoiceData.grand_total - Invoice total amount
 */
export function printInvoiceCustom(invoiceData) {
	const isDraft =
		invoiceData.is_draft ||
		invoiceData.docstatus === 0 ||
		invoiceData.status === "Draft" ||
		(invoiceData.name && (invoiceData.name.startsWith("DRAFT") || invoiceData.name === "DRAFT"))

	if (isDraft) {
		const printWindow = window.open("", "_blank", "width=800,height=600")
		if (!printWindow) {
			log.error("Failed to open print window")
			return false
		}

		const customerName = invoiceData.customer_name || invoiceData.customer || ""
		const addressDisplay = invoiceData.address_display || invoiceData.customer_address || invoiceData.address || ""
		const customerPhone = invoiceData.phone || invoiceData.contact_phone || invoiceData.mobile_no || ""
		const customerGstin = invoiceData.tax_id || invoiceData.gstin || ""
		const invoiceNo = invoiceData.name || "DRAFT"
		const invoiceDate = invoiceData.posting_date
			? (invoiceData.posting_date.length > 10 ? invoiceData.posting_date.substring(0, 10) : invoiceData.posting_date)
			: new Date().toISOString().substring(0, 10)

		const sortedItems = [...(invoiceData.items || [])].sort((a, b) =>
			(a.item_name || "").localeCompare(b.item_name || "")
		)

		const groupedItems = {}
		for (const item of sortedItems) {
			const brand = item.brand || item.parent_brand || ""
			if (!groupedItems[brand]) {
				groupedItems[brand] = []
			}
			groupedItems[brand].push(item)
		}

		let serialCount = 0
		let itemRowsHtml = ""

		const brandKeys = Object.keys(groupedItems).sort()
		for (const brand of brandKeys) {
			const itemsInBrand = groupedItems[brand]
			itemRowsHtml += `
			<tr>
				<td colspan="5" style="text-align:left; font-size:12px;">
					<b style="padding-left:3%;">${brand}</b>
				</td>
			</tr>
			`
			for (const item of itemsInBrand) {
				serialCount++
				const rawQty = item.quantity !== undefined ? item.quantity : (item.qty !== undefined ? item.qty : 0)
				const qtyDisplay = rawQty % 1 !== 0 ? rawQty : Math.floor(rawQty)
				const itemPrice = item.price_list_rate || item.custom_mrp || item.rate || ""

				itemRowsHtml += `
				<tr>
					<td style="text-align:left; font-size:12px; border:none; word-wrap:break-word; overflow-wrap:break-word;">${serialCount}</td>
					<td style="text-align:left; font-size:12px; border:none; word-wrap:break-word; overflow-wrap:break-word;">${item.item_name || ""}</td>
					<td style="text-align:left; font-size:12px; border:none; word-wrap:break-word; overflow-wrap:break-word;">${item.item_code || ""}</td>
					<td style="text-align:left; font-size:12px; border:none; word-wrap:break-word; overflow-wrap:break-word;">${qtyDisplay}</td>
					<td style="text-align:left; font-size:12px; border-left:none; border-bottom:none; border-top:none; word-wrap:break-word; overflow-wrap:break-word;">${itemPrice}</td>
				</tr>
				`
			}
		}

		const printContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        .print-format td,
        .print-format th {
            padding: 1px !important;
            color: black !important;
        }

        table,
        th,
        td {
            margin-top: 2px;
        }

        .center-text {
            text-align: center;
        }
    </style>
</head>
<body>

<div id="header-html" class="visible-pdf">
    <p></p>
</div>

<div id="footer-html" class="visible-pdf">
    <p class="text-center small page-number visible-pdf">
        Page <span class="page"></span> of
        <span class="topage"></span>
    </p>
</div>

<div style="text-align:center; margin-bottom:5px;">
    <b style="font-size:16px;">TAX INVOICE</b>
</div>

<table border="1" cellpadding="4" cellspacing="0" style="font-size:10px; width:100%; word-wrap:break-word; overflow-x:scroll;">
    <tr style="border:1px solid black;">
        <td width="65%" style="border:none; vertical-align:top;">
            <b style="font-size:13px;">${customerName}</b>
            <p style="font-size:11px; margin:2px 0 0 0;">
                ${addressDisplay}
                ${customerPhone ? `Phone: ${customerPhone}<br>` : ""}
                ${customerGstin ? `GSTIN: ${customerGstin}` : ""}
            </p>
        </td>
        <td width="35%" style="border:none; text-align:right; vertical-align:top;">
            <b style="font-size:12px;">Invoice No: &nbsp;${invoiceNo}</b>
            <br>
            <b style="font-size:12px;">Date : &nbsp;${invoiceDate}</b>
        </td>
    </tr>
</table>

<div class="text-center" style="margin-top:5px; margin-bottom:5px; text-align: center;">
    <h4 style="margin:0px;">DRAFT</h4>
</div>

<table border="1" cellpadding="0" cellspacing="0" style="font-size:10px; width:100%; table-layout:fixed; word-wrap:break-word; overflow-wrap:break-word;">
    <thead>
        <tr style="border-bottom:1px solid black;">
            <th style="text-align:left; font-size:12px; border:none; word-wrap:break-word; overflow-wrap:break-word;" width="10%"><b>SNO.</b></th>
            <th style="text-align:left; font-size:12px; border:none; word-wrap:break-word; overflow-wrap:break-word;" width="35%"><b>ITEM NAME</b></th>
            <th style="text-align:left; font-size:12px; border:none; word-wrap:break-word; overflow-wrap:break-word;" width="20%"><b>CODE</b></th>
            <th style="text-align:left; font-size:12px; border:none; word-wrap:break-word; overflow-wrap:break-word;" width="15%"><b>QTY</b></th>
            <th style="text-align:left; font-size:12px; border-left:none; border-top:none; word-wrap:break-word; overflow-wrap:break-word;" width="20%"><b>M.R.P</b></th>
        </tr>
    </thead>
    <tbody style="font-size:12px;">
        ${itemRowsHtml}
    </tbody>
</table>

</body>
</html>`

		printWindow.document.write(printContent)
		printWindow.document.close()
		setTimeout(() => {
			printWindow.focus()
			printWindow.print()
		}, 250)
		return true
	}

	// Open print window with receipt size dimensions (80mm ≈ 302px at 96 DPI)
	const printWindow = window.open("", "_blank", "width=350,height=600")

	const printContent = `
		<!DOCTYPE html>
		<html>
		<head>
			<meta charset="UTF-8">
			<title>${__('Invoice - {0}', [invoiceData.name])}</title>
			<style>
				* {
					margin: 0;
					padding: 0;
					box-sizing: border-box;
				}

				body {
					font-family: 'Courier New', monospace;
					padding: 10px;
					width: 80mm;
					margin: 0;
					max-width: 80mm;
					font-weight: bold;
					color: black;
					-webkit-print-color-adjust: exact !important;
					print-color-adjust: exact !important;
				}

				.receipt {
					width: 100%;
				}

				.header {
					text-align: center;
					margin-bottom: 20px;
					border-bottom: 2px dashed #000;
					padding-bottom: 10px;
				}

				.company-name {
					font-size: 18px;
					font-weight: bold;
					margin-bottom: 5px;
				}

				.invoice-info {
					margin-bottom: 15px;
					font-size: 12px;
				}

				.invoice-info div {
					display: flex;
					justify-content: space-between;
					margin-bottom: 3px;
				}

				.partial-status {
					color: #000;
					font-weight: bold;
					margin-bottom: 5px;
				}

				.items-table {
					width: 100%;
					margin-bottom: 15px;
					border-top: 1px dashed #000;
					border-bottom: 1px dashed #000;
					padding: 10px 0;
				}

				.item-row {
					margin-bottom: 10px;
					font-size: 12px;
				}

				.item-name {
					font-weight: bold;
					margin-bottom: 3px;
				}

				.item-details {
					display: flex;
					justify-content: space-between;
					font-size: 11px;
					color: #000;
				}

				.item-discount {
					display: flex;
					justify-content: space-between;
					font-size: 10px;
					color: #000;
					margin-top: 2px;
				}

				.item-serials {
					font-size: 9px;
					color: #000;
					margin-top: 3px;
					padding: 3px 5px;
					background-color: #fff;
					border: 1px dashed #000;
					border-radius: 2px;
				}

				.item-serials-label {
					font-weight: bold;
					margin-bottom: 2px;
				}

				.item-serials-list {
					word-break: break-all;
				}

				.totals {
					margin-top: 15px;
					border-top: 1px dashed #000;
					padding-top: 10px;
				}

				.total-row {
					display: flex;
					justify-content: space-between;
					margin-bottom: 5px;
					font-size: 12px;
				}

				.grand-total {
					font-size: 16px;
					font-weight: bold;
					border-top: 2px solid #000;
					padding-top: 10px;
					margin-top: 10px;
				}

				.payments {
					margin-top: 15px;
					border-top: 1px dashed #000;
					padding-top: 10px;
				}

				.payment-row {
					display: flex;
					justify-content: space-between;
					margin-bottom: 3px;
					font-size: 11px;
				}

				.total-paid {
					font-weight: bold;
					border-top: 1px solid #000;
					padding-top: 5px;
					margin-top: 5px;
				}

				.outstanding-row {
					display: flex;
					justify-content: space-between;
					font-size: 13px;
					font-weight: bold;
					color: #000;
					background-color: #fff;
					border: 1px solid #000;
					padding: 8px;
					margin-top: 8px;
					border-radius: 4px;
				}

				.footer {
					text-align: center;
					margin-top: 20px;
					padding-top: 10px;
					border-top: 2px dashed #000;
					font-size: 11px;
				}

				@media print {
					@page {
						size: 80mm auto;
						margin: 0;
					}

					body {
						width: 80mm;
						padding: 5mm;
						margin: 0;
						-webkit-print-color-adjust: exact !important;
						print-color-adjust: exact !important;
					}

					.no-print {
						display: none;
					}
				}
			</style>
		</head>
		<body>
			<div class="receipt">
				<!-- Header -->
				<div class="header">
					${invoiceData.is_draft
			? `
					<div style="color: #ef4444; font-size: 18px; font-weight: 800; margin-bottom: 8px; text-transform: uppercase; text-align: center; border: 2px solid #ef4444; padding: 4px; border-radius: 4px; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important;">
						${__('DRAFT')}
					</div>
					`
			: ""
		}
					<div class="company-name">${invoiceData.company || "POS Next"}</div>
					<div style="font-size: 12px;">${__('TAX INVOICE')}</div>
				</div>

				<!-- Invoice Info -->
				<div class="invoice-info">
					<div>
						<span>${__('Invoice #:')}</span>
						<span><strong>${invoiceData.name}</strong></span>
					</div>
					<div>
						<span>${__('Date:')}</span>
						<span>${new Date(invoiceData.posting_date || Date.now()).toLocaleString()}</span>
					</div>
					${invoiceData.customer_name
			? `
					<div>
						<span>${__('Customer:')}</span>
						<span>${invoiceData.customer_name}</span>
					</div>
					`
			: ""
		}
					${(invoiceData.status === "Partly Paid" || (invoiceData.outstanding_amount && invoiceData.outstanding_amount > 0 && invoiceData.outstanding_amount < invoiceData.grand_total))
			? `
					<div class="partial-status">
						<span>${__('Status:')}</span>
						<span>${__('PARTIAL PAYMENT')}</span>
					</div>
					`
			: ""
		}
				</div>

				<!-- Items -->
				<div class="items-table">
					${invoiceData.items
			.map((item) => {
				// Determine if item has promotional pricing
				const hasItemDiscount =
					(item.discount_percentage &&
						Number.parseFloat(item.discount_percentage) > 0) ||
					(item.discount_amount &&
						Number.parseFloat(item.discount_amount) > 0)
				const isFree = item.is_free_item
				const qty = item.quantity || item.qty

				// Display original list price for transparency
				const displayRate = item.price_list_rate || item.rate
				// Calculate subtotal before any price reductions
				const subtotal = qty * displayRate

				return `
						<div class="item-row">
							<div class="item-name">
								${item.item_name || item.item_code} ${isFree ? __('(FREE)') : ""}
							</div>
							<div class="item-details">
								<span>${qty} × ${formatCurrency(displayRate)}</span>
								<span><strong>${formatCurrency(subtotal)}</strong></span>
							</div>
							${hasItemDiscount
						? `
							<div class="item-discount">
								<span>Discount ${item.discount_percentage ? `(${Number(item.discount_percentage).toFixed(2)}%)` : ""}</span>
								<span>-${formatCurrency(item.discount_amount || 0)}</span>
							</div>
							`
						: ""
					}
							${item.serial_no
						? `
							<div class="item-serials">
								<div class="item-serials-label">${__('Serial No:')}</div>
								<div class="item-serials-list">${item.serial_no.replace(/\n/g, ', ')}</div>
							</div>
							`
						: ""
					}
						</div>
						`
			})
			.join("")}
				</div>

				<!-- Totals -->
				<div class="totals">
					${invoiceData.total_taxes_and_charges &&
			invoiceData.total_taxes_and_charges > 0
			? `
					<div class="total-row">
						<span>${__('Subtotal:')}</span>
						<span>${formatCurrency((invoiceData.grand_total || 0) - (invoiceData.total_taxes_and_charges || 0))}</span>
					</div>
					<div class="total-row">
						<span>${__('Tax:')}</span>
						<span>${formatCurrency(invoiceData.total_taxes_and_charges)}</span>
					</div>
					`
			: ""
		}
					${invoiceData.discount_amount
			? `
					<div class="total-row" style="color: #28a745;">
						<span>Additional Discount${invoiceData.additional_discount_percentage ? ` (${Number(invoiceData.additional_discount_percentage).toFixed(1)}%)` : ""}:</span>
						<span>-${formatCurrency(Math.abs(invoiceData.discount_amount))}</span>
					</div>
					`
			: ""
		}
					<div class="total-row grand-total">
						<span>${__('TOTAL:')}</span>
						<span>${formatCurrency(invoiceData.grand_total)}</span>
					</div>
				</div>

				<!-- Payments -->
				${invoiceData.payments && invoiceData.payments.length > 0
			? `
				<div class="payments">
					<div style="font-weight: bold; margin-bottom: 5px; font-size: 12px;">Payments:</div>
					${invoiceData.payments
				.map(
					(payment) => `
						<div class="payment-row">
							<span>${payment.mode_of_payment}:</span>
							<span>${formatCurrency(payment.amount)}</span>
						</div>
					`,
				)
				.join("")}
					<div class="payment-row total-paid">
						<span>${__('Total Paid:')}</span>
						<span>${formatCurrency(invoiceData.paid_amount || 0)}</span>
					</div>
					${invoiceData.change_amount && invoiceData.change_amount > 0
				? `
					<div class="payment-row" style="font-weight: bold; margin-top: 5px;">
						<span>${__('Change:')}</span>
						<span>${formatCurrency(invoiceData.change_amount)}</span>
					</div>
					`
				: ""
			}
					${invoiceData.outstanding_amount && invoiceData.outstanding_amount > 0
				? `
					<div class="outstanding-row">
						<span>${__('BALANCE DUE:')}</span>
						<span>${formatCurrency(invoiceData.outstanding_amount)}</span>
					</div>
					`
				: ""
			}
				</div>
				`
			: ""
		}

				<!-- Footer -->
				<div class="footer">
					<div style="margin-bottom: 5px;">${__('Thank you for your business!')}</div>
					<div style="font-size: 10px;">Powered by <a href="https://nexus.brainwise.me" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 600;">BrainWise</a></div>
				</div>
			</div>

			<div class="no-print" style="text-align: center; margin-top: 20px;">
				<button onclick="window.print()" style="padding: 10px 20px; font-size: 14px; cursor: pointer;">
					${__('Print Receipt')}
				</button>
				<button onclick="window.close()" style="padding: 10px 20px; font-size: 14px; cursor: pointer; margin-left: 10px;">
					${__('Close')}
				</button>
			</div>
		</body>
		</html>
	`

	printWindow.document.write(printContent)
	printWindow.document.close()

	setTimeout(() => {
		printWindow.focus()
		printWindow.print()
	}, 250)
}

function formatCurrency(amount) {
	return Number.parseFloat(amount || 0).toFixed(2)
}

/**
 * Print invoice by name, fetching print format from POS Profile
 * @param {string} invoiceName - The name of the invoice to print
 * @param {string} printFormat - Optional print format override
 * @param {string} letterhead - Optional letterhead override
 */
export async function printInvoiceByName(
	invoiceName,
	printFormat = null,
	letterhead = null,
) {
	try {
		// Fetch the invoice document using proper POS API endpoint
		const invoiceDoc = await call("pos_next.api.invoices.get_invoice", {
			invoice_name: invoiceName,
		})

		if (!invoiceDoc) {
			throw new Error("Invoice not found")
		}

		const isDraft =
			invoiceDoc.is_draft ||
			invoiceDoc.docstatus === 0 ||
			invoiceDoc.status === "Draft" ||
			(invoiceDoc.name && (invoiceDoc.name.startsWith("DRAFT") || invoiceDoc.name === "DRAFT"))

		// If no print format specified and invoice has a POS Profile, fetch its print settings
		if (!printFormat && invoiceDoc.pos_profile && !isDraft) {
			try {
				const posProfileDoc = await call("frappe.client.get", {
					doctype: "POS Profile",
					name: invoiceDoc.pos_profile,
				})

				if (posProfileDoc) {
					printFormat = posProfileDoc.print_format
					letterhead = letterhead || posProfileDoc.letter_head
				}
			} catch (error) {
				log.warn("Could not fetch POS Profile print settings:", error)
				// Continue with default print format
			}
		}

		if (isDraft) {
			printFormat = "POS Next Draft Receipt"
		}

		// Print the invoice
		return await printInvoice(invoiceDoc, printFormat, letterhead)
	} catch (error) {
		log.error("Error fetching invoice for print:", error)
		throw error
	}
}
