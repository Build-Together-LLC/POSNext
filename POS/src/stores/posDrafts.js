import {
	clearAllDrafts,
	deleteDraft,
	getAllDrafts,
	saveDraft,
	updateDraft,
} from "@/utils/draftManager"
import {
	clearAllServerDrafts,
	deleteServerDraft,
	getAllServerDrafts,
	getServerDraftById,
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

export const usePOSDraftsStore = defineStore("posDrafts", () => {
	// Use custom toast
	const { showSuccess, showError, showWarning } = useToast()

	const settingsStore = usePOSSettingsStore()
	const cartStore = usePOSCartStore()
	const offersStore = usePOSOffersStore()

	// State
	const draftsCount = ref(0)
	const drafts = ref([])

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
			const [localDrafts, serverDrafts] = await Promise.all([
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

			const claimed = new Set(localDrafts.map(boundInvoiceName).filter(Boolean))

			drafts.value = sortByCreatedDesc([
				...serverDrafts.filter((d) => !claimed.has(d.invoice_name)),
				...localDrafts,
			])
			draftsCount.value = drafts.value.length

			// The reconnect subscription only fires on an offline -> online
			// transition, so an app restarted online with holds still in IndexedDB
			// would never flush them. Try once per session; the flush re-enters
			// loadDrafts, which the in-progress guard turns into a no-op.
			if (!attemptedStartupFlush && !isOffline() && localDrafts.length > 0) {
				attemptedStartupFlush = true
				flushOfflineDrafts().catch((error) =>
					console.error("Error flushing offline drafts on startup:", error),
				)
			}
		} catch (error) {
			console.error("Error loading drafts:", error)
		}
	}

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

		// The setting decides where this hold is written - every time, including
		// when re-holding a sale that was resumed from the other backend.
		const toServer = await resolveServerDraftMode()

		if (useServerDrafts.value && isOffline()) {
			showWarning(
				__("Offline - holding this invoice on this device until the connection is back"),
			)
		}

		const existing = draftId ? resolveDraft(draftId) : null
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

				if (draftId && !existingIsServer) {
					await deleteDraft(draftId).catch(() => {})
				}
			} else {
				const draftData = {
					pos_profile: posProfile,
					customer: customer,
					items: invoiceItems,
					applied_offers: appliedOffers, // Save applied offers
					// Cart-level values live outside the item rows - keep them so
					// resuming (and promoting an offline hold) restores the same sale.
					additional_discount: cartStore.additionalDiscount || 0,
					coupon_code: cartStore.couponCode || null,
					// Null unless this cart came from a server draft.
					invoice_name: boundInvoice,
				}

				// Resuming a server draft into the cache creates a new cached entry:
				// draftId is that invoice's name, not a cached draft key.
				savedDraft =
					existing && !existingIsServer
						? await updateDraft(draftId, draftData)
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
			posa_pos_opening_shift: cartStore.posOpeningShift,
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
	 * Push drafts held while offline up to the server.
	 *
	 * Holding falls back to IndexedDB whenever the connection is down (see
	 * saveDraftInvoice), and the offline invoice queue only carries submitted
	 * sales - so without this those holds would stay on one device. On reconnect,
	 * if the server is the configured backend, each cached draft is re-held as a
	 * Sales Invoice and the local copy dropped.
	 *
	 * Anything that fails is left in IndexedDB and retried on the next reconnect.
	 *
	 * @returns {Promise<{promoted: number, failed: number}>}
	 */
	async function flushOfflineDrafts() {
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

			for (const draft of localDrafts) {
				// sync_failed drafts are the ones the server keeps rejecting - e.g. a
				// draft bound to an invoice someone else has since submitted. Leave
				// them alone rather than warning about them on every reconnect.
				if (!draft?.items?.length || draft.sync_failed) continue

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
					__("{0} draft(s) held offline are now saved on the server", [promoted]),
				)
			}

			if (failed > 0) {
				showWarning(
					__("{0} draft(s) held offline could not be synced and are still on this device", [
						failed,
					]),
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
		const draft = resolveDraft(draftId)

		try {
			if (draft ? isServerDraft(draft) : useServerDrafts.value) {
				await deleteServerDraft(boundInvoiceName(draft) || draftId)
			} else {
				await deleteDraft(draft?.draft_id || draftId)

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
					__("Your draft invoices were deleted. {0} draft(s) held by other users were kept", [
						skipped,
					]),
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

	
	async function discardDraftAfterSubmit(draftId) {
		if (!draftId) return

		const draft = resolveDraft(draftId)

		try {
			if (!draft || !isServerDraft(draft)) {
				await deleteDraft(draft?.draft_id || draftId)
			}
		} catch (error) {
			console.error("Error clearing draft after submit:", error)
		}

		await loadDrafts()
	}


	async function discardDraftAfterOfflineSave(draftId) {
		if (!draftId) return

		const draft = resolveDraft(draftId)
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

	return {
		// State
		draftsCount,
		drafts,

		// Computed
		useServerDrafts,

		// Actions
		updateDraftsCount,
		loadDrafts,
		saveDraftInvoice,
		loadDraft,
		hydrateDraft,
		flushOfflineDrafts,
		deleteDraft: deleteDraftById,
		deleteAllDrafts,
		discardDraftAfterSubmit,
		discardDraftAfterOfflineSave,
	}
})
