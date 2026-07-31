<template>
	<!-- Main Dialog -->
	<Dialog
		v-model="show"
		:options="{ title: __('Draft Invoices'), size: 'lg' }"
	>
		<template #body-content>
			<div class="flex flex-col gap-3">
				<!-- Search/Filter Input -->
				<Input
					v-if="drafts.length > 0"
					v-model="draftListFilter"
					type="text"
					:placeholder="__('Search by draft ID or customer name...')"
					class="w-full"
				/>

				<!-- Empty State -->
				<div v-if="drafts.length === 0" class="text-center py-8">
					<div class="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
						<svg class="h-8 w-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
						</svg>
					</div>
					<p class="text-sm font-medium text-gray-900">{{ __('No draft invoices') }}</p>
					<p class="text-xs text-gray-500 mt-1">{{ __('Save invoices as drafts to continue later') }}</p>
				</div>

				<!-- No Search Results -->
				<div v-else-if="filteredDrafts.length === 0" class="text-center py-8">
					<p class="text-sm font-medium text-gray-900">{{ __('No matching drafts') }}</p>
					<p class="text-xs text-gray-500 mt-1">{{ __('Try a different draft ID or customer name') }}</p>
				</div>

				<!-- Drafts List -->
				<div v-else class="flex flex-col gap-2 max-h-96 overflow-y-auto">
					<div
						v-for="draft in filteredDrafts"
						:key="draft.draft_id"
						class="bg-white border border-gray-200 rounded-lg p-3 hover:border-blue-400 transition-all cursor-pointer"
						@click="$emit('load-draft', draft)"
					>
						<div class="flex items-start justify-between mb-2">
							<div class="flex-1">
								<h4 class="text-sm font-semibold text-gray-900">
									{{ draft.draft_id }}
								</h4>
								<p v-if="draft.customer" class="text-xs text-gray-500 mt-0.5">
									{{ __('Customer: {0}', [(draft.customer?.customer_name || draft.customer?.name || draft.customer)]) }}
								</p>
								<p class="text-xs text-gray-400 mt-0.5">
									{{ formatDateTime(draft.created_at) }}
								</p>
							</div>
							<div class="flex items-center gap-1">
								<button
									@click.stop="handlePrintDraft(draft)"
									class="text-gray-400 hover:text-blue-600 transition-colors p-1"
									:title="__('Print draft')"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
									</svg>
								</button>
								<button
									@click.stop="handleDeleteDraft(draft.draft_id)"
									class="text-gray-400 hover:text-red-600 transition-colors p-1"
									:title="__('Delete draft')"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
									</svg>
								</button>
							</div>
						</div>

						<!-- Items Preview -->
						<div class="flex items-center justify-between text-xs">
							<span class="text-gray-600">
								{{ __('{0} item(s)', [draft.items?.length || 0]) }}
							</span>
							<span class="font-bold text-blue-600">
								{{ formatCurrency(draftTotal(draft)) }}
							</span>
						</div>

						<!-- Items List (condensed) -->
						<div v-if="draft.items && draft.items.length > 0" class="mt-2 pt-2 border-t border-gray-100">
							<div class="flex flex-wrap gap-1">
								<span
									v-for="(item, idx) in draft.items.slice(0, 3)"
									:key="idx"
									class="text-[10px] bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded"
								>
									{{ item.item_name }} ({{ item.quantity || item.qty }})
								</span>
								<span
									v-if="draft.items.length > 3"
									class="text-[10px] text-gray-500 px-1.5 py-0.5"
								>
									{{ __('+{0} more', [draft.items.length - 3]) }}
								</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</template>
		<template #actions>
			<div class="flex justify-between items-center w-full">
				<Button
					v-if="drafts.length > 0"
					variant="subtle"
					theme="red"
					@click="showClearAllDialog = true"
				>
					{{ __('Clear All') }}
				</Button>
				<Button variant="subtle" @click="show = false">
					{{ __('Close') }}
				</Button>
			</div>
		</template>
	</Dialog>

	<!-- Delete Single Draft Confirmation -->
	<Dialog
		v-model="showDeleteDialog"
		:options="{ title: __('Delete Draft?'), size: 'xs' }"
	>
		<template #body-content>
			<div class="py-3">
				<p class="text-sm text-gray-600">
					{{ __('Permanently delete this draft invoice?') }}
				</p>
			</div>
		</template>
		<template #actions>
			<div class="flex gap-2 w-full">
				<Button class="flex-1" variant="subtle" @click="showDeleteDialog = false">
					{{ __('Cancel') }}
				</Button>
				<Button class="flex-1" variant="solid" theme="red" @click="confirmDeleteDraft">
					{{ __('Delete') }}
				</Button>
			</div>
		</template>
	</Dialog>

	<!-- Clear All Drafts Confirmation -->
	<Dialog
		v-model="showClearAllDialog"
		:options="{ title: __('Clear All Drafts?'), size: 'xs' }"
	>
		<template #body-content>
			<div class="py-3">
				<p class="text-sm text-gray-600">
					{{ __('Permanently delete all {0} draft invoices?', [drafts.length]) }}
				</p>
			</div>
		</template>
		<template #actions>
			<div class="flex gap-2 w-full">
				<Button class="flex-1" variant="subtle" @click="showClearAllDialog = false">
					{{ __('Cancel') }}
				</Button>
				<Button class="flex-1" variant="solid" theme="red" @click="confirmClearAll">
					{{ __('Clear All') }}
				</Button>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import { formatCurrency as formatCurrencyUtil } from "@/utils/currency"
