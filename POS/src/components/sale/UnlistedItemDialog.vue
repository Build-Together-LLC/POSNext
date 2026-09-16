<template>
	<Dialog
		v-model="isOpen"
		:options="{ title: __('Item We Do Not Carry'), size: 'md' }"
	>
		<template #body-content>
			<div class="py-2 flex flex-col gap-3">
				<p class="text-xs text-gray-500">
					{{ __("Record what the customer asked for. It goes on the buying list, not on this sale.") }}
				</p>

				<div>
					<label class="text-xs font-medium text-gray-700 block mb-1">
						{{ __("What did they ask for?") }}
					</label>
					<input
						ref="itemInput"
						v-model="form.requested_item"
						type="text"
						:placeholder="__('e.g. Bosch wiper blade 24 inch')"
						class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
						@keyup.enter="submit"
					/>
				</div>

				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="text-xs font-medium text-gray-700 block mb-1">
							{{ __("Qty") }}
						</label>
						<input
							v-model.number="form.qty"
							type="number"
							min="0"
							step="any"
							class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
						/>
					</div>
					<div>
						<label class="text-xs font-medium text-gray-700 block mb-1">
							{{ __("Brand") }}
						</label>
						<input
							v-model="form.brand"
							type="text"
							class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
						/>
					</div>
				</div>

				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="text-xs font-medium text-gray-700 block mb-1">
							{{ __("Price they expected") }}
						</label>
						<input
							v-model.number="form.estimated_rate"
							type="number"
							min="0"
							step="any"
							class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
						/>
					</div>
					<div>
						<label class="text-xs font-medium text-gray-700 block mb-1">
							{{ __("Contact no") }}
						</label>
						<input
							v-model="form.contact_no"
							type="text"
							:placeholder="__('To call back once stocked')"
							class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
						/>
					</div>
				</div>

				<div>
					<label class="text-xs font-medium text-gray-700 block mb-1">
						{{ __("Notes") }}
					</label>
					<textarea
						v-model="form.notes"
						rows="2"
						class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>

				<p v-if="customerLabel" class="text-xs text-gray-500">
					{{ __("Recorded against {0}", [customerLabel]) }}
				</p>
			</div>
		</template>

		<template #actions>
			<div class="flex gap-2">
				<Button class="flex-1" @click="isOpen = false">
					{{ __("Cancel") }}
				</Button>
				<Button
					class="flex-1"
					variant="solid"
					theme="blue"
					:loading="saving"
					:disabled="!canSubmit"
					@click="submit"
				>
					{{ __("Record") }}
				</Button>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
// Captures demand for something the shop does not sell at all.
//
// The other half of loss of order: POS Order Loss needs an item to be short of,
// and this is the case where there is no item - the customer asks, nothing can
// be added to the cart, and without this the request leaves no trace.
import { call } from "@/utils/apiWrapper"
import { useToast } from "@/composables/useToast"
import { Button, Dialog } from "frappe-ui"
import { computed, nextTick, ref, watch } from "vue"

const props = defineProps({
	modelValue: Boolean,
	posProfile: String,
	posOpeningShift: String,
	customer: [Object, String],
	// Whatever the cashier had typed in the search box when they gave up.
	initialText: {
		type: String,
		default: "",
	},
})

const emit = defineEmits(["update:modelValue", "recorded"])

const { showSuccess, showError } = useToast()

const saving = ref(false)
const itemInput = ref(null)

const blank = () => ({
	requested_item: "",
	qty: 1,
	brand: "",
	estimated_rate: 0,
	contact_no: "",
	notes: "",
})

const form = ref(blank())

const isOpen = computed({
	get: () => props.modelValue,
	set: (value) => emit("update:modelValue", value),
})

const customerName = computed(
	() => props.customer?.customer_name || props.customer?.name || props.customer || null,
)

const customerLabel = computed(() => customerName.value || null)

const canSubmit = computed(
	() => Boolean(String(form.value.requested_item || "").trim()) && Number(form.value.qty) > 0,
)

watch(isOpen, async (open) => {
	if (!open) return

	form.value = { ...blank(), requested_item: props.initialText || "" }
	await nextTick()
	itemInput.value?.focus?.()
})

async function submit() {
	if (!canSubmit.value || saving.value) return

	saving.value = true
	try {
		const result = await call("pos_next.api.order_loss.record_unlisted_demand", {
			requested_item: form.value.requested_item,
			pos_profile: props.posProfile,
			qty: form.value.qty,
			brand: form.value.brand || null,
			estimated_rate: form.value.estimated_rate || 0,
			customer: props.customer?.name || props.customer || null,
			contact_no: form.value.contact_no || null,
			notes: form.value.notes || null,
			pos_opening_shift: props.posOpeningShift || null,
		})

		if (result?.enabled === false) {
			showError(__("Loss of order is switched off for this POS Profile."))
			return
		}

		showSuccess(__("Recorded: {0}", [result?.requested_item || form.value.requested_item]))
		emit("recorded", result)
		isOpen.value = false
	} catch (error) {
		console.error("Could not record the request:", error)
		showError(error.message || __("Could not record the request"))
	} finally {
		saving.value = false
	}
}
</script>
