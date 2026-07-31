// Server-side draft (held) invoice management.
//
// Mirrors the interface of utils/draftManager.js (the IndexedDB backend) so the
// drafts store can swap between the two based on the POS Setting
// "Allow Server Side Draft Invoice". Here a draft is a real Sales Invoice with
// docstatus=0, so it survives a cache clear, another device or another cashier,
// and it can be read, updated, deleted and submitted like any other invoice.
import { call } from "frappe-ui"

/**
 * Hold the cart as a server draft.
 *
 * @param {Object} invoiceData - Sales Invoice payload (see buildInvoicePayload
 *   in composables/useInvoice.js). Pass `name` to update an existing draft.
 * @returns {Promise<Object>} The saved draft in cart shape.
 */
export async function saveServerDraft(invoiceData) {
	return await call("pos_next.api.invoices.save_pos_draft", {
		data: JSON.stringify(invoiceData),
	})
}

/**
 * Update an existing server draft.
 *
 * @param {string} draftId - Sales Invoice name of the held draft.
 * @param {Object} invoiceData - Full replacement payload for the draft.
 */
export async function updateServerDraft(draftId, invoiceData) {
	return await saveServerDraft({ ...invoiceData, name: draftId })
}

/**
 * List held drafts for a POS Profile, newest first.
 *
 * Rows are summaries - customer, timestamp, total and lightweight item lines
 * (code, name, qty, rate, amount) for the dialog to render. Use
 * getServerDraftById before resuming or printing one.
 *
 * @param {string} posProfile
 * @param {string|null} posOpeningShift - Optional; omit to include drafts held
 *   during an earlier shift.
 */
export async function getAllServerDrafts(posProfile, posOpeningShift = null) {
	const drafts = await call("pos_next.api.invoices.get_pos_drafts", {
		pos_profile: posProfile,
		pos_opening_shift: posOpeningShift,
	})

	return Array.isArray(drafts) ? drafts : []
}

/** Read a single held draft in cart shape. */
export async function getServerDraftById(draftId) {
	return await call("pos_next.api.invoices.get_pos_draft", {
		invoice_name: draftId,
	})
}

/** Delete a single held draft. */
export async function deleteServerDraft(draftId) {
	await call("pos_next.api.invoices.delete_pos_draft", {
		invoice_name: draftId,
	})

	return true
}

/**
 * Delete the held drafts for the profile that this user is allowed to clear.
 *
 * Drafts parked by other cashiers are kept unless the user holds a manager role
 * (see delete_all_pos_drafts) - `skipped` counts the ones left in place.
 *
 * @returns {Promise<{deleted: string[], failed: string[], skipped: number}>}
 */
export async function clearAllServerDrafts(posProfile, posOpeningShift = null) {
	const result = await call("pos_next.api.invoices.delete_all_pos_drafts", {
		pos_profile: posProfile,
		pos_opening_shift: posOpeningShift,
	})

	return { deleted: [], failed: [], skipped: 0, ...(result || {}) }
}
