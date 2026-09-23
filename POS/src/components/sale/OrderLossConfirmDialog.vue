<template>
	<Dialog
		v-model="isOpen"
		:options="{ title: __('Record Lost Sale'), size: 'sm' }"
	>
		<template #body-content>
			<div v-if="prompt" class="py-2">
				<p class="text-sm font-semibold text-gray-900">
					{{ prompt.item_name }}
				</p>
				<p class="text-xs text-gray-500 mb-4">{{ prompt.item_code }}</p>

				<div class="grid grid-cols-2 gap-3 mb-4">
					<div class="rounded-lg bg-gray-50 p-3">
						<p class="text-xs text-gray-500">{{ __("Available") }}</p>
						<p class="text-base font-semibold text-gray-900">
							{{ formatQty(prompt.available_qty) }}
						</p>
					</div>
					<div class="rounded-lg bg-orange-50 p-3">
						<p class="text-xs text-orange-700">{{ __("Lost") }}</p>
						<p class="text-base font-semibold text-orange-700">
							{{ formatQty(lostQty) }}
						</p>
					</div>
				</div>

				<label class="text-xs font-medium text-gray-700 block mb-1">
					{{ __("How many did the customer want?") }}
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
//
// It opens *after* the till has already refused or clamped the quantity, so the
// existing behaviour is untouched and nothing about the sale waits on this
// answer. The quantity is editable because the alternative — recording whatever
// was typed — turns one mistyped 1000 into 920 units of demand that never
// existed.
import { usePOSOrderLossStore } from "@/stores/orderLoss"
import { Button, Dialog } from "frappe-ui"
import { computed, nextTick, ref, watch } from "vue"

const orderLossStore = usePOSOrderLossStore()

const demanded = ref(0)
const qtyInput = ref(null)

const prompt = computed(() => orderLossStore.pendingPrompt)

const isOpen = computed({
	get: () => Boolean(prompt.value),
	// Closing by backdrop or Escape is the same answer as "Not a loss".
	set: (value) => {
		if (!value) orderLossStore.dismissPrompt()
	},
})

const lostQty = computed(() =>
	Math.max((Number(demanded.value) || 0) - (prompt.value?.available_qty || 0), 0),
)

const isALoss = computed(() => lostQty.value > 0)

watch(
	prompt,
	async (value) => {
		if (!value) return

		demanded.value = value.demanded_qty
		await nextTick()
		qtyInput.value?.select?.()
	},
	{ immediate: true },
)

function formatQty(qty) {
	return Number(qty || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function confirm() {
	if (!isALoss.value) return

	orderLossStore.confirmPrompt(Number(demanded.value) || 0)
}

function dismiss() {
	orderLossStore.dismissPrompt()
}
</script>
