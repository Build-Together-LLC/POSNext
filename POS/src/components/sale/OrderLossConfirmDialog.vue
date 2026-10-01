<template>
	<Dialog
		v-model="isOpen"
		:options="{ title: __('Record Loss of Order'), size: 'md' }"
	>
		<template #body-content>
			<div v-if="prompt" class="py-2">
				<p class="text-sm font-semibold text-gray-900">
					{{ prompt.item_name }}
				</p>
				<p class="text-xs text-gray-500 mb-4">{{ prompt.item_code }}</p>

				<div class="grid grid-cols-3 gap-2.5 mb-4">
					<div class="rounded-lg bg-gray-50 p-2.5 text-center sm:text-start">
						<p class="text-xs text-gray-500">{{ __("Available") }}</p>
						<p class="text-sm sm:text-base font-semibold text-gray-900">
							{{ formatQty(availableQtyForPrompt) }}
						</p>
					</div>
					<div class="rounded-lg bg-orange-50 p-2.5 text-center sm:text-start">
						<p class="text-xs text-orange-700">{{ __("Lost Qty") }}</p>
						<p class="text-sm sm:text-base font-semibold text-orange-700">
							{{ formatQty(lostQty) }}
						</p>
					</div>
					<div class="rounded-lg bg-red-50 p-2.5 text-center sm:text-start">
						<p class="text-xs text-red-700">{{ __("Lost Value") }}</p>
						<p class="text-sm sm:text-base font-semibold text-red-700">
							{{ formatCurrency(lostValue) }}
						</p>
					</div>
				</div>

				<div class="grid grid-cols-2 gap-3 mb-2">
					<div>
						<label class="text-xs font-medium text-gray-700 block mb-1">
							{{ __("Quantity") }}
							<span v-if="prompt.uom" class="text-gray-400 font-normal">({{ prompt.uom }})</span>
						</label>
						<input
							ref="qtyInput"
							v-model.number="demanded"
							type="number"
							min="0"
							step="any"
							class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
							@keyup.enter="confirm"
						/>
					</div>
					<div>
						<label class="text-xs font-medium text-gray-700 block mb-1">
							{{ __("Rate") }}
							<span v-if="currency" class="text-gray-400 font-normal">({{ currency }})</span>
						</label>
						<input
							v-model.number="rate"
							type="number"
							min="0"
							step="any"
							class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
							@keyup.enter="confirm"
						/>
					</div>
				</div>

				<p v-if="!isALoss" class="mt-2 text-xs text-gray-500">
					{{ __("That is within what the till can sell, so nothing will be recorded.") }}
				</p>
			</div>
		</template>

		<template #actions>
			<div class="flex gap-2">
				<Button class="flex-1" @click="dismiss">
					{{ __("Not a loss") }}
				</Button>
				<Button
					class="flex-1"
					variant="solid"
					theme="blue"
					:disabled="!isALoss"
					@click="confirm"
				>
					{{ __("Record") }}
				</Button>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
// Asks the cashier to confirm a shortfall before it is recorded as lost demand.
import { useToast } from "@/composables/useToast"
import { usePOSCartStore } from "@/stores/posCart"
import { usePOSOrderLossStore } from "@/stores/orderLoss"
import { usePOSShiftStore } from "@/stores/posShift"
import { formatCurrency as formatCurrencyUtil } from "@/utils/currency"
import { Button, Dialog } from "frappe-ui"
import { computed, nextTick, ref, watch } from "vue"

const props = defineProps({
	currency: {
		type: String,
		default: "",
	},
})

const cartStore = usePOSCartStore()
const orderLossStore = usePOSOrderLossStore()
const shiftStore = usePOSShiftStore()
const { showSuccess } = useToast()

const demanded = ref(1)
const rate = ref(0)
const qtyInput = ref(null)

const prompt = computed(() => orderLossStore.pendingPrompt)

const currency = computed(() => props.currency || shiftStore.profileCurrency || "")