import { printDraftReceipt } from "@/utils/printInvoice"
import { useToast } from "@/composables/useToast"
import { usePOSDraftsStore } from "@/stores/posDrafts"
import { usePOSShiftStore } from "@/stores/posShift"
import { Button, Dialog, Input } from "frappe-ui"
import { computed, onMounted, ref, watch } from "vue"

const { showError } = useToast()
const shiftStore = usePOSShiftStore()
// Reading through the store keeps this dialog agnostic of where drafts live -
// IndexedDB or server-side Sales Invoice drafts. It lists both.
const draftsStore = usePOSDraftsStore()

const props = defineProps({
	modelValue: Boolean,
	currency: {
		type: String,
		default: "USD",
	},
})

const emit = defineEmits(["update:modelValue", "load-draft", "drafts-updated"])

const show = ref(props.modelValue)
const drafts = ref([])
const draftListFilter = ref("")
const showDeleteDialog = ref(false)
const showClearAllDialog = ref(false)
const draftToDelete = ref(null)

// Customer is stored either as a doc-like object or a plain name string.
function draftCustomerName(draft) {
	const customer = draft.customer
	if (!customer) return ""
	if (typeof customer === "string") return customer
	return customer.customer_name || customer.name || ""
}

const filteredDrafts = computed(() => {
	if (!drafts.value || !Array.isArray(drafts.value)) {
		return []
	}
	if (!draftListFilter.value) return drafts.value

	const filter = draftListFilter.value.toLowerCase()
	return drafts.value.filter(
		(draft) =>
			draft.draft_id?.toLowerCase().includes(filter) ||
			draftCustomerName(draft).toLowerCase().includes(filter),
	)
})

watch(
	() => props.modelValue,
	(val) => {
		show.value = val
		if (val) {
			draftListFilter.value = ""
			loadDrafts()
		}
	},
)

watch(show, (val) => {
	emit("update:modelValue", val)
})

onMounted(() => {
	loadDrafts()
})

async function loadDrafts() {
	try {
		await draftsStore.loadDrafts()
	} catch (error) {
		console.error("Error loading drafts:", error)
		showError(__("Failed to load draft invoices"))
	}
}

async function handlePrintDraft(draft) {
	try {
		// Server drafts are listed as summaries - fetch the full cart so the
		// receipt prints real rates, discounts and UOMs.
		const source = (await draftsStore.hydrateDraft(draft)) || draft

		const customerObj = source.customer
		const customerName = typeof customerObj === "object"
			? (customerObj?.customer_name || customerObj?.name || "")
			: (customerObj || "")
		const addressDisplay = typeof customerObj === "object"
			? (customerObj?.address_display || customerObj?.primary_address || customerObj?.address || "")
			: ""

		const invoiceData = {
			name: draft.draft_id,
			company: shiftStore.profileCompany,
			pos_profile: source.pos_profile || shiftStore.profileName,
			customer: customerObj,
			items: source.items || [],
			payments: [],
			grand_total: calculateTotal(source.items),
			posting_date: source.created_at || draft.created_at,
			customer_name: customerName,
			address_display: addressDisplay,
			status: "Draft",
			is_draft: true,
			docstatus: 0,
		}
		printDraftReceipt(invoiceData)
	} catch (error) {
		console.error("Error printing draft:", error)
		showError(__("Failed to print draft"))
	}
}

function handleDeleteDraft(draftId) {
	draftToDelete.value = draftId
	showDeleteDialog.value = true
}

async function confirmDeleteDraft() {
	// The store owns the toast and the list refresh, and routes the delete to
	// whichever backend this draft lives in.
	await draftsStore.deleteDraft(draftToDelete.value)
	showDeleteDialog.value = false
	draftToDelete.value = null

	// Notify parent to update count
	emit("drafts-updated")
}

async function confirmClearAll() {
	await draftsStore.deleteAllDrafts()
	showClearAllDialog.value = false

	// Notify parent to update count
	emit("drafts-updated")
}

function formatDateTime(dateStr) {
	const date = new Date(dateStr)
	return date.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})
}

function formatCurrency(amount) {
	return formatCurrencyUtil(Number.parseFloat(amount || 0), props.currency)
}

function calculateTotal(items) {
	if (!items || items.length === 0) return 0
	return items.reduce((sum, item) => {
		const qty = item.quantity || item.qty || 1
		const rate = item.rate || 0
		return sum + qty * rate
	}, 0)
}

/** Server drafts carry the invoice total; cached drafts are summed line by line. */
function draftTotal(draft) {
	return draft?.grand_total != null
		? draft.grand_total
		: calculateTotal(draft?.items)
}
</script>
