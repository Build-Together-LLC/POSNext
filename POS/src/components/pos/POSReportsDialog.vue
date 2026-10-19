<template>
	<Transition name="fade">
		<div
			v-if="modelValue"
			class="fixed inset-0 bg-black bg-opacity-50 z-[300] flex items-center justify-center p-4"
			@click.self="close"
		>
			<div class="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden flex flex-col max-h-[90vh]">
				<!-- Header -->
				<div class="px-6 py-5 bg-gradient-to-r from-orange-50 to-amber-50 border-b border-orange-100 flex items-center justify-between">
					<div class="flex items-center gap-3">
						<div class="p-2.5 bg-orange-500 text-white rounded-xl shadow-sm">
							<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
							</svg>
						</div>
						<div>
							<h3 class="text-xl font-bold text-gray-900">{{ __('POS Reports & Analytics') }}</h3>
							<p class="text-xs text-gray-600 mt-0.5">{{ __('Select a report to view detailed POS insights and performance in ERP') }}</p>
						</div>
					</div>
					<button
						@click="close"
						class="p-2 text-gray-400 hover:text-gray-600 hover:bg-white/80 rounded-lg transition-colors"
					>
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
						</svg>
					</button>
				</div>

				<!-- Reports List -->
				<div class="p-6 overflow-y-auto space-y-4">
					<!-- Reports Disabled State -->
					<div v-if="!isReportsEnabled" class="flex flex-col items-center justify-center py-12 px-6 text-center">
						<div class="w-14 h-14 bg-amber-100 text-amber-600 rounded-2xl flex items-center justify-center mb-4 shadow-sm">
							<svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
							</svg>
						</div>
						<h4 class="text-base font-bold text-gray-900 mb-1.5">{{ __('Reports Disabled') }}</h4>
						<p class="text-xs text-gray-600 max-w-md leading-relaxed">
							{{ __('To view reports, please enable the "Enable Reports in POSNext" setting in POS Settings.') }}
						</p>
						<button
							type="button"
							@click="openSettings"
							class="mt-4 px-4 py-2 bg-orange-50 hover:bg-orange-100 text-orange-700 font-semibold text-xs rounded-lg border border-orange-200 transition-colors inline-flex items-center gap-1.5"
						>
							<svg class="w-4 h-4 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
							</svg>
							<span>{{ __('Open POS Settings') }}</span>
						</button>
					</div>

					<div v-else-if="loadingReports" class="flex flex-col items-center justify-center py-12">
						<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mb-3"></div>
						<p class="text-xs text-gray-500">{{ __('Checking report permissions...') }}</p>
					</div>

					<div v-else-if="reports.length === 0" class="flex flex-col items-center justify-center py-12 text-center">
						<svg class="w-12 h-12 text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
						</svg>
						<p class="text-gray-700 font-semibold text-sm">{{ __('No accessible reports') }}</p>
						<p class="text-gray-500 text-xs mt-1">{{ __('You do not have permission to view these reports in ERP.') }}</p>
					</div>

					<div
						v-else
						v-for="report in reports"
						:key="report.title"
						class="border border-gray-200 hover:border-orange-300 hover:shadow-md rounded-xl p-4 transition-all bg-white flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 group"
					>
						<div class="flex items-start gap-3.5">
							<div
								:class="[
									'w-10 h-10 rounded-lg text-white flex items-center justify-center shrink-0 mt-0.5 shadow-sm',
									report.bgClass,
								]"
								:style="{ backgroundColor: report.bgColor }"
							>
								<!-- Demand Icon -->
								<svg
									v-if="report.iconType === 'trending'"
									class="w-5 h-5 text-white"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
									/>
								</svg>
								<!-- Alert Icon -->
								<svg
									v-else-if="report.iconType === 'alert'"
									class="w-5 h-5 text-white"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
									/>
								</svg>
								<!-- Book / Sales Register Icon -->
								<svg
									v-else-if="report.iconType === 'book'"
									class="w-5 h-5 text-white"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
									/>
								</svg>
								<!-- Package / Item-wise Icon -->
								<svg
									v-else-if="report.iconType === 'package'"
									class="w-5 h-5 text-white"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
									/>
								</svg>
								<!-- Default / Document Icon -->
								<svg
									v-else
									class="w-5 h-5 text-white"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
									/>
								</svg>
							</div>
							<div>
								<div class="flex items-center gap-2">
									<h4 class="font-bold text-gray-900 text-sm group-hover:text-orange-600 transition-colors">
										{{ report.title }}
									</h4>
									<span :class="['text-[11px] px-2 py-0.5 rounded-full font-semibold', report.badgeClass]">
										{{ report.category }}
									</span>
								</div>
								<p class="text-xs text-gray-600 mt-1 leading-relaxed">
									{{ report.description }}
								</p>
							</div>
						</div>

						<button
							@click="openReport(report)"
							class="w-full sm:w-auto px-4 py-2 bg-gray-50 hover:bg-orange-500 text-gray-700 hover:text-white font-semibold text-xs rounded-lg border border-gray-200 hover:border-orange-500 transition-all flex items-center justify-center gap-1.5 shrink-0"
						>
							<span>{{ __('Open Report') }}</span>
							<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
							</svg>
						</button>
					</div>
				</div>

				<!-- Footer -->
				<div class="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end">
					<button
						type="button"
						@click="close"
						class="px-4 py-2 bg-white border border-gray-300 hover:bg-gray-100 rounded-lg text-xs font-semibold text-gray-700 transition-colors"
					>
						{{ __('Close') }}
					</button>
				</div>
			</div>
		</div>
	</Transition>
