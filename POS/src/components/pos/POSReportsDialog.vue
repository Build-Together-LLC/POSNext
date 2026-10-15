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
					<div
						v-for="report in reports"
						:key="report.title"
						class="border border-gray-200 hover:border-orange-300 hover:shadow-md rounded-xl p-4 transition-all bg-white flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 group"
					>
						<div class="flex items-start gap-3.5">
							<div :class="['p-2.5 rounded-lg text-white shrink-0 mt-0.5', report.bgClass]">
								<component :is="report.icon" class="w-5 h-5" />
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
import { computed, h } from "vue"

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

const emit = defineEmits(["update:modelValue"])

function close() {
	emit("update:modelValue", false)
}

// Icon helper functions
const BarChartIcon = () =>
	h("svg", { fill: "none", stroke: "currentColor", viewBox: "0 0 24 24" }, [
		h("path", {
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"stroke-width": "2",
			d: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
		}),
	])

const TrendingIcon = () =>
	h("svg", { fill: "none", stroke: "currentColor", viewBox: "0 0 24 24" }, [
		h("path", {
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"stroke-width": "2",
			d: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
		}),
	])

const AlertIcon = () =>
	h("svg", { fill: "none", stroke: "currentColor", viewBox: "0 0 24 24" }, [
		h("path", {
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"stroke-width": "2",
			d: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
		}),
	])

const FileTextIcon = () =>
	h("svg", { fill: "none", stroke: "currentColor", viewBox: "0 0 24 24" }, [
		h("path", {
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"stroke-width": "2",
			d: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
		}),
	])

const reports = computed(() => [
	{
		title: __("POS Demand vs Actual"),
		reportName: "POS Demand vs Actual",
		category: __("Demand Analysis"),
		description: __(
			"Analyze customer demand captured at the till against actual sales to identify unmet demand and missed opportunities.",
		),
		icon: TrendingIcon,
		bgClass: "bg-orange-500",
		badgeClass: "bg-orange-50 text-orange-700 border border-orange-200",
	},
	{
		title: __("POS Unlisted Item Demand"),
		reportName: "POS Unlisted Item Demand",
		category: __("Unlisted Items"),
		description: __(
			"Review cashier-recorded customer demand for products not currently listed in the catalogue.",
		),
		icon: AlertIcon,
		bgClass: "bg-purple-600",
		badgeClass: "bg-purple-50 text-purple-700 border border-purple-200",
	},
	{
		title: __("Sales Register"),
		reportName: "Sales Register",
		category: __("Invoices & Accounting"),
		description: __(
			"Comprehensive register of sales invoices with posting dates, payment status, customer details, and taxes.",
		),
		icon: FileTextIcon,
		bgClass: "bg-emerald-600",
		badgeClass: "bg-emerald-50 text-emerald-700 border border-emerald-200",
	},
	{
		title: __("Item-wise Sales Register"),
		reportName: "Item-wise Sales Register",
		category: __("Item Sales"),
		description: __(
			"Detailed register showing item-wise breakdown of sales invoices, quantities, and taxes.",
		),
		icon: FileTextIcon,
		bgClass: "bg-teal-600",
		badgeClass: "bg-teal-50 text-teal-700 border border-teal-200",
	},
])

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

