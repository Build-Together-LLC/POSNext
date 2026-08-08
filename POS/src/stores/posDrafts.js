import {
	clearAllDrafts,
	deleteDraft,
	getAllDrafts,
	getDraftById,
	saveDraft,
	updateDraft,
} from "@/utils/draftManager"
import { getOfflineInvoices } from "@/utils/offline/sync"
import {
	clearAllServerDrafts,
	deleteServerDraft,
	getAllServerDrafts,
	getServerDraftById,
	getServerDraftStates,
	saveServerDraft,
} from "@/utils/serverDraftManager"
import { isOffline } from "@/utils/offline"
import { offlineState } from "@/utils/offline/offlineState"
import { useToast } from "@/composables/useToast"
import { usePOSCartStore } from "@/stores/posCart"
import { usePOSOffersStore } from "@/stores/posOffers"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { defineStore } from "pinia"
import { computed, ref } from "vue"

/**
 * Held (draft) invoices, in whichever backend the profile is configured for.
 *
 * Two backends exist and both stay readable at all times:
 *   - server: the hold is a real Sales Invoice with docstatus=0
 *   - cache:  the hold lives in IndexedDB on this device
 *
 * "Allow Server Side Draft Invoice" (POS Settings) decides where a *new* hold is
 * written; it never migrates the holds already parked in the other backend, so
 * flipping it mid-shift leaves nothing stranded. A cached draft that came from a
 * server draft keeps the invoice name in `invoice_name` - the cart binds to it
 * (cartStore.heldInvoiceName) so checkout updates and submits that same Sales
 * Invoice instead of raising a duplicate.
 */
