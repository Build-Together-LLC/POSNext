import { defineStore } from "pinia"
import { computed, ref } from "vue"

const defaultSnapshot = () => ({
	subtotal: 0,
	itemCount: 0,
	itemCodes: [],
	itemGroups: [],
	brands: [],
	itemBrandPairs: [],
	// Per-line detail so an offer's qty/amount thresholds can be scoped to just
	// the items that offer targets (1-to-1), instead of the whole cart.
	lines: [],
})

function getDiscountSortValue(offer) {
	const percentage = Number.parseFloat(offer?.discount_percentage) || 0
	if (percentage) {
		return percentage
	}

	return Number.parseFloat(offer?.discount_amount) || 0
}

export const usePOSOffersStore = defineStore("posOffers", () => {
	const availableOffers = ref([])
	const cartSnapshot = ref(defaultSnapshot())
	const hasFetched = ref(false)

	function updateCartSnapshot(snapshot = {}) {
		const subtotal = Number.parseFloat(snapshot.subtotal) || 0
		const itemCount = Number.isFinite(snapshot.itemCount)
			? snapshot.itemCount
			: 0
		const itemCodes = Array.isArray(snapshot.itemCodes)
			? snapshot.itemCodes
			: []
		const itemGroups = Array.isArray(snapshot.itemGroups)
			? snapshot.itemGroups
			: []
		const brands = Array.isArray(snapshot.brands) ? snapshot.brands : []
		const itemBrandPairs = Array.isArray(snapshot.itemBrandPairs)
			? snapshot.itemBrandPairs
			: []
		const lines = Array.isArray(snapshot.lines) ? snapshot.lines : []

		cartSnapshot.value = {
			subtotal,
			itemCount,
			itemCodes,
			itemGroups,
			brands,
			itemBrandPairs,
			lines,
		}
	}

	function resetCartSnapshot() {
		cartSnapshot.value = defaultSnapshot()
	}

	function setAvailableOffers(offers = []) {
		if (!Array.isArray(offers)) {
			availableOffers.value = []
		} else {
			availableOffers.value = offers
		}
		hasFetched.value = true
	}

	function clearOffers() {
		availableOffers.value = []
		hasFetched.value = false
	}

	/**
	 * Set of brands targeted by any available Brand offer. Used to decide whether
	 * an item's sub-brand actually has an offer.
	 */
	const offerBrandSet = computed(() => {
		const set = new Set()
		for (const offer of availableOffers.value) {
			if (offer?.apply_on === "Brand") {
				for (const brand of offer.eligible_brands || []) {
					if (brand) set.add(brand)
				}
			}
		}
		return set
	})

	/**
	 * Effective brands of the cart for offer matching. Per item, the sub-brand is
	 * used when it has an offer (present in offerBrandSet); otherwise the item's
	 * brand is used. This mirrors taraknath/overrides/pricing_rule.py: sub-brand
	 * takes priority, but falls back to brand when the sub-brand has no rule.
	 */
	const effectiveCartBrands = computed(() => {
		const pairs = cartSnapshot.value.itemBrandPairs || []
		const brands = new Set()
		for (const pair of pairs) {
			const useSub = pair.subBrand && offerBrandSet.value.has(pair.subBrand)
			const brand = useSub ? pair.subBrand : pair.brand
			if (brand) brands.add(brand)
		}
		// Fallback for older cart snapshots that only carried `brands`.
		if (!pairs.length) {
			for (const brand of cartSnapshot.value.brands || []) {
				if (brand) brands.add(brand)
			}
		}
		return brands
	})

	/**
	 * Checks if an offer is eligible based on current cart state
	 * @param {Object} offer - The offer to check
	 * @returns {Object} {eligible: boolean, reason: string|null}
	 */
	/**
	 * The cart lines a given offer targets, plus their combined qty & amount.
	 *
	 * This is what makes offers apply 1-to-1 over items: an offer's thresholds are
	 * measured against ONLY the lines it matches (by item code / item group /
	 * effective brand), not against the whole cart. `Transaction` offers span the
	 * whole cart by definition.
	 */
	function getOfferScope(offer) {
		const lines = cartSnapshot.value.lines || []
		const applyOn = offer?.apply_on
		let matched

		if (applyOn === "Item Code") {
			const elig = offer.eligible_items || []
			matched = elig.length
				? lines.filter((l) => elig.includes(l.itemCode))
				: lines
		} else if (applyOn === "Item Group") {
			const elig = offer.eligible_item_groups || []
			matched = elig.length
				? lines.filter((l) => elig.includes(l.itemGroup))
				: lines
		} else if (applyOn === "Brand") {
			const elig = offer.eligible_brands || []
			matched = elig.length
				? lines.filter((l) => {
						// Same effective-brand rule as effectiveCartBrands: prefer the
						// sub-brand when it has an offer, else the item's brand.
						const useSub =
							l.subBrand && offerBrandSet.value.has(l.subBrand)
						const eff = useSub ? l.subBrand : l.brand
						return elig.includes(eff)
					})
				: lines
		} else {
			// Transaction (or unspecified): the whole cart.
			matched = lines
		}

		const qty = matched.reduce((s, l) => s + (l.qty || 0), 0)
		const amount = matched.reduce((s, l) => s + (l.amount || 0), 0)
		return { lines: matched, qty, amount, isTransaction: applyOn === "Transaction" || !applyOn }
	}

	function checkOfferEligibility(offer) {
		const itemCount = cartSnapshot.value.itemCount || 0

		// Check if cart is empty
		if (itemCount === 0) {
			return {
				eligible: false,
				reason: "Cart is empty",
			}
		}

		const scope = getOfferScope(offer)

		// Item-specific offers must actually match at least one cart line.
		if (!scope.isTransaction && scope.lines.length === 0) {
			const reasonByApplyOn = {
				"Item Code": __("Cart does not contain eligible items for this offer"),
				"Item Group": __("Cart does not contain items from eligible groups"),
				Brand: "Cart does not contain items from eligible brands",
			}
			return {
				eligible: false,
				reason:
					reasonByApplyOn[offer?.apply_on] ||
					__("Cart does not contain eligible items for this offer"),
			}
		}

		// Thresholds are measured against the offer's OWN items (1-to-1), except
		// Transaction offers which are measured against the whole cart.
		const qty = scope.isTransaction ? itemCount : scope.qty
		const amount = scope.isTransaction
			? cartSnapshot.value.subtotal || 0
			: scope.amount

		// Minimum quantity (e.g., "Buy 2 Get 1 Free" requires at least 2 of the item)
		if (offer?.min_qty && qty < offer.min_qty) {
			return {
				eligible: false,
				reason: __('At least {0} items required', [offer.min_qty]),
			}
		}

		// Maximum quantity (offer only valid for up to N of the matched item)
		if (offer?.max_qty && qty > offer.max_qty) {
			return {
				eligible: false,
				reason: __('Maximum {0} items allowed for this offer', [offer.max_qty]),
			}
		}

		// Minimum amount (of the matched items)
		if (offer?.min_amt && amount < offer.min_amt) {
			return {
				eligible: false,
				reason: __('Minimum value of {0} required', [offer.min_amt]),
			}
		}

		// Maximum amount (of the matched items)
		if (offer?.max_amt && amount > offer.max_amt) {
			return {
				eligible: false,
				reason: __('Maximum value exceeded ({0})', [offer.max_amt]),
			}
		}

		return { eligible: true, reason: null }
	}

	const allEligibleOffers = computed(() => {
		return availableOffers.value.filter((offer) => {
			if (offer?.coupon_based) {
				return false
			}

			const eligibility = checkOfferEligibility(offer)
			return eligibility.eligible
		})
	})

	const allEligibleOffersSorted = computed(() => {
		return [...allEligibleOffers.value].sort((a, b) => {
			return getDiscountSortValue(b) - getDiscountSortValue(a)
		})
	})

	const autoEligibleOffers = computed(() => {
		return availableOffers.value.filter((offer) => {
			if (!offer?.auto || offer?.coupon_based) {
				return false
			}

			const eligibility = checkOfferEligibility(offer)
			return eligibility.eligible
		})
	})

	const autoEligibleCount = computed(() => autoEligibleOffers.value.length)

	function getUnlockAmount(offer) {
		const subtotal = cartSnapshot.value.subtotal || 0
		if (offer?.min_amt && subtotal < offer.min_amt) {
			return offer.min_amt - subtotal
		}
		return 0
	}

	return {
		// State
		availableOffers,
		cartSnapshot,
		hasFetched,

		// Computed
		allEligibleOffers,
		allEligibleOffersSorted,
		autoEligibleOffers,
		autoEligibleCount,

		// Actions
		updateCartSnapshot,
		resetCartSnapshot,
		setAvailableOffers,
		clearOffers,
		checkOfferEligibility,
		getUnlockAmount,
	}
})