</template>

<script setup>
import { call } from "frappe-ui"
import { computed, ref, watch } from "vue"
import { usePOSSettingsStore } from "@/stores/posSettings"

const props = defineProps({
	modelValue: Boolean,
	posProfile: {
		type: String,
		default: "",
	},
	company: {
		type: String,
		default: "",
	},
})

const emit = defineEmits(["update:modelValue", "open-settings"])

const posSettingsStore = usePOSSettingsStore()
const isReportsEnabled = computed(() => {
	return Boolean(posSettingsStore.enableReportsInPosNext)
})

function close() {
	emit("update:modelValue", false)
}

function openSettings() {
	close()
	emit("open-settings")
}

const accessibleReports = ref(null)
const loadingReports = ref(false)

async function loadAccessibleReports() {
	if (loadingReports.value || !isReportsEnabled.value) return
	loadingReports.value = true
	try {
		const res = await call("pos_next.api.invoices.get_accessible_reports", {
			pos_profile: props.posProfile || undefined,
		})
		accessibleReports.value = res?.message || res || []
	} catch (err) {
		console.error("Error loading accessible reports:", err)
		// On error, default to POS Demand reports which are core to POS
		accessibleReports.value = [
			"POS Demand vs Actual",
			"POS Unlisted Item Demand",
		]
	} finally {
		loadingReports.value = false
	}
}

watch(
	[() => props.modelValue, isReportsEnabled],
	([val, enabled]) => {
		if (val && enabled && accessibleReports.value === null) {
			loadAccessibleReports()
		}
	},
	{ immediate: true },
)

const ALL_REPORTS = [
	{
		title: __("POS Demand vs Actual"),
		reportName: "POS Demand vs Actual",
		category: __("Demand Analysis"),
		description: __(
			"Analyze customer demand captured at the till against actual sales to identify unmet demand and missed opportunities.",
		),
		iconType: "trending",
		bgClass: "bg-orange-500",
		bgColor: "#f97316",
		badgeClass: "bg-orange-50 text-orange-700 border border-orange-200",
	},
	{
		title: __("POS Unlisted Item Demand"),
		reportName: "POS Unlisted Item Demand",
		category: __("Unlisted Items"),
		description: __(
			"Review cashier-recorded customer demand for products not currently listed in the catalogue.",
		),
		iconType: "alert",
		bgClass: "bg-purple-600",
		bgColor: "#9333ea",
		badgeClass: "bg-purple-50 text-purple-700 border border-purple-200",
	},
	{
		title: __("Sales Register"),
		reportName: "Sales Register",
		category: __("Invoices & Accounting"),
		description: __(
			"Comprehensive register of sales invoices with posting dates, payment status, customer details, and taxes.",
		),
		iconType: "book",
		bgClass: "bg-green-600",
		bgColor: "#16a34a",
		badgeClass: "bg-green-50 text-green-700 border border-green-200",
	},
	{
		title: __("Item-wise Sales Register"),
		reportName: "Item-wise Sales Register",
		category: __("Item Sales"),
		description: __(
			"Detailed register showing item-wise breakdown of sales invoices, quantities, and taxes.",
		),
		iconType: "package",
		bgClass: "bg-teal-600",
		bgColor: "#0d9488",
		badgeClass: "bg-teal-50 text-teal-700 border border-teal-200",
	},
]

const reports = computed(() => {
	if (accessibleReports.value === null) {
		return ALL_REPORTS
	}
	return ALL_REPORTS.filter((report) =>
		accessibleReports.value.includes(report.reportName),
	)
})

function openReport(report) {
	const params = new URLSearchParams()
	if (
		props.posProfile &&
		[
			"POS Demand vs Actual",
			"POS Unlisted Item Demand",
		].includes(report.reportName)
	) {
		params.append("pos_profile", props.posProfile)
	}
	if (props.company) {
		params.append("company", props.company)
	}
	const queryString = params.toString() ? `?${params.toString()}` : ""
	const url = `/app/query-report/${encodeURIComponent(report.reportName)}${queryString}`
	window.open(url, "_blank")
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}
</style>