export const usePOSDraftsStore = defineStore("posDrafts", () => {
	// Use custom toast
	const { showSuccess, showError, showWarning } = useToast()

	const settingsStore = usePOSSettingsStore()
	const cartStore = usePOSCartStore()
	const offersStore = usePOSOffersStore()

	// State
	const draftsCount = ref(0)
	const drafts = ref([])
	// Cached drafts the server kept rejecting; surfaced so the UI can offer
	// retryFailedDrafts() instead of leaving them silently stuck.
	const failedDraftsCount = ref(0)

	// Reconnect can fire more than once - keep one flush running at a time.
	let flushingOfflineDrafts = false
	let attemptedStartupFlush = false

	const useServerDrafts = computed(() =>
		Boolean(settingsStore.allowServerSideDraftInvoice),
	)

	function isServerDraft(draft) {
		return Boolean(draft?.server_draft)
	}

	function boundInvoiceName(draft) {
		return draft?.invoice_name || null
	}

	/** Find the draft object behind a draft_id coming from a list/dialog. */
	function resolveDraft(draftOrId) {
		if (draftOrId && typeof draftOrId === "object") return draftOrId

		return drafts.value.find((d) => d.draft_id === draftOrId) || null
	}

	/**
	 * Same, but falls back to IndexedDB when the id is not in the loaded list.
	 *
	 * Callers that act on a draft_id alone - deleting, or clearing the hold a sale
	 * came from - can run before the list has ever loaded, and guessing the
	 * backend from the setting is wrong: the setting says where the *next* hold
	 * goes, not where this one lives. IndexedDB answers that definitively, so a
	 * miss here means the id belongs to a server draft (or to nothing at all).
	 *
	 * @returns {Promise<Object|null>}
	 */
	async function resolveDraftDeep(draftOrId) {
		const known = resolveDraft(draftOrId)
		if (known) return known

		const draftId =
			typeof draftOrId === "string" ? draftOrId : draftOrId?.draft_id
		if (!draftId) return null

		return (await getDraftById(draftId).catch(() => null)) || null
	}

	function buildAppliedOffersFromRules(ruleNames = []) {
		if (!Array.isArray(ruleNames) || ruleNames.length === 0) return []

		return ruleNames.map((code) => {
			const offer = offersStore.availableOffers.find((o) => o.name === code)

			return {
				name: offer?.title || offer?.name || code,
				code,
				offer: offer || null,
				source: "manual",
				applied: true,
				rules: [code],
				min_qty: offer?.min_qty,
				max_qty: offer?.max_qty,
				min_amt: offer?.min_amt,
				max_amt: offer?.max_amt,
			}
		})
	}

	/**
	 * Newest held first - the same ordering get_pos_drafts applies server-side.
	 * Still needed here because server drafts and browser drafts arrive as two
	 * lists and have to be interleaved.
	 */
	function sortByCreatedDesc(list) {
		return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
	}

	/**
	 * Which backend this hold goes to: the server, or IndexedDB.
	 *
	 * Reads the settings store rather than re-fetching, so a hold costs one round
	 * trip. The store is loaded at boot and rewritten in place when the setting is
	 * saved (POSSettings.vue), so it is already current; the fetch below is only
	 * for the case where it never loaded at all.
	 */
	async function resolveServerDraftMode() {
		if (isOffline()) return false

		if (!settingsStore.isLoaded) {
			// reloadSettings() needs the profile; it is missing only if the settings
			// store never loaded, in which case the cart still knows it.
			if (!settingsStore.settings.pos_profile && cartStore.posProfile) {
				settingsStore.settings.pos_profile = cartStore.posProfile
			}

			try {
				await settingsStore.reloadSettings()
			} catch (error) {
				// Fall back to the last known value rather than blocking the hold.
				console.error("Error loading POS Settings before hold:", error)
			}
		}

		return useServerDrafts.value
	}

	/**
	 * Reconcile cached drafts that are bound to a Sales Invoice.
	 *
	 * A cached draft carries `invoice_name` when the sale started life as a server
	 * draft (the setting was on, then turned off) or when it was checked out while
	 * offline. That invoice can move on without this device knowing:
	 *
	 *   - submitted (docstatus 1): the sale is booked - somewhere else, or by this
	 *     device's own offline queue on sync - so the hold is spent and is dropped.
	 *   - cancelled, or deleted: there is nothing left to update, so the hold is
	 *     unbound and behaves like any other cached draft - checkout raises a new
	 *     invoice from it.
	 *
	 * Costs one query, and only when a bound cached draft actually exists.
	 *
	 * @returns {Promise<Object[]>} The cached drafts that are still usable.
	 */
	async function pruneBoundDrafts(localDrafts) {
		const boundNames = [
			...new Set(localDrafts.map(boundInvoiceName).filter(Boolean)),
		]

		if (boundNames.length === 0 || isOffline()) return localDrafts

		let states
		try {
			states = await getServerDraftStates(boundNames)
		} catch (error) {
			// Leave the drafts exactly as they are; this runs again on every load.
			console.error("Error checking bound draft invoices:", error)
			return localDrafts
		}

		const kept = []
		for (const draft of localDrafts) {
			const bound = boundInvoiceName(draft)
			const docstatus = bound ? states[bound] : 0

			if (!bound || docstatus === 0) {
				kept.push(draft)
				continue
			}

			if (docstatus === 1) {
				await deleteDraft(draft.draft_id).catch(() => {})
				continue
			}

			// Cancelled or gone - keep the cart, drop the dead binding.
			await updateDraft(draft.draft_id, { invoice_name: null }).catch(() => {})
			kept.push({ ...draft, invoice_name: null })
		}

		return kept
	}

	/**
	 * Invoice names that a queued offline payment is already going to submit.
	 *
	 * Paying a held invoice while offline only queues the sale (see
	 * handlePaymentCompleted in pages/POSSale.vue, which stamps the held invoice
	 * name onto the queued payload), so the Sales Invoice is still a draft on the
	 * server until the queue syncs.
	 *
	 * @returns {Promise<Set<string>>}
	 */
	async function paidOfflineInvoiceNames() {
		try {
			const pending = await getOfflineInvoices()

			return new Set(pending.map((entry) => entry?.data?.name).filter(Boolean))
		} catch (error) {
			console.error("Error reading queued offline invoices:", error)
			return new Set()
		}
	}

	// Actions
	async function updateDraftsCount() {
		try {
			await loadDrafts()
		} catch (error) {
			console.error("Error getting drafts count:", error)
		}
	}

	async function loadDrafts() {
		try {
			const [cachedDrafts, serverDrafts] = await Promise.all([
				getAllDrafts().catch((error) => {
					console.error("Error loading cached drafts:", error)
					return []
				}),
				!isOffline() && cartStore.posProfile
					? getAllServerDrafts(cartStore.posProfile).catch((error) => {
							console.error("Error loading server drafts:", error)
							return []
						})
					: [],
			])

			const localDrafts = await pruneBoundDrafts(cachedDrafts)

			// A hold that has already been paid into the offline queue is spent: the
			// sale is captured and waiting to submit, so re-selling that ticket at
			// this till would double-charge the customer. Hide it - in whichever
			// backend it lives - until the queue drains. Deleting the queued invoice
			// brings it back.
			const paidOffline = await paidOfflineInvoiceNames()
			const visibleLocal = localDrafts.filter(
				(d) => !paidOffline.has(boundInvoiceName(d)),
			)

			// A cached draft bound to a server draft is the newer copy of the same
			// sale - list it once, from the cache.
			const claimed = new Set(localDrafts.map(boundInvoiceName).filter(Boolean))
			for (const name of paidOffline) claimed.add(name)

			drafts.value = sortByCreatedDesc([
				...serverDrafts.filter((d) => !claimed.has(d.invoice_name)),
				...visibleLocal,
			])
			draftsCount.value = drafts.value.length
			failedDraftsCount.value = visibleLocal.filter((d) => d.sync_failed).length

			// The reconnect subscription only fires on an offline -> online
			// transition, so an app restarted online with holds still in IndexedDB
			// would never flush them. Try once per session; the flush re-enters
			// loadDrafts, which the in-progress guard turns into a no-op.
			// A new session is a natural retry point, so this pass also picks up
			// the drafts that gave up earlier - otherwise a draft that failed once
			// would sit on the device forever.
			if (!attemptedStartupFlush && !isOffline() && localDrafts.length > 0) {
				attemptedStartupFlush = true
				flushOfflineDrafts({ includeFailed: true }).catch((error) =>
					console.error("Error flushing offline drafts on startup:", error),
				)
			}
		} catch (error) {
			console.error("Error loading drafts:", error)
		}
	}

	/**
	 * Hold the current cart.
	 *
	 * The setting decides the backend every time, including when re-holding a sale
	 * that was resumed from the other one:
	 *
	 *   - setting on, online: written as a Sales Invoice draft. A sale resumed from
	 *     the cache is promoted, and its cached copy removed.
	 *   - setting off, or offline: written to IndexedDB. A sale resumed from a
	 *     server draft keeps that invoice in `invoice_name`, so checkout updates
	 *     and submits it rather than raising a second invoice for the same cart.
	 */
	async function saveDraftInvoice(
		invoiceItems,
		customer,
		posProfile,
		appliedOffers = [],
		draftId = null,
	) {
		if (invoiceItems.length === 0) {
			showWarning(__("Cannot save an empty cart as draft"))
			return null
		}

		const toServer = await resolveServerDraftMode()

		if (useServerDrafts.value && isOffline()) {
			showWarning(
				__(
					"Offline - holding this invoice on this device until the connection is back",
				),
			)
		}

		// Deep resolve: missing this would re-hold as a new cached draft instead
		// of updating the one being resumed, leaving two copies of the sale.
		const existing = draftId ? await resolveDraftDeep(draftId) : null
		const existingIsServer = existing ? isServerDraft(existing) : false
		const boundInvoice =
			cartStore.heldInvoiceName ||
			boundInvoiceName(existing) ||
			(existingIsServer ? draftId : null)

		try {
			let savedDraft

			if (toServer) {
				const payload = cartStore.buildInvoicePayload({
					includePayments: false,
				})

				// Update the bound Sales Invoice rather than holding a duplicate.
				if (boundInvoice) {
					payload.name = boundInvoice
				}

				savedDraft = await saveServerDraft(payload)

				// Promoted out of the cache - drop the copy left behind. Keyed off
				// `existing`, not `draftId`: an id that resolved to nothing is a
				// server draft, and there is no cached copy to remove.
				if (existing && !existingIsServer) {
					await deleteDraft(existing.draft_id).catch(() => {})
				}
			} else {
				const draftData = {
					pos_profile: posProfile,
					// The shift this was parked in, so promoting it later reports
					// against that shift rather than whichever one is open then.
					pos_opening_shift: cartStore.posOpeningShift,
					customer: customer,
					items: invoiceItems,
					applied_offers: appliedOffers, // Save applied offers
					// Cart-level values live outside the item rows - keep them so
					// resuming (and promoting an offline hold) restores the same sale.
					additional_discount: cartStore.additionalDiscount || 0,
					coupon_code: cartStore.couponCode || null,
					// Null unless this cart came from a server draft.
					invoice_name: boundInvoice,
					// A fresh hold is not a failed sync - clear any earlier verdict.
					sync_retry_count: 0,
					sync_failed: false,
					sync_error: null,
				}

				// Resuming a server draft into the cache creates a new cached entry:
				// draftId is that invoice's name, not a cached draft key.
				savedDraft =
					existing && !existingIsServer
						? await updateDraft(existing.draft_id, draftData)
						: await saveDraft(draftData)
			}

			await loadDrafts() // Refresh drafts list and count

			showSuccess(__("Invoice saved as draft successfully"))

			return savedDraft
		} catch (error) {
			console.error("Error saving draft:", error)
			showError(__("Failed to save draft"))
			return null
		}
	}

	async function loadDraft(draft) {
		try {
			const source = isServerDraft(draft)
				? await getServerDraftById(draft.invoice_name || draft.draft_id)
				: draft

			showSuccess(__("Draft invoice loaded successfully"))

			return {
				items: source.items || [],
				customer: source.customer,
				applied_offers: isServerDraft(source)
					? buildAppliedOffersFromRules(source.applied_pricing_rules)
					: source.applied_offers || [], // Restore applied offers
				invoice_name: boundInvoiceName(source),
				additional_discount: source.additional_discount || 0,
				coupon_code: source.coupon_code || null,
			}
		} catch (error) {
			console.error("Error loading draft:", error)
			showError(__("Failed to load draft"))
			throw error
		}
	}

	/**
	 * Sales Invoice payload for a draft held in the browser.
	 *
	 * Mirrors buildInvoicePayload (composables/useInvoice.js), which builds the
	 * same shape from the live cart - this one works from a stored draft, so an
	 * offline hold can be pushed to the server without loading it into the cart
	 * first.
	 *
	 * @param {Object} draft - Draft as stored by utils/draftManager.
	 */
	function buildServerPayloadFromDraft(draft) {
		const items = draft.items || []
		// Profile-level, so the cart's current mode is the right one to apply.
		const taxInclusive = cartStore.taxInclusive

		const payload = {
			doctype: "Sales Invoice",
			pos_profile: draft.pos_profile || cartStore.posProfile,
			posa_pos_opening_shift:
				draft.pos_opening_shift || cartStore.posOpeningShift,
			customer: draft.customer?.name || draft.customer,
			items: items.map((item) => {
				const qty = item.quantity || item.qty || 1
				const priceListRate = item.price_list_rate || item.rate || 0

				return {
					item_code: item.item_code,
					item_name: item.item_name,
					qty,
					// Same rate rules as the cart: gross when tax is included in the
					// price, net otherwise (see buildInvoicePayload).
					rate: taxInclusive
						? priceListRate - (item.discount_amount || 0) / qty
						: item.amount
							? item.amount / qty
							: item.rate,
					price_list_rate: priceListRate,
					uom: item.uom,
					warehouse: item.warehouse,
					batch_no: item.batch_no,
					serial_no: item.serial_no,
					conversion_factor: item.conversion_factor || 1,
					discount_percentage: item.discount_percentage || 0,
					discount_amount: item.discount_amount || 0,
				}
			}),
			// A hold is never paid - payment is captured when it is resumed.
			payments: [],
			discount_amount: draft.additional_discount || 0,
			coupon_code: draft.coupon_code || null,
			is_pos: 1,
			update_stock: 1,
			applied_pricing_rules: items.map((item) =>
				Array.isArray(item.pricing_rules)
					? item.pricing_rules.filter(Boolean)
					: [],
			),
		}

		// Re-hold against the same invoice when this draft came from one.
		if (draft.invoice_name) {
			payload.name = draft.invoice_name
		}

		return payload
	}

	/**
	 * Push drafts held in the browser up to the server.
	 *
	 * Holding falls back to IndexedDB whenever the connection is down (see
	 * saveDraftInvoice), and the offline invoice queue only carries submitted
	 * sales - so without this those holds would stay on one device. Once the
	 * server is the configured backend and the connection is back, each cached
	 * draft is re-held as a Sales Invoice and the local copy dropped; a draft that
	 * is already bound to one updates it in place.
	 *
	 * Anything that fails is left in IndexedDB and retried on the next reconnect.
	 *
	 * @param {Object} [options]
	 * @param {boolean} [options.includeFailed=false] - Also retry the drafts that
	 *   have already exhausted their attempts (see sync_failed below). Reconnect
	 *   flushes leave those alone so a permanently broken draft does not warn on
	 *   every reconnect; a fresh session and an explicit retry do pick them up.
	 * @returns {Promise<{promoted: number, failed: number}>}
	 */
	async function flushOfflineDrafts({ includeFailed = false } = {}) {
		if (flushingOfflineDrafts || isOffline() || !cartStore.posProfile) {
			return { promoted: 0, failed: 0 }
		}

		// Server drafts off: cached drafts are already in the right place.
		if (!(await resolveServerDraftMode())) {
			return { promoted: 0, failed: 0 }
		}

		flushingOfflineDrafts = true
		let promoted = 0
		let failed = 0

		try {
			const localDrafts = await getAllDrafts()
			// Both this flush and the invoice queue run on reconnect. A hold whose
			// invoice the queue is about to submit belongs to the queue: re-holding
			// it here would either overwrite it with pre-payment values or, if the
			// queue got there first, fail against a submitted invoice and burn a
			// retry. Leave those alone - pruneBoundDrafts clears them once the
			// queue has actually submitted them.
			const paidOffline = await paidOfflineInvoiceNames()

			for (const draft of localDrafts) {
				// sync_failed drafts are the ones the server kept rejecting - e.g. a
				// draft bound to an invoice someone else has since submitted.
				if (!draft?.items?.length) continue
				if (draft.sync_failed && !includeFailed) continue
				if (paidOffline.has(boundInvoiceName(draft))) continue

				try {
					const savedDraft = await saveServerDraft(
						buildServerPayloadFromDraft(draft),
					)

					// The cart may be sitting on this very draft - move its binding to
					// the invoice so the next hold updates it instead of duplicating.
					if (cartStore.currentDraftId === draft.draft_id) {
						cartStore.currentDraftId = savedDraft?.draft_id || null
						cartStore.heldInvoiceName = savedDraft?.invoice_name || null
					}

					await deleteDraft(draft.draft_id)
					promoted++
				} catch (error) {
					console.error("Error promoting offline draft to server:", error)
					failed++

					// Same escalation as the offline invoice queue: retry a few times,
					// then stop and leave the draft on the device.
					const retryCount = (draft.sync_retry_count || 0) + 1
					await updateDraft(draft.draft_id, {
						sync_retry_count: retryCount,
						sync_failed: retryCount >= 3,
						sync_error: error?.message || String(error),
					}).catch(() => {})
				}
			}

			if (promoted > 0) {
				await loadDrafts()
				showSuccess(
					__("{0} draft(s) held offline are now saved on the server", [
						promoted,
					]),
				)
			}

			if (failed > 0) {
				showWarning(
					__(
						"{0} draft(s) held offline could not be synced and are still on this device",
						[failed],
					),
				)
			}
		} catch (error) {
			console.error("Error syncing offline drafts:", error)
		} finally {
			flushingOfflineDrafts = false
		}

		return { promoted, failed }
	}

	/**
	 * Full draft behind a list row.
	 *
	 * Server drafts come back from get_pos_drafts as summaries (customer, line
	 * count, total, item names) - anything that needs the real cart, like the
	 * receipt, fetches the whole document first.
	 *
	 * @param {Object|string} draftOrId
	 * @returns {Promise<Object|null>} The hydrated draft, or the row itself for
	 *   local drafts and if the fetch fails.
	 */
	async function hydrateDraft(draftOrId) {
		const draft = resolveDraft(draftOrId)

		if (!draft || !isServerDraft(draft)) return draft

		try {
			return await getServerDraftById(boundInvoiceName(draft) || draft.draft_id)
		} catch (error) {
			console.error("Error loading full draft:", error)
			return draft
		}
	}

	async function deleteDraftById(draftId) {
		// Deep resolve: a miss here means the id is a server draft, which is not
		// the same question as "where would the next hold go".
		const draft = await resolveDraftDeep(draftId)

		try {
			if (!draft || isServerDraft(draft)) {
				await deleteServerDraft(boundInvoiceName(draft) || draftId)
			} else {
				await deleteDraft(draft?.draft_id || draftId)

				// Drop the Sales Invoice this cached hold was standing in for,
				// otherwise it resurfaces as a server draft on the next load.
				const bound = boundInvoiceName(draft)
				if (bound && !isOffline()) {
					await deleteServerDraft(bound).catch((error) =>
						console.error("Error deleting bound server draft:", error),
					)
				}
			}
			await loadDrafts() // Refresh drafts list and count
			showSuccess(__("Draft deleted successfully"))
		} catch (error) {
			console.error("Error deleting draft:", error)
			showError(__("Failed to delete draft"))
		}
	}

	async function deleteAllDrafts() {
		try {
			await clearAllDrafts()

			let skipped = 0
			if (!isOffline() && cartStore.posProfile) {
				const result = await clearAllServerDrafts(cartStore.posProfile)
				skipped = result?.skipped || 0
			}

			await loadDrafts()

			// Held drafts parked by other cashiers are kept unless the user is a
			// manager - say so, otherwise the list looks like it failed to clear
			if (skipped > 0) {
				showSuccess(
					__(
						"Your draft invoices were deleted. {0} draft(s) held by other users were kept",
						[skipped],
					),
				)
			} else {
				showSuccess(__("All draft invoices deleted"))
			}
			return true
		} catch (error) {
			console.error("Error clearing drafts:", error)
			showError(__("Failed to clear drafts"))
			return false
		}
	}

	/**
	 * Clear the hold a just-submitted sale came from.
	 *
	 * A server draft IS the invoice that was submitted, so there is nothing to
	 * delete - it simply left draft state. A cached draft (including one bound to
	 * that invoice) is spent and goes.
	 */
	async function discardDraftAfterSubmit(draftId) {
		if (!draftId) return

		// Only a cached draft has anything to clean up, and only a deep resolve
		// can tell one apart from a server draft when the list has not loaded.
		const draft = await resolveDraftDeep(draftId)

		try {
			if (draft && !isServerDraft(draft)) {
				await deleteDraft(draft.draft_id)
			}
		} catch (error) {
			console.error("Error clearing draft after submit:", error)
		}

		await loadDrafts()
	}

	/**
	 * Clear the hold a sale paid offline came from.
	 *
	 * The sale is only queued at this point, so a hold that stands for a Sales
	 * Invoice - a server draft, or a cached draft bound to one - is kept until the
	 * queue actually submits it. pruneBoundDrafts drops it once that happens.
	 */
	async function discardDraftAfterOfflineSave(draftId) {
		if (!draftId) return

		const draft = await resolveDraftDeep(draftId)
		if (!draft || isServerDraft(draft) || boundInvoiceName(draft)) {
			return
		}

		try {
			await deleteDraft(draft.draft_id)
		} catch (error) {
			console.error("Error clearing draft after offline save:", error)
		}

		await loadDrafts()
	}

	// Promote offline holds as soon as the connection is back. Pinia stores are
	// singletons, so this subscription lives for the app's lifetime - the same
	// pattern the invoice queue uses in stores/posSync.js.
	let wasOffline = isOffline()
	offlineState.subscribe((state) => {
		const nowOffline = state.isOffline

		if (wasOffline && !nowOffline) {
			flushOfflineDrafts().catch((error) =>
				console.error("Error flushing offline drafts on reconnect:", error),
			)
		}

		wasOffline = nowOffline
	})

	/** Re-run the flush over the drafts that already gave up. */
	async function retryFailedDrafts() {
		return await flushOfflineDrafts({ includeFailed: true })
	}

	return {
		// State
		draftsCount,
		drafts,
		failedDraftsCount,

		// Computed
		useServerDrafts,

		// Actions
		updateDraftsCount,
		loadDrafts,
		saveDraftInvoice,
		loadDraft,
		hydrateDraft,
		flushOfflineDrafts,
		retryFailedDrafts,
		deleteDraft: deleteDraftById,
		deleteAllDrafts,
		discardDraftAfterSubmit,
		discardDraftAfterOfflineSave,
	}
})