const isOpen = computed({
	get: () => Boolean(prompt.value),
	// Closing by backdrop or Escape is the same answer as "Not a loss".
	set: (value) => {
		if (!value) orderLossStore.dismissPrompt()
	},
})

const existingCartItem = computed(() => {
	if (!prompt.value?.item_code) return null
	return (
		(cartStore.invoiceItems || []).find(
			(i) =>
				i.item_code === prompt.value.item_code &&
				(!prompt.value.uom || (i.uom || i.stock_uom) === prompt.value.uom) &&
				(Number(i.quantity) || 0) > 0,
		) || null
	)
})

const availableQtyForPrompt = computed(() => {
	if (existingCartItem.value) {
		return Number(existingCartItem.value.quantity) || 0
	}
	return prompt.value?.available_qty || 0
})

const lostQty = computed(() =>
	Math.max((Number(demanded.value) || 0) - availableQtyForPrompt.value, 0),
)

const lostValue = computed(() => lostQty.value * (Number(rate.value) || 0))

const isALoss = computed(() => lostQty.value > 0)

watch(
	prompt,
	async (value) => {
		if (!value) return

		if (existingCartItem.value) {
			demanded.value =
				existingCartItem.value.ordered_qty ||
				(existingCartItem.value.quantity + 1)
		} else {
			demanded.value = value.demanded_qty || 1
		}
		rate.value = Number(value.rate) || 0
		await nextTick()
		qtyInput.value?.select?.()
	},
	{ immediate: true },
)

function formatQty(qty) {
	return Number(qty || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function formatCurrency(val) {
	return formatCurrencyUtil(Number(val) || 0, currency.value)
}

async function confirm() {
	if (!isALoss.value) return

	const currentPrompt = prompt.value
	const itemName = currentPrompt?.item_name || currentPrompt?.item_code || "Item"
	const qty = Number(demanded.value) || 0
	const rateVal = Math.max(Number(rate.value) || 0, 0)
	const inCartItem = existingCartItem.value
	const availQty = availableQtyForPrompt.value

	if (inCartItem) {
		orderLossStore.confirmPrompt(qty, rateVal, availQty)
		// Available qty was > 0 (e.g. 3) and reached 0 while adding to cart.
		// Keep in cart and display the loss badge beside qty (e.g. 3/10 - 7).
		inCartItem.ordered_qty = qty
		if (rateVal > 0) {
			inCartItem.rate = rateVal
			inCartItem.price_list_rate = rateVal
			cartStore.recalculateItem?.(inCartItem)
			cartStore.rebuildIncrementalCache?.()
		}
		showSuccess(__('Loss of order recorded for "{0}" ({1} units)', [itemName, qty]))
	} else {
		// Initially 0 qty was available.
		// Dismiss the prompt from queue and record directly to backend as a new record!
		orderLossStore.dismissPrompt()

		const zeroQtyItem = (cartStore.invoiceItems || []).find(
			(i) =>
				i.item_code === currentPrompt.item_code &&
				(!currentPrompt.uom || (i.uom || i.stock_uom) === currentPrompt.uom) &&
				(Number(i.quantity) || 0) <= 0,
		)
		if (zeroQtyItem) {
			cartStore.removeItem(zeroQtyItem.line_id || zeroQtyItem.item_code, zeroQtyItem.uom)
		}

		try {
			await orderLossStore.recordDirectLoss({
				item: currentPrompt.item || currentPrompt,
				demandedQty: qty,
				rate: rateVal,
				availableQty: 0,
				source: currentPrompt.source || "Catalog Click",
				reason: currentPrompt.reason,
			})
		} catch (error) {
			console.warn("Could not record loss of order directly", error)
		}
		showSuccess(__('Loss of order recorded for "{0}" ({1} units)', [itemName, qty]))
	}
}

function dismiss() {
	orderLossStore.dismissPrompt()
}
</script>
