<template>
	<Dialog v-model="isOpen" :options="{ title: __('Loss of Order'), size: '3xl' }">
		<template #body-content>
			<div class="py-2">
				<div class="flex items-center justify-between mb-3">
					<p class="text-xs text-gray-500">
						{{
							posOpeningShift
								? __("What this shift could not sell")
								: __("What could not be sold today")
						}}
					</p>
					<Button variant="subtle" :loading="loading" @click="load">
						{{ __("Refresh") }}
					</Button>
				</div>

				<div class="grid grid-cols-3 gap-3 mb-4">
					<div class="rounded-lg bg-gray-50 p-3">
						<p class="text-xs text-gray-500">{{ __("Items short") }}</p>
						<p class="text-lg font-semibold text-gray-900">{{ rows.length }}</p>
					</div>
					<div class="rounded-lg bg-orange-50 p-3">
						<p class="text-xs text-orange-700">{{ __("Qty lost") }}</p>
						<p class="text-lg font-semibold text-orange-700">
							{{ formatQty(totals.qty) }}
						</p>
					</div>
					<div class="rounded-lg bg-red-50 p-3">
						<p class="text-xs text-red-700">{{ __("Value lost") }}</p>
						<p class="text-lg font-semibold text-red-700">
							{{ formatCurrency(totals.value) }}
						</p>
					</div>
				</div>

				<div v-if="loading" class="py-10 text-center text-sm text-gray-500">
					{{ __("Loading...") }}
				</div>

				<div
					v-else-if="rows.length === 0"
					class="py-10 text-center text-sm text-gray-500"
				>
					{{ __("Nothing recorded - every customer got what they asked for.") }}
				</div>

				<div v-else class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="text-xs text-gray-500 border-b border-gray-200">
								<th class="text-start py-2 font-medium">{{ __("Item") }}</th>
								<th class="text-end py-2 font-medium">{{ __("Wanted") }}</th>
								<th class="text-end py-2 font-medium">{{ __("Sold") }}</th>
								<th class="text-end py-2 font-medium">{{ __("Lost") }}</th>
								<th class="text-end py-2 font-medium">{{ __("Value") }}</th>
								<th class="text-start py-2 font-medium ps-4">{{ __("Reason") }}</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="row in rows"
								:key="row.name"
								class="border-b border-gray-100"
							>
								<td class="py-2">
									<p class="font-medium text-gray-900">{{ row.item_name }}</p>
									<p class="text-xs text-gray-500">
										{{ row.item_code }} · {{ row.uom }}
									</p>
								</td>
								<td class="text-end">{{ formatQty(row.demanded_qty) }}</td>
								<td class="text-end text-gray-500">
									{{ formatQty(row.sold_qty) }}
								</td>
								<td class="text-end font-semibold text-orange-700">
									{{ formatQty(row.lost_qty) }}
								</td>
								<td class="text-end">{{ formatCurrency(row.lost_value) }}</td>
								<td class="ps-4">
									<span class="text-xs text-gray-600">{{ row.reason }}</span>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
// What the till was asked for and could not sell, for whoever is standing at
// it. Read-only on purpose: correcting a row is a supervisor's job in the desk,
// where the change is tracked.
import { call } from "@/utils/apiWrapper"
import { formatCurrency as formatCurrencyUtil } from "@/utils/currency"
import { Button, Dialog } from "frappe-ui"
import { computed, ref, watch } from "vue"

const props = defineProps({
	modelValue: Boolean,
	posProfile: String,
	posOpeningShift: String,
	currency: {
		type: String,
		default: "USD",
	},
})

const emit = defineEmits(["update:modelValue"])

const isOpen = computed({
	get: () => props.modelValue,
	set: (value) => emit("update:modelValue", value),
})

const rows = ref([])
const loading = ref(false)

const totals = computed(() =>
	rows.value.reduce(
		(acc, row) => ({
			qty: acc.qty + Number(row.lost_qty || 0),
			value: acc.value + Number(row.lost_value || 0),
		}),
		{ qty: 0, value: 0 },
	),
)

async function load() {
	if (!props.posProfile) return

	loading.value = true
	try {
		rows.value =
			(await call("pos_next.api.order_loss.get_order_losses", {
				pos_profile: props.posProfile,
				pos_opening_shift: props.posOpeningShift || null,
			})) || []
	} catch (error) {
		console.error("Could not load lost demand:", error)
		rows.value = []
	} finally {
		loading.value = false
	}
}

watch(isOpen, (open) => {
	if (open) load()
})

function formatQty(qty) {
	return Number(qty || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function formatCurrency(value) {
	return formatCurrencyUtil(value || 0, props.currency)
}
</script>
