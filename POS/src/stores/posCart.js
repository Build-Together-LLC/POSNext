import { useInvoice } from "@/composables/useInvoice"
import { usePOSOffersStore } from "@/stores/posOffers"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { useStockStore } from "@/stores/stock"
import { parseError } from "@/utils/errorHandler"
import {
	checkStockAvailability,
	formatStockError,
} from "@/utils/stockValidator"
import { useToast } from "@/composables/useToast"
import { defineStore } from "pinia"
import { computed, nextTick, ref, toRaw, watch } from "vue"

export const usePOSCartStore = defineStore("posCart", () => {
	// Use the existing invoice composable for core functionality
	const {
		invoiceItems,
		customer,
		subtotal,
		totalTax,
		totalDiscount,
		grandTotal,
		posProfile,
		posOpeningShift,
		payments,
		salesTeam,
		additionalDiscount,
		taxInclusive,
		disableRoundedTotal,
		addItem: addItemToInvoice,
		removeItem,
		updateItemQuantity,
		submitInvoice,
		clearCart: clearInvoiceCart,
		loadTaxRules,
		setTaxInclusive,
		setDefaultCustomer,
		applyDiscount,
		removeDiscount,
		applyOffersResource,
		getItemDetailsResource,
		recalculateItem,
		rebuildIncrementalCache,
	} = useInvoice()

	const offersStore = usePOSOffersStore()
	const settingsStore = usePOSSettingsStore()
	const stockStore = useStockStore()

	// Additional cart state
	const pendingItem = ref(null)
	const pendingItemQty = ref(1)
	const appliedOffers = ref([])
	const appliedCoupon = ref(null)
	const selectionMode = ref("uom") // 'uom' or 'variant'
	const suppressOfferReapply = ref(false)
	const currentDraftId = ref(null)

	// Toast composable
	const { showSuccess, showError, showWarning } = useToast()

	// Computed
	const itemCount = computed(() => invoiceItems.value.length)
	const isEmpty = computed(() => invoiceItems.value.length === 0)
	const hasCustomer = computed(() => !!customer.value)

	// Actions
	function addItem(item, qty = 1, autoAdd = false, currentProfile = null) {
		// Check stock availability before adding to cart
		// Skip validation for batch/serial items - they have their own validation in the dialog
		// Check for stock items AND Product Bundles (bundles now have calculated stock)
		// Also check items with actual_qty defined (catches misconfigured items)

		// Determine if this item should be validated for stock
		// Include: stock items, bundles, OR items with actual_qty defined (catches misconfigured items)
		// CRITICAL: If is_stock_item is explicitly false/0, we must skip validation even if actual_qty exists
		const isNonStockItem = item.is_stock_item === 0 || item.is_stock_item === false
		const hasActualQty = item.actual_qty !== undefined || item.stock_qty !== undefined
		const shouldValidateStock = !isNonStockItem && (item.is_stock_item || item.is_bundle || hasActualQty)

		if (shouldValidateStock && !item.has_serial_no && !item.has_batch_no) {
			const serverStock = stockStore.server.get(item.item_code)?.qty ?? item.actual_qty ?? item.stock_qty ?? 0
			const reservedQty = stockStore.reserved.get(item.item_code) || 0
			const availableQty = serverStock - reservedQty

			if (settingsStore.shouldEnforceStockValidation()) {
				if (Math.floor(availableQty) <= 0) {
					const itemType = item.is_bundle ? "Bundle" : "Item"
					throw new Error(
						`"${item.item_name}" cannot be added to cart. ${itemType} quantity reaches 0.`
					)
				}
				if (qty > availableQty) {
					const itemType = item.is_bundle ? "Bundle" : "Item"
					throw new Error(
						`Not enough stock for "${item.item_name}". Requested ${qty}, but only ${Math.max(0, Math.floor(availableQty))} available.`
					)
				}
			}
		}

		// Add item to cart - no toast notification for performance
		addItemToInvoice(item, qty)
	}

	function clearCart() {
		clearInvoiceCart()
		customer.value = null
		appliedOffers.value = []
		appliedCoupon.value = null
		currentDraftId.value = null
	}

	function setCustomer(selectedCustomer) {
		customer.value = selectedCustomer
	}

	function setPendingItem(item, qty = 1, mode = "uom") {
		pendingItem.value = item
		pendingItemQty.value = qty
		selectionMode.value = mode
	}

	function clearPendingItem() {
		pendingItem.value = null
		pendingItemQty.value = 1
		selectionMode.value = "uom"
	}

	// Discount & Offer Management
	function applyDiscountToCart(discount) {
		applyDiscount(discount)
		appliedCoupon.value = discount
		showSuccess(__('{0} applied successfully', [discount.name]))
	}

	function removeDiscountFromCart() {
		suppressOfferReapply.value = true
		appliedOffers.value = []
		removeDiscount()
		appliedCoupon.value = null
		showSuccess(__("Discount has been removed from cart"))
	}

	function buildInvoiceDataForOffers(currentProfile) {
		// Use toRaw() to ensure we get current, non-reactive values (prevents stale cached quantities)
		const rawItems = toRaw(invoiceItems.value)

		return {
			doctype: "Sales Invoice",
			pos_profile: posProfile.value,
			customer:
				customer.value?.name || customer.value || currentProfile?.customer,
			company: currentProfile?.company,
			selling_price_list: currentProfile?.selling_price_list,
			currency: currentProfile?.currency,
			discount_amount: additionalDiscount.value || 0,
			coupon_code: appliedCoupon.value?.name || "",
			items: rawItems.map((item) => ({
				item_code: item.item_code,
				item_name: item.item_name,
				qty: item.quantity,
				rate: item.rate,
				uom: item.uom,
				warehouse: item.warehouse,
				conversion_factor: item.conversion_factor || 1,
				price_list_rate: item.price_list_rate || item.rate,
				discount_percentage: item.discount_percentage || 0,
				discount_amount: item.discount_amount || 0,
			})),
		}
	}

	function applyServerDiscounts(serverItems) {
		if (!Array.isArray(serverItems)) {
			return false
		}

		// Server returns items in same order as sent - match by array index
		// This correctly handles duplicate SKUs (same item_code in cart multiple times)
		let hasDiscounts = false

		invoiceItems.value.forEach((item, index) => {
			const serverItem = serverItems[index] || {}
			const serverDiscountPercentage =
				Number.parseFloat(serverItem.discount_percentage) || 0
			const serverDiscountAmount = Number.parseFloat(serverItem.discount_amount) || 0
			const hasServerDiscount = serverDiscountPercentage > 0 || serverDiscountAmount > 0

			// Check if server applied pricing rules to this item
			const hasPricingRules = serverItem.pricing_rules &&
				Array.isArray(serverItem.pricing_rules) &&
				serverItem.pricing_rules.length > 0

			if (hasPricingRules || hasServerDiscount) {
				// Server found a pricing rule - apply server discount
				item.discount_percentage = serverDiscountPercentage
				item.discount_amount = serverDiscountAmount
				item.pricing_rules = serverItem.pricing_rules
				hasDiscounts = hasServerDiscount
			} else {
				// No pricing rules matched for this item
				// Preserve existing manual discount (don't overwrite with server's 0)
				// This fixes the bug where manual discounts are lost when customer changes
			}

			// Recalculate item (from useInvoice)
			recalculateItem(item)
		})

		// Rebuild cache after bulk operation
		rebuildIncrementalCache()

		return hasDiscounts
	}

	/**
	 * Parses the backend offer response and applies free item quantities to cart items
	 *
	 * @param {Array} freeItems - Array of free items from backend (e.g., [{item_code, qty, uom}])
	 * @returns {void}
	 *
	 * @example
	 * // Backend returns: [{ item_code: "SKU001", qty: 1, uom: "Nos" }]
	 * // Cart has: [{ item_code: "SKU001", quantity: 2, uom: "Nos" }]
	 * // Result: Cart item gets free_qty = 1 (shown as "2 items + 1 FREE")
	 */
	function processFreeItems(freeItems) {
		// Reset all free quantities
		invoiceItems.value.forEach(item => {
			item.free_qty = 0
		})

		// Early return if no free items
		if (!Array.isArray(freeItems) || freeItems.length === 0) {
			return
		}

		// Match free items to cart items and set free_qty
		for (const freeItem of freeItems) {
			const freeQty = Number.parseFloat(freeItem.qty) || 0
			if (freeQty <= 0) continue

			// Find matching cart item by item_code and uom
			const cartItem = invoiceItems.value.find(
				item => item.item_code === freeItem.item_code &&
				(item.uom || item.stock_uom) === (freeItem.uom || freeItem.stock_uom)
			)

			if (cartItem) {
				cartItem.free_qty = freeQty
			}
		}
	}

	/**
	 * Extracts and normalizes the offer response from backend
	 *
	 * @param {Object} response - Raw API response from backend
	 * @param {Array} fallbackRules - Default rules to use if none returned
	 * @returns {Object} Normalized response with items, freeItems, and appliedRules
	 */
	function parseOfferResponse(response, fallbackRules = []) {
		const payload = response?.message || response || {}

		return {
			items: Array.isArray(payload.items) ? payload.items : [],
			freeItems: Array.isArray(payload.free_items) ? payload.free_items : [],
			appliedRules: Array.isArray(payload.applied_pricing_rules) && payload.applied_pricing_rules.length
				? payload.applied_pricing_rules
				: fallbackRules
		}
	}

	function getAppliedOfferCodes() {
		return appliedOffers.value.map((entry) => entry.code)
	}

	function filterActiveOffers(appliedRuleNames = []) {
		if (!Array.isArray(appliedRuleNames) || appliedRuleNames.length === 0) {
			appliedOffers.value = []
			return
		}

		appliedOffers.value = appliedOffers.value.filter((entry) =>
			appliedRuleNames.includes(entry.code),
		)
	}

	async function applyOffer(offer, currentProfile, offersDialogRef = null) {
		if (!offer) {
			console.error("No offer provided")
			offersDialogRef?.resetApplyingState()
			return false
		}

		const offerCode = offer.name
		const existingCodes = getAppliedOfferCodes()
		const alreadyApplied = existingCodes.includes(offerCode)

		if (alreadyApplied) {
			return await removeOffer(offerCode, currentProfile, offersDialogRef)
		}

		if (!posProfile.value || invoiceItems.value.length === 0) {
			showWarning(__("Add items to the cart before applying an offer."))
			offersDialogRef?.resetApplyingState()
			return false
		}

		try {
			const invoiceData = buildInvoiceDataForOffers(currentProfile)
			const offerNames = [...new Set([...existingCodes, offerCode])]

			const response = await applyOffersResource.submit({
				invoice_data: invoiceData,
				selected_offers: offerNames,
			})

			const { items: responseItems, freeItems, appliedRules } =
				parseOfferResponse(response, existingCodes)

			suppressOfferReapply.value = true
			applyServerDiscounts(responseItems)
			processFreeItems(freeItems)

			filterActiveOffers(appliedRules)

			const offerApplied = appliedRules.includes(offerCode)

			if (!offerApplied) {
				// No new offer applied - restore previous state without new offer
				if (existingCodes.length) {
					try {
						const rollbackResponse = await applyOffersResource.submit({
							invoice_data: invoiceData,
							selected_offers: existingCodes,
						})
						const {
							items: rollbackItems,
							freeItems: rollbackFreeItems,
							appliedRules: rollbackRules,
						} = parseOfferResponse(rollbackResponse, existingCodes)

						applyServerDiscounts(rollbackItems)
						processFreeItems(rollbackFreeItems)
						filterActiveOffers(rollbackRules)
					} catch (rollbackError) {
						console.error("Error rolling back offers:", rollbackError)
					}
				}

				showWarning(__("Your cart doesn't meet the requirements for this offer."))
				offersDialogRef?.resetApplyingState()
				return false
			}

			const offerRuleCodes = appliedRules.includes(offerCode)
				? appliedRules.filter((ruleName) => ruleName === offerCode)
				: [offerCode]

			const updatedEntries = appliedOffers.value.filter(
				(entry) => entry.code !== offerCode,
			)
			updatedEntries.push({
				name: offer.title || offer.name,
				code: offerCode,
				offer, // Store full offer object for validation
				source: "manual",
				applied: true,
				rules: offerRuleCodes,
				// Store constraints for quick validation
				min_qty: offer.min_qty,
				max_qty: offer.max_qty,
				min_amt: offer.min_amt,
				max_amt: offer.max_amt,
			})
			appliedOffers.value = updatedEntries

			showSuccess(__('{0} applied successfully', [(offer.title || offer.name)]))

			return true
		} catch (error) {
			console.error("Error applying offer:", error)
			showError(__("Failed to apply offer. Please try again."))
			offersDialogRef?.resetApplyingState()
			return false
		}
	}

	/**
	 * Clears per-item pricing-rule discounts (discount_percentage / discount_amount
	 * / pricing_rules) and recalculates. Manual offer removal must call this — the
	 * offers list and global discount are not the only place a discount lives; the
	 * pricing rule sets it on each line, and clearing the offer alone leaves that
	 * line discount visible (the reported "offer removed but still applied" bug).
	 */
	function resetPricingRuleDiscounts() {
		let changed = false
		invoiceItems.value.forEach((item) => {
			if (item.pricing_rules && item.pricing_rules.length > 0) {
				item.discount_percentage = 0
				item.discount_amount = 0
				item.pricing_rules = []
				recalculateItem(item)
				changed = true
			}
		})
		if (changed) rebuildIncrementalCache()
		return changed
	}

	async function removeOffer(
		offer,
		currentProfile = null,
		offersDialogRef = null,
	) {
		const offerCode =
			typeof offer === "string" ? offer : offer?.name || offer?.code

		if (!offerCode) {
			// Remove all offers
			suppressOfferReapply.value = true
			appliedOffers.value = []
			processFreeItems([]) // Remove all free items
			resetPricingRuleDiscounts() // also clear per-item pricing-rule discounts
			removeDiscount()
			showSuccess(__("Offer has been removed from cart"))
			offersDialogRef?.resetApplyingState()
			return true
		}

		const remainingOffers = appliedOffers.value.filter(
			(entry) => entry.code !== offerCode,
		)
		const remainingCodes = remainingOffers.map((entry) => entry.code)

		if (remainingCodes.length === 0) {
			suppressOfferReapply.value = true
			appliedOffers.value = []
			processFreeItems([]) // Remove all free items
			resetPricingRuleDiscounts() // also clear per-item pricing-rule discounts
			removeDiscount()
			showSuccess(__("Offer has been removed from cart"))
			offersDialogRef?.resetApplyingState()
			return true
		}

		try {
			// Clear all pricing-rule discounts first so the removed offer's line is
			// reset; applyServerDiscounts then re-applies only the remaining offers.
			resetPricingRuleDiscounts()

			const invoiceData = buildInvoiceDataForOffers(currentProfile)

			const response = await applyOffersResource.submit({
				invoice_data: invoiceData,
				selected_offers: remainingCodes,
			})

			const { items: responseItems, freeItems, appliedRules } =
				parseOfferResponse(response, remainingCodes)

			suppressOfferReapply.value = true
			applyServerDiscounts(responseItems)
			processFreeItems(freeItems)
			filterActiveOffers(appliedRules)

			appliedOffers.value = appliedOffers.value.filter((entry) =>
				remainingCodes.includes(entry.code),
			)

			showSuccess(__("Offer has been removed from cart"))
			offersDialogRef?.resetApplyingState()
			return true
		} catch (error) {
			console.error("Error removing offer:", error)
			showError(__("Failed to update cart after removing offer."))
			offersDialogRef?.resetApplyingState()
			return false
		}
	}

	/**
	 * Validates applied offers and removes invalid ones when cart changes
	 * This function is called automatically when items are added/removed or quantities change
	 */
	async function reapplyOffer(currentProfile) {
		// Clear offers if cart is empty
		if (invoiceItems.value.length === 0 && appliedOffers.value.length) {
			appliedOffers.value = []
			processFreeItems([]) // Remove all free items when cart is empty
			return
		}

		// Skip revalidation if suppressed (e.g., during offer application)
		if (suppressOfferReapply.value) {
			suppressOfferReapply.value = false
			return
		}

		// Only validate if there are applied offers
		if (appliedOffers.value.length === 0 || invoiceItems.value.length === 0) {
			return
		}

		try {
			// Build current cart snapshot for validation
			const cartSnapshot = buildCartSnapshot()

			// Check each applied offer against current cart state
			const invalidOffers = []
			for (const appliedOffer of appliedOffers.value) {
				const offer = appliedOffer.offer
				if (!offer) continue

				// Use offersStore to check eligibility
				offersStore.updateCartSnapshot(cartSnapshot)
				const { eligible, reason } = offersStore.checkOfferEligibility(offer)

				if (!eligible) {
					invalidOffers.push({
						...appliedOffer,
						reason
					})
				}
			}

			// If any offers are invalid, remove them and reapply remaining
			if (invalidOffers.length > 0) {
				const validOfferCodes = appliedOffers.value
					.filter(o => !invalidOffers.find(inv => inv.code === o.code))
					.map(o => o.code)

				// Show warning about removed offers
				const offerNames = invalidOffers.map(o => o.name).join(', ')
				showWarning(`Offer removed: ${offerNames}. Cart no longer meets requirements.`)

				if (validOfferCodes.length === 0) {
					// All offers invalid - clear everything
					suppressOfferReapply.value = true
					appliedOffers.value = []
					processFreeItems([])

					// Reset all item rates to original (remove discounts)
					resetPricingRuleDiscounts()
				} else {
					// Reapply only valid offers
					const invoiceData = buildInvoiceDataForOffers(currentProfile)
					const response = await applyOffersResource.submit({
						invoice_data: invoiceData,
						selected_offers: validOfferCodes,
					})

					const { items: responseItems, freeItems, appliedRules } =
						parseOfferResponse(response, validOfferCodes)

					suppressOfferReapply.value = true
					applyServerDiscounts(responseItems)
					processFreeItems(freeItems)
					filterActiveOffers(appliedRules)

					// Update appliedOffers to only include valid ones
					appliedOffers.value = appliedOffers.value.filter(entry =>
						appliedRules.includes(entry.code)
					)
				}
			}
		} catch (error) {
			console.error("Error validating offers:", error)
		}
	}

	/**
	 * Builds cart snapshot for offer validation
	 */
	function buildCartSnapshot() {
		const items = invoiceItems.value
		const totalQty = items.reduce((sum, item) => sum + (item.quantity || 0), 0)
		const itemCodes = items.map(item => item.item_code)
		const itemGroups = items.map(item => item.item_group).filter(Boolean)
		const brands = items.map(item => item.brand).filter(Boolean)
		// Per-item brand + sub-brand so the offers store can resolve the effective
		// brand (sub-brand when it has an offer, else brand).
		const itemBrandPairs = items.map(item => ({
			brand: item.brand,
			subBrand: item.custom_sub_brand,
		}))
		// Per-line detail so an offer's qty/amount thresholds can be scoped to just
		// the items it targets (1-to-1), rather than the whole cart.
		const lines = items.map(item => ({
			itemCode: item.item_code,
			itemGroup: item.item_group,
			brand: item.brand,
			subBrand: item.custom_sub_brand,
			qty: item.quantity || 0,
			amount: (item.quantity || 0) * (item.rate ?? item.price_list_rate ?? 0),
		}))

		return {
			subtotal: subtotal.value,
			itemCount: totalQty,
			itemCodes: [...new Set(itemCodes)],
			itemGroups: [...new Set(itemGroups)],
			brands: [...new Set(brands)],
			itemBrandPairs,
			lines,
		}
	}

	async function changeItemUOM(itemCode, newUom) {
		try {
			const cartItem = invoiceItems.value.find((i) => i.item_code === itemCode)
			if (!cartItem) return

			const itemDetails = await getItemDetailsResource.submit({
				item_code: itemCode,
				pos_profile: posProfile.value,
				customer: customer.value?.name || customer.value,
				qty: cartItem.quantity,
				uom: newUom,
			})

			const uomData = cartItem.item_uoms?.find((u) => u.uom === newUom)

			cartItem.uom = newUom
			cartItem.conversion_factor =
				uomData?.conversion_factor || itemDetails.conversion_factor || 1
			cartItem.rate = itemDetails.price_list_rate || itemDetails.rate
			cartItem.price_list_rate = itemDetails.price_list_rate

			recalculateItem(cartItem)

			// Rebuild cache after item update to ensure totals are accurate
			rebuildIncrementalCache()

			showSuccess(__('Unit changed to {0}', [newUom]))
		} catch (error) {
			console.error("Error changing UOM:", error)
			showError(__("Failed to update UOM. Please try again."))
		}
	}

	async function updateItemDetails(itemCode, updatedDetails) {
		try {
			const cartItem = invoiceItems.value.find((i) => i.item_code === itemCode)
			if (!cartItem) {
				throw new Error("Item not found in cart")
			}

			// If UOM changed, fetch new rate from server
			if (updatedDetails.uom && updatedDetails.uom !== cartItem.uom) {
				try {
					const itemDetails = await getItemDetailsResource.submit({
						item_code: itemCode,
						pos_profile: posProfile.value,
						customer: customer.value?.name || customer.value,
						qty: updatedDetails.quantity || cartItem.quantity,
						uom: updatedDetails.uom,
					})

					const uomData = cartItem.item_uoms?.find(
						(u) => u.uom === updatedDetails.uom,
					)

					// Update with server response
					cartItem.uom = updatedDetails.uom
					cartItem.conversion_factor =
						uomData?.conversion_factor || itemDetails.conversion_factor || 1
					cartItem.rate = itemDetails.price_list_rate || itemDetails.rate
					cartItem.price_list_rate = itemDetails.price_list_rate
				} catch (error) {
					console.warn(
						"Failed to fetch UOM details, using provided rate:",
						error,
					)
					// Fall back to using the provided rate
					cartItem.uom = updatedDetails.uom
				}
			}

			// Update all provided details
			if (updatedDetails.quantity !== undefined) {
				cartItem.quantity = updatedDetails.quantity
			}
			if (updatedDetails.warehouse !== undefined) {
				cartItem.warehouse = updatedDetails.warehouse
			}
			if (updatedDetails.discount_percentage !== undefined) {
				cartItem.discount_percentage = updatedDetails.discount_percentage
			}
			if (updatedDetails.discount_amount !== undefined) {
				cartItem.discount_amount = updatedDetails.discount_amount
			}
			// Update price_list_rate if provided (for UOM changes)
			if (updatedDetails.price_list_rate !== undefined) {
				cartItem.price_list_rate = updatedDetails.price_list_rate
			}
			// A manually edited rate becomes the new base price for the line.
			// It must be applied after price_list_rate above (the edit dialog echoes
			// back the original price_list_rate, which would otherwise win) and it
			// drives price_list_rate because subtotal, totals and the submit payload
			// are all derived from price_list_rate rather than rate.
			if (updatedDetails.rate !== undefined && updatedDetails.rate !== null) {
				const editedRate = Number.parseFloat(updatedDetails.rate)
				if (!Number.isNaN(editedRate) && editedRate >= 0) {
					cartItem.rate = editedRate
					cartItem.price_list_rate = editedRate
				}
			}
			// Update serial numbers if provided
			if (updatedDetails.serial_no !== undefined) {
				cartItem.serial_no = updatedDetails.serial_no
			}

			// Recalculate item totals (this will compute the correct rate from price_list_rate and discount)
			recalculateItem(cartItem)

			// Rebuild cache after item update to ensure totals are accurate
			rebuildIncrementalCache()

			showSuccess(__('{0} updated successfully', [cartItem.item_name]))

			return true
		} catch (error) {
			console.error("Error updating item details:", error)
			showError(parseError(error) || __("Failed to update item. Please try again."))
			return false
		}
	}

	// Performance: Cache previous item codes hash to avoid unnecessary recalculations
	let previousItemCodesHash = ""
	let cachedItemCodes = []
	let cachedItemGroups = []
	let cachedBrands = []
	let cachedItemBrandPairs = []
	let cachedLines = []

	function syncOfferSnapshot() {
		// Only sync if values are initialized
		if (subtotal.value !== undefined && invoiceItems.value) {
			// Create hash for item codes to detect actual changes
			const currentHash = invoiceItems.value
				.map((item) => item.item_code)
				.join(",")

			// Only recalculate expensive operations if items actually changed
			if (currentHash !== previousItemCodesHash) {
				cachedItemCodes = invoiceItems.value.map((item) => item.item_code)
				cachedItemGroups = [
					...new Set(
						invoiceItems.value.map((item) => item.item_group).filter(Boolean),
					),
				]
				cachedBrands = [
					...new Set(
						invoiceItems.value.map((item) => item.brand).filter(Boolean),
					),
				]
				// Per-item brand + sub-brand for lenient effective-brand resolution.
				cachedItemBrandPairs = invoiceItems.value.map((item) => ({
					brand: item.brand,
					subBrand: item.custom_sub_brand,
				}))
				previousItemCodesHash = currentHash
			}

			// Calculate total quantity (sum of all item quantities, not line count)
			const totalQty = invoiceItems.value.reduce((sum, item) => {
				return sum + (item.quantity || 0)
			}, 0)

			// Per-line detail is recomputed every sync (not cached on the item-code
			// hash) because qty/amount change even when the set of items does not.
			cachedLines = invoiceItems.value.map((item) => ({
				itemCode: item.item_code,
				itemGroup: item.item_group,
				brand: item.brand,
				subBrand: item.custom_sub_brand,
				qty: item.quantity || 0,
				amount: (item.quantity || 0) * (item.rate ?? item.price_list_rate ?? 0),
			}))

			offersStore.updateCartSnapshot({
				subtotal: subtotal.value,
				itemCount: totalQty, // Total quantity, not number of line items
				itemCodes: cachedItemCodes,
				itemGroups: cachedItemGroups,
				brands: cachedBrands,
				itemBrandPairs: cachedItemBrandPairs,
				lines: cachedLines,
			})
		}
	}

	// Watch for cart changes to update offer snapshot and validate offers
	// Watch subtotal and create a reactive hash of items to detect any changes
	watch(
		[
			subtotal,
			() => invoiceItems.value.map(item => `${item.item_code}:${item.quantity}`).join(',')
		],
		async () => {
			// Defer to next tick to prevent blocking UI
			await nextTick()

			// Update offer snapshot for eligibility checking
			syncOfferSnapshot()

			// Validate applied offers - remove any that no longer meet requirements
			if (appliedOffers.value.length > 0 && posProfile.value) {
				// Get current profile from posProfile
				const currentProfile = {
					customer: customer.value?.name || customer.value,
					company: posProfile.value.company,
					selling_price_list: posProfile.value.selling_price_list,
					currency: posProfile.value.currency,
				}

				// Validate and auto-remove invalid offers
				await reapplyOffer(currentProfile)
			}
		},
		{ immediate: true, flush: "post" },
	)

	return {
		// State
		invoiceItems,
		customer,
		subtotal,
		totalTax,
		totalDiscount,
		grandTotal,
		posProfile,
		posOpeningShift,
		payments,
		salesTeam,
		additionalDiscount,
		taxInclusive,
		disableRoundedTotal,
		pendingItem,
		pendingItemQty,
		appliedOffers,
		appliedCoupon,
		selectionMode,
		suppressOfferReapply,
		currentDraftId,
		// Computed
		itemCount,
		isEmpty,
		hasCustomer,

		// Actions
		addItem,
		removeItem,
		updateItemQuantity,
		clearCart,
		setCustomer,
		setDefaultCustomer,
		setPendingItem,
		clearPendingItem,
		loadTaxRules,
		setTaxInclusive,
		submitInvoice,
		applyDiscountToCart,
		removeDiscountFromCart,
		applyOffer,
		removeOffer,
		reapplyOffer,
		changeItemUOM,
		updateItemDetails,
		getItemDetailsResource,
		recalculateItem,
		rebuildIncrementalCache,
		applyOffersResource,
		buildInvoiceDataForOffers,
	}
})
