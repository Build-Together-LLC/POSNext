<template>
	<!-- Full Page Overlay -->
	<Transition name="fade">
		<div
			v-if="show"
			class="fixed inset-0 bg-black bg-opacity-50 z-[300]"
			@click.self="handleClose"
		>
			<!-- Main Container -->
			<div class="fixed inset-0 flex items-center justify-center p-4">
				<div class="w-full h-full max-w-[95vw] max-h-[95vh] bg-white rounded-lg shadow-2xl overflow-hidden flex flex-col">
					<!-- Header -->
					<div class="flex items-center justify-between px-6 py-5 border-b bg-gradient-to-r from-indigo-50 to-purple-50">
						<div class="flex items-center gap-3">
							<div class="p-2 bg-indigo-100 rounded-lg">
								<svg class="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
								</svg>
							</div>
							<div>
								<h2 class="text-xl font-bold text-gray-900">{{ __('Invoice Management') }}</h2>
								<p class="text-sm text-gray-600 flex items-center mt-0.5">
									{{ __('Manage all your invoices in one place') }}
								</p>
							</div>
						</div>
						<div class="flex items-center gap-2">
							<Button
								@click="refreshCurrentTab"
								:loading="loading || loadingHistory || loadingReturns"
								variant="ghost"
								size="sm"
							>
								<template #prefix>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
									</svg>
								</template>
								{{ __('Refresh') }}
							</Button>
							<button
								@click="handleClose"
								class="p-2 hover:bg-white/50 rounded-lg transition-colors"
							>
								<svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
								</svg>
							</button>
						</div>
					</div>

					<!-- Tabs Navigation -->
					<div class="border-b border-gray-200 bg-gray-50">
						<nav class="flex gap-2 px-6" :aria-label="__('Tabs')">
							<button
								v-for="tab in tabs"
								:key="tab.id"
								@click="activeTab = tab.id"
								:class="[
									'px-4 py-3 text-sm font-semibold transition-all border-b-2 relative',
									activeTab === tab.id
										? getTabActiveClass(tab.id)
										: 'text-gray-600 border-transparent hover:text-gray-800 hover:border-gray-300'
								]"
							>
								<div class="flex items-center gap-2">
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="tab.icon"/>
									</svg>
									<span>{{ tab.label }}</span>
									<span
										v-if="tab.id === 'history' ? tab.count != null : (tab.count != null && tab.count > 0)"
										:class="[
											'ms-1 px-2 py-0.5 text-xs font-bold rounded-full',
											activeTab === tab.id ? getBadgeActiveClass(tab.id) : getBadgeInactiveClass(tab.id)
										]"
									>
										{{ tab.count }}
									</span>
								</div>
							</button>
						</nav>
					</div>

					<!-- Tab Content -->
					<div class="flex-1 overflow-y-auto bg-gray-50">
						<!-- Loading State -->
						<div v-if="loading && activeTab === 'partial'" class="flex flex-col items-center justify-center py-16">
							<div class="animate-spin rounded-full h-12 w-12 border-b-3 border-indigo-500 mb-4"></div>
							<p class="text-sm font-medium text-gray-600">{{ __('Loading {0}...', [currentTabLabel]) }}</p>
						</div>

						<!-- Tab Content -->
						<div class="p-6">
							<!-- Unpaid Tab -->
							<div v-if="activeTab === 'partial'" class="flex flex-col gap-4">
								<!-- Filter Buttons -->
								<div class="flex items-center gap-2 mb-4 flex-wrap gap-2">
									<button
										@click="unpaidFilter = 'all'"
										:class="[
											'px-4 py-2 rounded-lg font-medium text-sm transition-all',
											unpaidFilter === 'all'
												? 'bg-orange-500 text-white shadow-md'
												: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
										]"
									>
										{{ __('All ({0})', [unpaidInvoices.length]) }}
									</button>
									<button
										@click="unpaidFilter = 'partial'"
										:class="[
											'px-4 py-2 rounded-lg font-medium text-sm transition-all',
											unpaidFilter === 'partial'
												? 'bg-orange-500 text-white shadow-md'
												: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
										]"
									>
										{{ __('Partially Paid ({0})', [unpaidInvoices.filter(inv => inv.status === 'Partly Paid').length]) }}
									</button>
									<button
										@click="unpaidFilter = 'unpaid'"
										:class="[
											'px-4 py-2 rounded-lg font-medium text-sm transition-all',
											unpaidFilter === 'unpaid'
												? 'bg-orange-500 text-white shadow-md'
												: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
										]"
									>
										{{ __('Unpaid ({0})', [unpaidInvoices.filter(inv => inv.status === 'Unpaid').length]) }}
									</button>
									<button
										@click="unpaidFilter = 'overdue'"
										:class="[
											'px-4 py-2 rounded-lg font-medium text-sm transition-all',
											unpaidFilter === 'overdue'
												? 'bg-red-500 text-white shadow-md'
												: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
										]"
									>
										{{ __('Overdue ({0})', [unpaidInvoices.filter(inv => inv.status === 'Overdue').length]) }}
									</button>
								</div>

								<!-- Summary -->
								<div v-if="filteredUnpaidSummary.count > 0" class="bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-200 rounded-lg p-4">
									<div class="flex items-center justify-between">
										<div>
											<div class="text-sm text-orange-600 font-medium">{{ __('Outstanding Payments') }}</div>
											<div class="text-2xl font-bold text-gray-900 mt-1">{{ formatCurrency(filteredUnpaidSummary.total_outstanding) }}</div>
										</div>
										<div class="text-end">
											<div class="text-xs text-gray-600">{{ __('{0} invoices', [filteredUnpaidSummary.count]) }}</div>
											<div class="text-sm text-gray-800 font-semibold mt-1">{{ __('{0} paid', [formatCurrency(filteredUnpaidSummary.total_paid)]) }}</div>
										</div>
									</div>
								</div>

								<!-- Empty State -->
								<div v-if="filteredUnpaidInvoices.length === 0" class="flex flex-col items-center justify-center py-16 text-center">
									<svg class="w-16 h-16 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
									</svg>
									<p class="text-gray-600 font-medium">{{ __('No Unpaid Invoices') }}</p>
									<p class="text-gray-500 text-sm mt-1">{{ __('All invoices are fully paid') }}</p>
								</div>

								<!-- Invoices List -->
								<div v-else class="flex flex-col gap-4">
									<div
										v-for="invoice in filteredUnpaidInvoices"
										:key="invoice.name"
										class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow"
									>
										<!-- Invoice Header -->
										<div class="p-4 border-b bg-gray-50">
											<div class="flex items-start justify-between">
												<div>
													<div class="flex items-center gap-2">
														<h3 class="text-lg font-bold text-gray-900">{{ invoice.name }}</h3>
														<span
															:class="[
																'px-2 py-0.5 text-xs font-semibold rounded-full',
																getInvoiceStatusColor(invoice)
															]"
														>
															{{ __(invoice.status) }}
														</span>
													</div>
													<div class="flex items-center gap-4 mt-1 text-sm text-gray-600">
														<div class="flex items-center">
															<svg class="w-4 h-4 me-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
																<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
															</svg>
															{{ invoice.customer_name || invoice.customer }}
														</div>
														<div class="flex items-center">
															<svg class="w-4 h-4 me-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
																<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
															</svg>
															{{ formatDate(invoice.posting_date) }} {{ formatTime(invoice.posting_time) }}
														</div>
													</div>
												</div>
												<button
													@click="selectInvoiceForPayment(invoice)"
													class="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors text-sm font-semibold"
												>
													{{ __('Add Payment') }}
												</button>
											</div>
										</div>

										<!-- Payment Summary -->
										<div class="p-4">
											<div class="grid grid-cols-3 gap-4 mb-4">
												<div class="text-center p-3 bg-blue-50 rounded-lg border border-blue-100">
													<div class="text-xs text-gray-600 mb-1">{{ __('Total Amount') }}</div>
													<div class="text-lg font-bold text-gray-900">{{ formatCurrency(invoice.grand_total) }}</div>
												</div>
												<div class="text-center p-3 bg-green-50 rounded-lg border border-green-100">
													<div class="text-xs text-gray-600 mb-1">{{ __('Paid') }}</div>
													<div class="text-lg font-bold text-green-600">{{ formatCurrency(invoice.paid_amount) }}</div>
												</div>
												<div class="text-center p-3 bg-orange-50 rounded-lg border border-orange-100">
													<div class="text-xs text-gray-600 mb-1">{{ __('Outstanding') }}</div>
													<div class="text-lg font-bold text-orange-600">{{ formatCurrency(invoice.outstanding_amount) }}</div>
												</div>
											</div>

											<!-- Payment Progress Bar -->
											<div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden mb-3">
												<div
													class="h-full bg-gradient-to-r from-green-500 to-green-600 transition-all duration-300"
													:style="{ width: `${(invoice.paid_amount / invoice.grand_total) * 100}%` }"
												></div>
											</div>

											<!-- Payment Methods -->
											<div v-if="invoice.payments && invoice.payments.length > 0" class="mt-3">
												<div class="text-xs font-medium text-gray-600 mb-2">{{ __('Payment History') }}</div>
												<div class="grid grid-cols-2 md:grid-cols-3 gap-2">
													<div
														v-for="(payment, idx) in invoice.payments"
														:key="idx"
														:class="[
															'flex flex-col p-2 rounded-lg border text-sm',
															payment.source === 'Payment Entry'
																? 'bg-blue-50 border-blue-200'
																: 'bg-gray-50 border-gray-200'
														]"
													>
														<div class="flex items-center justify-between mb-1">
															<span class="text-gray-700 font-medium">{{ payment.mode_of_payment || __('N/A') }}</span>
															<span class="font-semibold text-gray-900">{{ formatCurrency(payment.amount) }}</span>
														</div>
														<div class="flex items-center justify-between">
															<span
																v-if="payment.posting_date"
																class="text-[9px] text-gray-500"
															>
																{{ formatDate(payment.posting_date) }}
															</span>
															<span
																:class="[
																	'text-[9px] font-semibold',
																	payment.source === 'Payment Entry' ? 'text-blue-600' : 'text-gray-500'
																]"
															>
																{{ getPaymentSourceLabel(payment.source) }}
															</span>
														</div>
													</div>
												</div>
											</div>
										</div>
									</div>
								</div>
							</div>

							<!-- Invoice History Tab -->
							<div v-if="activeTab === 'history'">
								<!-- Filters Component -->
								<div class="mb-6">
									<InvoiceFilters
										:unique-customers="invoiceFilters.uniqueCustomers.value"
										:unique-products="invoiceFilters.uniqueProducts.value"
										:filter-stats="invoiceFilters.filterStats.value"
										:company="props.company"
									/>
								</div>

								<!-- View Mode Switcher & Stats Bar -->
								<div class="flex items-center justify-between mb-4">
									<div class="text-sm font-semibold text-gray-700">
										{{ hasMoreHistory ? __('Showing {0}+ invoices', [filteredHistoryInvoices.length]) : __('{0} invoice(s) found', [filteredHistoryInvoices.length]) }}
									</div>
									<div class="flex items-center gap-1.5 bg-gray-100 border border-gray-300 rounded-lg p-1">
										<button
											type="button"
											@click="setViewMode('card')"
											:class="[
												'px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5 transition-all',
												viewMode === 'card'
													? 'bg-white text-gray-900 font-bold border-2 border-gray-900 shadow-sm'
													: 'text-gray-600 font-medium hover:text-gray-900 hover:bg-gray-200/60 border-2 border-transparent'
											]"
											:title="__('Card View')"
										>
											<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>
											</svg>
											<span>{{ __('Cards') }}</span>
										</button>
										<button
											type="button"
											@click="setViewMode('list')"
											:class="[
												'px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5 transition-all',
												viewMode === 'list'
													? 'bg-white text-gray-900 font-bold border-2 border-gray-900 shadow-sm'
													: 'text-gray-600 font-medium hover:text-gray-900 hover:bg-gray-200/60 border-2 border-transparent'
											]"
											:title="__('List View')"
										>
											<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
											</svg>
											<span>{{ __('List') }}</span>
										</button>
									</div>
								</div>

								<!-- Loading State -->
								<div v-if="loadingHistory" class="flex flex-col items-center justify-center py-12">
									<div class="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600 mb-3"></div>
									<p class="text-sm font-medium text-gray-600">{{ __('Fetching invoices from ERP...') }}</p>
								</div>

								<!-- Empty State -->
								<div v-else-if="filteredHistoryInvoices.length === 0" class="flex flex-col items-center justify-center py-16 text-center">
									<svg class="w-16 h-16 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
									</svg>
									<p class="text-gray-600 font-medium">{{ __('No invoices found') }}</p>
								</div>

								<!-- List View Table -->
								<div v-else-if="viewMode === 'list'" class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
									<div class="overflow-x-auto">
										<table class="w-full text-start border-collapse text-sm">
											<thead class="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase tracking-wider">
												<tr>
													<th class="px-4 py-3.5 text-start">{{ __('Invoice') }}</th>
													<th class="px-4 py-3.5 text-start">{{ __('Date & Time') }}</th>
													<th class="px-4 py-3.5 text-start">{{ __('Customer') }}</th>
													<th class="px-4 py-3.5 text-start">{{ __('Status') }}</th>
													<th class="px-4 py-3.5 text-end">{{ __('Total') }}</th>
													<th class="px-4 py-3.5 text-end">{{ __('Paid') }}</th>
													<th class="px-4 py-3.5 text-end">{{ __('Outstanding') }}</th>
													<th class="px-4 py-3.5 text-center">{{ __('Actions') }}</th>
												</tr>
											</thead>
											<tbody class="divide-y divide-gray-100">
												<tr
													v-for="invoice in filteredHistoryInvoices"
													:key="invoice.name"
													class="hover:bg-indigo-50/40 transition-colors"
												>
													<td class="px-4 py-3.5 font-bold text-gray-900 whitespace-nowrap">
														{{ invoice.name }}
													</td>
													<td class="px-4 py-3.5 text-gray-600 whitespace-nowrap text-xs">
														{{ formatDate(invoice.posting_date) }} {{ formatTime(invoice.posting_time) }}
													</td>
													<td class="px-4 py-3.5 text-gray-800 font-medium whitespace-nowrap">
														{{ invoice.customer_name || invoice.customer }}
													</td>
													<td class="px-4 py-3.5 whitespace-nowrap">
														<span
															:class="[
																'text-xs px-2.5 py-1 rounded-full font-semibold',
																getInvoiceStatusColor(invoice)
															]"
														>
															{{ __(invoice.status) }}
														</span>
													</td>
													<td class="px-4 py-3.5 text-end font-bold text-indigo-600 whitespace-nowrap">
														{{ formatCurrency(invoice.grand_total) }}
													</td>
													<td class="px-4 py-3.5 text-end font-semibold text-green-600 whitespace-nowrap">
														{{ formatCurrency(invoice.paid_amount || 0) }}
													</td>
													<td class="px-4 py-3.5 text-end font-semibold text-orange-600 whitespace-nowrap">
														{{ formatCurrency(invoice.outstanding_amount || 0) }}
													</td>
													<td class="px-4 py-3.5 text-center whitespace-nowrap">
														<div class="flex items-center justify-center gap-1.5">
															<button
																@click="$emit('view-invoice', invoice)"
																class="px-2.5 py-1.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors inline-flex items-center gap-1"
																:title="__('View Details')"
															>
																<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
																	<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
																	<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
																</svg>
																<span>{{ __('View') }}</span>
															</button>
															<button
																@click="$emit('print-invoice', invoice)"
																class="px-2.5 py-1.5 text-xs font-semibold text-green-600 bg-green-50 hover:bg-green-100 rounded-md transition-colors inline-flex items-center gap-1"
																:title="__('Print')"
															>
																<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
																	<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
																</svg>
																<span>{{ __('Print') }}</span>
															</button>
															<button
																@click="$emit('create-return', invoice)"
																class="px-2.5 py-1.5 text-xs font-semibold text-orange-600 bg-orange-50 hover:bg-orange-100 rounded-md transition-colors inline-flex items-center gap-1"
																:title="__('Create Return')"
															>
																<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
																	<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
																</svg>
																<span>{{ __('Return') }}</span>
															</button>
														</div>
													</td>
												</tr>
											</tbody>
										</table>
									</div>
								</div>

								<!-- Invoices Grid - 2 columns on large screens -->
								<div v-else-if="viewMode === 'card'" class="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
									<div
										v-for="invoice in filteredHistoryInvoices"
										:key="invoice.name"
										class="bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-lg transition-all overflow-hidden"
									>
										<!-- Card Header with gradient -->
										<div class="bg-gradient-to-r from-indigo-50 to-blue-50 px-5 py-4 border-b border-gray-200">
											<div class="flex items-start justify-between mb-2">
												<div class="flex-1">
													<h3 class="text-base font-bold text-gray-900">{{ invoice.name }}</h3>
													<div class="flex items-center gap-2 mt-1">
														<span
															:class="[
																'text-xs px-2.5 py-1 rounded-full font-semibold',
																getInvoiceStatusColor(invoice)
															]"
														>
															{{ __(invoice.status) }}
														</span>
													</div>
												</div>
												<div class="text-end ms-3">
													<div class="text-xs text-gray-500 mb-1">{{ __('Total') }}</div>
													<div class="text-lg font-bold text-indigo-600">
														{{ formatCurrency(invoice.grand_total) }}
													</div>
												</div>
											</div>
										</div>

										<!-- Card Body -->
										<div class="px-5 py-4 flex flex-col gap-3">
											<!-- Customer Info -->
											<div class="flex items-start">
												<svg class="w-5 h-5 text-gray-400 me-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
												</svg>
												<div class="flex-1">
													<div class="text-xs text-gray-500">{{ __('Customer') }}</div>
													<div class="text-sm font-semibold text-gray-900">{{ invoice.customer_name || invoice.customer }}</div>
												</div>
											</div>

											<!-- Date & Time -->
											<div class="flex items-start">
												<svg class="w-5 h-5 text-gray-400 me-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
												</svg>
												<div class="flex-1">
													<div class="text-xs text-gray-500">{{ __('Date & Time') }}</div>
													<div class="text-sm font-medium text-gray-900">{{ formatDate(invoice.posting_date) }} {{ formatTime(invoice.posting_time) }}</div>
												</div>
											</div>

											<!-- Payment Details -->
											<div class="grid grid-cols-2 gap-3 pt-2 border-t border-gray-100">
												<div>
													<div class="text-xs text-gray-500 mb-1">{{ __('Paid Amount') }}</div>
													<div class="text-sm font-semibold text-green-600">{{ formatCurrency(invoice.paid_amount || 0) }}</div>
												</div>
												<div>
													<div class="text-xs text-gray-500 mb-1">{{ __('Outstanding') }}</div>
													<div class="text-sm font-semibold text-orange-600">{{ formatCurrency(invoice.outstanding_amount || 0) }}</div>
												</div>
											</div>
										</div>

										<!-- Card Footer with Actions -->
										<div class="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-end gap-2">
											<button
												@click="$emit('view-invoice', invoice)"
												class="px-3 py-2 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1"
												:title="__('View Details')"
											>
												<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
												</svg>
												<span>{{ __('View') }}</span>
											</button>
											<button
												@click="$emit('print-invoice', invoice)"
												class="px-3 py-2 text-xs font-semibold text-green-600 bg-green-50 hover:bg-green-100 rounded-lg transition-colors flex items-center gap-1"
												:title="__('Print')"
											>
												<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
												</svg>
												<span>{{ __('Print') }}</span>
											</button>
											<!-- Unconditional: get_invoices only returns submitted invoices
											     and this tab already excludes returns, so every card here is
											     returnable by anyone who can open this screen. -->
											<button
												@click="$emit('create-return', invoice)"
												class="px-3 py-2 text-xs font-semibold text-orange-600 bg-orange-50 hover:bg-orange-100 rounded-lg transition-colors flex items-center gap-1"
												:title="__('Create Return')"
											>
												<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
												</svg>
												<span>{{ __('Return') }}</span>
											</button>
										</div>
									</div>
								</div>

								<!-- Load More Button -->
								<div v-if="!loadingHistory && hasMoreHistory" class="flex justify-center mt-6 mb-2">
									<Button
										@click="loadMoreServerHistoryInvoices"
										:loading="loadingMoreHistory"
										variant="subtle"
										size="sm"
										class="px-6 py-2 font-semibold"
									>
										{{ __('Load More Invoices') }}
									</Button>
								</div>
							</div>

							<!-- Draft Invoices Tab -->
							<div v-if="activeTab === 'drafts'">
								<!-- Empty State -->
								<div v-if="draftInvoices.length === 0" class="flex flex-col items-center justify-center py-16 text-center">
									<svg class="w-16 h-16 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
									</svg>
									<p class="text-gray-600 font-medium">{{ __('No draft invoices') }}</p>
									<p class="text-gray-500 text-sm mt-1">{{ __('Save invoices as drafts to continue later') }}</p>
								</div>

								<!-- Drafts Grid -->
								<div v-else class="grid gap-4">
									<div
										v-for="draft in draftInvoices"
										:key="draft.draft_id"
										class="bg-white border-2 border-gray-200 rounded-lg p-4 hover:border-purple-400 transition-all cursor-pointer"
										@click="$emit('load-draft', draft)"
									>
										<div class="flex items-start justify-between mb-2">
											<div class="flex-1">
												<h4 class="text-sm font-semibold text-gray-900">{{ draft.draft_id }}</h4>
												<p v-if="draft.customer" class="text-xs text-gray-500 mt-0.5">
													{{ __('Customer: {0}', [(draft.customer?.customer_name || draft.customer?.name || draft.customer)]) }}
												</p>
												<p class="text-xs text-gray-400 mt-0.5">{{ formatDateTime(draft.created_at) }}</p>
											</div>
											<div class="flex items-center gap-2 ms-3">
												<!-- The card body already loads the draft, but that is an
												     invisible affordance - this is the discoverable way in.
												     Unconditional: any cashier who can see a held draft can
												     resume it. -->
												<button
													@click.stop="$emit('load-draft', draft)"
													class="px-3 py-2 text-xs font-semibold text-purple-600 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors flex items-center gap-1"
													:title="__('Edit draft')"
												>
													<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
													</svg>
													<span>{{ __('Edit') }}</span>
												</button>
												<button
													v-if="canDeleteDrafts"
													@click.stop="$emit('delete-draft', draft.draft_id)"
													class="text-gray-400 hover:text-red-600 transition-colors p-1"
													:title="__('Delete draft')"
												>
													<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
													</svg>
												</button>
											</div>
										</div>

										<div class="flex items-center justify-between text-xs">
											<span class="text-gray-600">{{ __('{0} item(s)', [draft.items?.length || 0]) }}</span>
											<span class="font-bold text-purple-600">{{ formatCurrency(draftTotal(draft)) }}</span>
										</div>

										<!-- Items Preview -->
										<div v-if="draft.items && draft.items.length > 0" class="mt-2 pt-2 border-t border-gray-100">
											<div class="flex flex-wrap gap-1">
												<span
													v-for="(item, idx) in draft.items.slice(0, 3)"
													:key="idx"
													class="text-[10px] bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded"
												>
													{{ item.item_name }} ({{ item.quantity || item.qty }})
												</span>
												<span v-if="draft.items.length > 3" class="text-[10px] text-gray-500 px-1.5 py-0.5">
													{{ __('+{0} more', [draft.items.length - 3]) }}
												</span>
											</div>
										</div>
									</div>
								</div>
							</div>

							<!-- Return Invoices Tab -->
							<div v-if="activeTab === 'returns'">
								<!-- Loading State -->
								<div v-if="loadingReturns" class="flex flex-col items-center justify-center py-12">
									<div class="animate-spin rounded-full h-10 w-10 border-b-2 border-red-600 mb-3"></div>
									<p class="text-sm font-medium text-gray-600">{{ __('Fetching returns from ERP...') }}</p>
								</div>

								<!-- Empty State -->
								<div v-else-if="returnInvoices.length === 0" class="flex flex-col items-center justify-center py-16 text-center">
									<svg class="w-16 h-16 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
									</svg>
									<p class="text-gray-600 font-medium">{{ __('No return invoices') }}</p>
									<p class="text-gray-500 text-sm mt-1">{{ __('Return invoices will appear here') }}</p>
								</div>

								<!-- Returns Grid -->
								<div v-else class="grid gap-4">
									<div
										v-for="invoice in returnInvoices"
										:key="invoice.name"
										class="bg-white border border-red-200 rounded-lg p-4 hover:shadow-md transition-all"
									>
										<div class="flex items-start justify-between">
											<div class="flex-1">
												<div class="flex items-center gap-2 mb-1">
													<h4 class="text-sm font-semibold text-gray-900">{{ invoice.name }}</h4>
													<span class="text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-800">
														{{ __('Return') }}
													</span>
												</div>
												<div class="flex items-center gap-4 text-xs text-gray-600">
													<span>{{ invoice.customer_name }}</span>
													<span>{{ formatDate(invoice.posting_date) }}</span>
													<span v-if="invoice.return_against">{{ __('Against: {0}', [invoice.return_against]) }}</span>
												</div>
											</div>

											<div class="text-end ms-4">
												<p class="text-sm font-bold text-red-600">
													-{{ formatCurrency(Math.abs(invoice.grand_total)) }}
												</p>
												<div class="flex items-center gap-1 mt-2">
													<button
														@click="$emit('view-invoice', invoice)"
														class="p-1.5 hover:bg-blue-50 rounded transition-colors"
														:title="__('View Details')"
													>
														<svg class="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
															<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
															<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
														</svg>
													</button>
													<button
														@click="$emit('print-invoice', invoice)"
														class="p-1.5 hover:bg-green-50 rounded transition-colors"
														:title="__('Print')"
													>
														<svg class="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
															<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
														</svg>
													</button>
												</div>
											</div>
										</div>
									</div>
								</div>

								<!-- Load More Returns Button -->
								<div v-if="!loadingReturns && hasMoreReturns" class="flex justify-center mt-6 mb-2">
									<Button
										@click="loadMoreServerReturnInvoices"
										:loading="loadingMoreReturns"
										variant="subtle"
										size="sm"
										class="px-6 py-2 font-semibold"
									>
										{{ __('Load More Returns') }}
									</Button>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</Transition>

	<!-- Payment Dialog -->
	<PaymentDialog
		v-model="showPaymentDialog"
		:grand-total="selectedInvoice?.outstanding_amount || 0"
		:pos-profile="posProfile"
		:currency="currency"
		:is-offline="false"
		:allow-partial-payment="true"
		@payment-completed="handlePaymentCompleted"
	/>
</template>

<script setup>
import InvoiceFilters from "@/components/invoices/InvoiceFilters.vue"
import PaymentDialog from "@/components/sale/PaymentDialog.vue"
import { useEditLock } from "@/composables/useEditLock"
import { useInvoiceFilters } from "@/composables/useInvoiceFilters"
import { useInvoiceFiltersStore } from "@/stores/invoiceFilters"
import { formatCurrency as formatCurrencyUtil } from "@/utils/currency"
import { getInvoiceStatusColor } from "@/utils/invoice"
import { usePOSPermissions } from "@/composables/usePermissions"
import { useFormatters } from "@/composables/useFormatters"
import { useToast } from "@/composables/useToast"
import { Button, call } from "frappe-ui"
import { computed, onMounted, ref, watch } from "vue"

const { showSuccess, showError } = useToast()
const { formatDate, formatDateTime, formatTime } = useFormatters()
const { canDeleteInvoice } = usePOSPermissions()
const canDeleteDrafts = ref(false)

async function checkDeletePermission() {
	try {
		canDeleteDrafts.value = await canDeleteInvoice()
	} catch (error) {
		console.error("Error checking delete permission:", error)
		canDeleteDrafts.value = false
	}
}
// Two tills can open the same unpaid invoice from this list, so hold it while one is settling it.
const {
	acquire: acquireInvoiceLock,
	release: releaseInvoiceLock,
	lockedBy: invoiceLockedBy,
} = useEditLock()

function lockedInvoiceMessage() {
	const holder = invoiceLockedBy.value
	if (!holder) return null
	return holder.message || holder.full_name || holder.user || null
}

const props = defineProps({
	modelValue: Boolean,
	posProfile: String,
	company: String,
	currency: {
		type: String,
		default: "USD",
	},
	// Pass in data from parent stores
	historyInvoices: {
		type: Array,
		default: () => [],
	},
	draftInvoices: {
		type: Array,
		default: () => [],
	},
})

const emit = defineEmits([
	"update:modelValue",
	"view-invoice",
	"print-invoice",
	"create-return",
	"load-draft",
	"delete-draft",
	"refresh-history",
])

const show = ref(props.modelValue)
const loading = ref(false)
const loadingHistory = ref(false)
const serverHistoryInvoices = ref([])
const hasLoadedServerHistory = ref(false)
const HISTORY_PAGE_SIZE = 100
const hasMoreHistory = ref(false)
const loadingMoreHistory = ref(false)
let serverHistoryRequestId = 0
const viewMode = ref(localStorage.getItem("pos_invoice_view_mode") || "card")

function setViewMode(mode) {
	viewMode.value = mode
	try {
		localStorage.setItem("pos_invoice_view_mode", mode)
	} catch (e) {
		// ignore
	}
}

const activeTab = ref("partial")

// Initialize filter store and composable
const filterStore = useInvoiceFiltersStore()

// Effective history invoices: prefer server queried results, fallback to props.historyInvoices
const historyInvoicesToUse = computed(() => {
	if (hasLoadedServerHistory.value || serverHistoryInvoices.value.length > 0) {
		return serverHistoryInvoices.value
	}
	return Array.isArray(props.historyInvoices) ? props.historyInvoices : []
})

// Non-return history invoices (returns have their own dedicated tab)
const nonReturnHistoryInvoices = computed(() => {
	const allInvoices = Array.isArray(historyInvoicesToUse.value)
		? historyInvoicesToUse.value
		: []
	return allInvoices.filter((inv) => !inv.is_return)
})

// Single invoiceFilters composable instance using nonReturnHistoryInvoices
const invoiceFilters = useInvoiceFilters(nonReturnHistoryInvoices)
const filteredHistoryInvoices = invoiceFilters.filteredInvoices

async function loadServerHistoryInvoices() {
	if (!props.posProfile) return

	const reqId = ++serverHistoryRequestId
	loadingMoreHistory.value = false
	loadingHistory.value = true
	try {
		const params = {
			pos_profile: props.posProfile,
			company: props.company || undefined,
			customer: filterStore.customer || undefined,
			item_code: filterStore.product || undefined,
			search_term: filterStore.searchTerm || undefined,
			from_date: filterStore.dateFrom || undefined,
			to_date: filterStore.dateTo || undefined,
			status: filterStore.status || undefined,
			is_return: 0,
			start: 0,
			limit: HISTORY_PAGE_SIZE,
		}

		const result = await call("pos_next.api.invoices.get_invoices", params)
		if (reqId !== serverHistoryRequestId) return

		const list = result || []
		serverHistoryInvoices.value = list
		hasMoreHistory.value = list.length === HISTORY_PAGE_SIZE
		hasLoadedServerHistory.value = true
	} catch (error) {
		if (reqId === serverHistoryRequestId) {
			console.error("Error loading invoices from ERP:", error)
			showError(error.message || __("Failed to load invoices from ERP"))
		}
	} finally {
		if (reqId === serverHistoryRequestId) {
			loadingHistory.value = false
		}
	}
}

async function loadMoreServerHistoryInvoices() {
	if (!props.posProfile || loadingMoreHistory.value || !hasMoreHistory.value) return

	const reqId = serverHistoryRequestId
	loadingMoreHistory.value = true
	try {
		const params = {
			pos_profile: props.posProfile,
			company: props.company || undefined,
			customer: filterStore.customer || undefined,
			item_code: filterStore.product || undefined,
			search_term: filterStore.searchTerm || undefined,
			from_date: filterStore.dateFrom || undefined,
			to_date: filterStore.dateTo || undefined,
			status: filterStore.status || undefined,
			is_return: 0,
			start: serverHistoryInvoices.value.length,
			limit: HISTORY_PAGE_SIZE,
		}

		const result = await call("pos_next.api.invoices.get_invoices", params)
		if (reqId !== serverHistoryRequestId) return

		const list = result || []
		const existingNames = new Set(serverHistoryInvoices.value.map((inv) => inv.name))
		const newInvoices = list.filter((inv) => !existingNames.has(inv.name))
		serverHistoryInvoices.value = [...serverHistoryInvoices.value, ...newInvoices]
		hasMoreHistory.value = list.length === HISTORY_PAGE_SIZE
	} catch (error) {
		if (reqId === serverHistoryRequestId) {
			console.error("Error loading more invoices from ERP:", error)
			showError(error.message || __("Failed to load more invoices from ERP"))
		}
	} finally {
		loadingMoreHistory.value = false
	}
}

// Return invoices state and requests (independent of History filters)
const serverReturnInvoices = ref([])
const hasLoadedServerReturns = ref(false)
const hasMoreReturns = ref(false)
const loadingReturns = ref(false)
const loadingMoreReturns = ref(false)
let serverReturnRequestId = 0

async function loadServerReturnInvoices() {
	if (!props.posProfile) return

	const reqId = ++serverReturnRequestId
	loadingMoreReturns.value = false
	loadingReturns.value = true
	try {
		const params = {
			pos_profile: props.posProfile,
			company: props.company || undefined,
			is_return: 1,
			start: 0,
			limit: HISTORY_PAGE_SIZE,
		}

		const result = await call("pos_next.api.invoices.get_invoices", params)
		if (reqId !== serverReturnRequestId) return

		const list = result || []
		serverReturnInvoices.value = list
		hasMoreReturns.value = list.length === HISTORY_PAGE_SIZE
		hasLoadedServerReturns.value = true
	} catch (error) {
		if (reqId === serverReturnRequestId) {
			console.error("Error loading return invoices from ERP:", error)
			showError(error.message || __("Failed to load return invoices from ERP"))
		}
	} finally {
		if (reqId === serverReturnRequestId) {
			loadingReturns.value = false
		}
	}
}

async function loadMoreServerReturnInvoices() {
	if (!props.posProfile || loadingMoreReturns.value || !hasMoreReturns.value) return

	const reqId = serverReturnRequestId
	loadingMoreReturns.value = true
	try {
		const params = {
			pos_profile: props.posProfile,
			company: props.company || undefined,
			is_return: 1,
			start: serverReturnInvoices.value.length,
			limit: HISTORY_PAGE_SIZE,
		}

		const result = await call("pos_next.api.invoices.get_invoices", params)
		if (reqId !== serverReturnRequestId) return

		const list = result || []
		const existingNames = new Set(serverReturnInvoices.value.map((inv) => inv.name))
		const newInvoices = list.filter((inv) => !existingNames.has(inv.name))
		serverReturnInvoices.value = [...serverReturnInvoices.value, ...newInvoices]
		hasMoreReturns.value = list.length === HISTORY_PAGE_SIZE
	} catch (error) {
		if (reqId === serverReturnRequestId) {
			console.error("Error loading more return invoices from ERP:", error)
			showError(error.message || __("Failed to load more return invoices from ERP"))
		}
	} finally {
		loadingMoreReturns.value = false
	}
}

let searchDebounceTimer = null
watch(
	() => filterStore.searchTerm,
	() => {
		if (!show.value || activeTab.value !== "history") return
		clearTimeout(searchDebounceTimer)
		searchDebounceTimer = setTimeout(() => {
			loadServerHistoryInvoices()
		}, 300)
	},
)

watch(
	[
		() => filterStore.customer,
		() => filterStore.product,
		() => filterStore.status,
		() => filterStore.dateFrom,
		() => filterStore.dateTo,
	],
	() => {
		if (show.value && activeTab.value === "history") {
			loadServerHistoryInvoices()
		}
	},
)

// Unpaid invoices data
const unpaidInvoices = ref([])
const unpaidFilter = ref("all") // "all", "partial", "unpaid"
const unpaidSummary = ref({
	count: 0,
	total_outstanding: 0,
	total_paid: 0,
})
const selectedInvoice = ref(null)
const showPaymentDialog = ref(false)

// Filtered unpaid invoices based on payment amounts
const filteredUnpaidInvoices = computed(() => {
	if (unpaidFilter.value === "partial") {
		// Partially paid: status is 'Partly Paid' only
		return unpaidInvoices.value.filter((inv) => inv.status === 'Partly Paid')
	}
	if (unpaidFilter.value === "unpaid") {
		// Totally unpaid: status is 'Unpaid'
		return unpaidInvoices.value.filter((inv) => inv.status === 'Unpaid')
	}
	if (unpaidFilter.value === "overdue") {
		// Overdue: invoice status is Overdue
		return unpaidInvoices.value.filter((inv) => inv.status === 'Overdue')
	}
	return unpaidInvoices.value // "all"
})

// Filtered summary based on selected filter
const filteredUnpaidSummary = computed(() => {
	const filtered = filteredUnpaidInvoices.value

	return {
		count: filtered.length,
		total_outstanding: filtered.reduce(
			(sum, inv) => sum + (inv.outstanding_amount || 0),
			0,
		),
		total_paid: filtered.reduce((sum, inv) => sum + (inv.paid_amount || 0), 0),
	}
})

// Return invoices: prefer server queried results, fallback to props.historyInvoices
const returnInvoices = computed(() => {
	if (hasLoadedServerReturns.value || serverReturnInvoices.value.length > 0) {
		return serverReturnInvoices.value
	}
	const allInvoices = Array.isArray(props.historyInvoices) ? props.historyInvoices : []
	return allInvoices.filter((inv) => inv.is_return)
})

const unpaidCount = computed(() => unpaidInvoices.value.length)
const historyCount = computed(() => filteredHistoryInvoices.value.length)
const draftsCount = computed(() => (Array.isArray(props.draftInvoices) ? props.draftInvoices.length : 0))
const returnsCount = computed(() => returnInvoices.value.length)

// Tabs configuration
const tabs = computed(() => [
	{
		id: "partial",
		label: __("Unpaid"),
		icon: "M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z",
		color: "orange",
		activeClass: "text-orange-600",
		count: unpaidCount.value,
		badge: () => unpaidCount.value,
	},
	{
		id: "history",
		label: __("Invoice History"),
		icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
		color: "indigo",
		activeClass: "text-indigo-600",
		count: historyCount.value,
		badge: () => historyCount.value,
	},
	{
		id: "drafts",
		label: __("Drafts"),
		icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
		color: "purple",
		activeClass: "text-purple-600",
		count: draftsCount.value,
		badge: () => draftsCount.value,
	},
	{
		id: "returns",
		label: __("Returns"),
		icon: "M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6",
		color: "red",
		activeClass: "text-red-600",
		count: returnsCount.value,
		badge: () => returnsCount.value,
	},
])

const currentTabLabel = computed(() => {
	return tabs.value.find((t) => t.id === activeTab.value)?.label || ""
})

// Tab class helpers
function getTabActiveClass(tabId) {
	switch (tabId) {
		case "partial":
			return "text-orange-600 border-orange-500"
		case "history":
			return "text-indigo-600 border-indigo-500"
		case "drafts":
			return "text-purple-600 border-purple-500"
		case "returns":
			return "text-red-600 border-red-500"
		default:
			return "text-gray-600 border-gray-500"
	}
}

// Badge class helpers
function getBadgeActiveClass(tabId) {
	switch (tabId) {
		case "partial":
			return "bg-orange-100 text-orange-700"
		case "history":
			return "bg-indigo-100 text-indigo-700"
		case "drafts":
			return "bg-purple-100 text-purple-700"
		case "returns":
			return "bg-red-100 text-red-700"
		default:
			return "bg-gray-100 text-gray-700"
	}
}

function getBadgeInactiveClass(tabId) {
	switch (tabId) {
		case "partial":
			return "bg-gray-200 text-gray-600"
		case "history":
			return "bg-gray-200 text-gray-600"
		case "drafts":
			return "bg-gray-200 text-gray-600"
		case "returns":
			return "bg-gray-200 text-gray-600"
		default:
			return "bg-gray-200 text-gray-600"
	}
}

// Watchers
watch(
	() => props.modelValue,
	(val) => {
		show.value = val
		if (val) {
			checkDeletePermission()
			loadUnpaidInvoices()
			loadUnpaidSummary()
			loadServerHistoryInvoices()
			loadServerReturnInvoices()
			// Also request history refresh if we don't have data
			if (props.historyInvoices.length === 0) {
				emit("refresh-history")
			}
		}
	},
)

watch(show, (val) => {
	emit("update:modelValue", val)
})

// Watch for tab changes to emit refresh event for history/returns tabs
watch(activeTab, (newTab) => {
	// Always emit refresh event when switching to history or returns tabs
	// This ensures up-to-date outstanding amounts and invoice data
	if (newTab === "history") {
		loadServerHistoryInvoices()
		emit("refresh-history")
	} else if (newTab === "returns") {
		loadServerReturnInvoices()
		emit("refresh-history")
	} else if (newTab === "partial") {
		// Refresh unpaid invoices when switching to partial tab
		loadUnpaidInvoices()
		loadUnpaidSummary()
	}
})

// Methods
function handleClose() {
	show.value = false
}

async function refreshCurrentTab() {
	if (activeTab.value === "partial") {
		await Promise.all([loadUnpaidInvoices(), loadUnpaidSummary()])
	} else if (activeTab.value === "history") {
		await loadServerHistoryInvoices()
		emit("refresh-history")
	} else if (activeTab.value === "drafts") {
		// Drafts are passed from parent, emit event if needed
		emit("refresh-history")
	} else if (activeTab.value === "returns") {
		await loadServerReturnInvoices()
		emit("refresh-history")
	}
}

async function loadUnpaidInvoices() {
	if (!props.posProfile) return

	loading.value = true

	try {
		const result = await call(
			"pos_next.api.partial_payments.get_unpaid_invoices",
			{
				pos_profile: props.posProfile,
				limit: 100,
			},
		)

		unpaidInvoices.value = result || []
	} catch (error) {
		console.error("Error loading unpaid invoices:", error)
		showError(error.message || __("Failed to load unpaid invoices"))
	} finally {
		loading.value = false
	}
}

async function loadUnpaidSummary() {
	if (!props.posProfile) return

	try {
		const result = await call(
			"pos_next.api.partial_payments.get_unpaid_summary",
			{
				pos_profile: props.posProfile,
			},
		)

		unpaidSummary.value = result || {
			count: 0,
			total_outstanding: 0,
			total_paid: 0,
		}
	} catch (error) {
		console.error("Error loading summary:", error)
	}
}

async function selectInvoiceForPayment(invoice) {
	// Claim before the dialog opens, so a second cashier is told now rather than after they have
	// keyed in a payment. The server refuses the write regardless.
	const mine = await acquireInvoiceLock("Sales Invoice", invoice?.name)
	if (!mine) {
		showError(
			lockedInvoiceMessage() ||
				__("This invoice is being settled by another user. Please try again in a moment."),
		)
		return
	}

	selectedInvoice.value = invoice
	showPaymentDialog.value = true
}

async function handlePaymentCompleted(paymentData) {
	if (!selectedInvoice.value) return

	try {
		await call("pos_next.api.partial_payments.add_payment_to_partial_invoice", {
			invoice_name: selectedInvoice.value.name,
			payments: paymentData.payments,
		})

		showSuccess(__("Payment added successfully"))

		// Reload invoices and summary for partial tab
		await loadUnpaidInvoices()
		await loadUnpaidSummary()

		// Also refresh history data to show updated outstanding amounts
		emit("refresh-history")

		selectedInvoice.value = null
	} catch (error) {
		console.error("Error adding payment:", error)
		showError(error.message || __("Failed to add payment"))
	} finally {
		await releaseInvoiceLock()
	}
}

// Closing the dialog — settled, cancelled or dismissed — frees the invoice straight away. The
// server's TTL is only the safety net for a till that never gets to say goodbye.
watch(showPaymentDialog, (open) => {
	if (!open) releaseInvoiceLock()
})

function formatCurrency(amount) {
	return formatCurrencyUtil(Number.parseFloat(amount || 0), props.currency)
}

function getPaymentSourceLabel(source) {
	// Convert source to user-friendly label
	switch (source) {
		case 'POS':
			return 'POS'
		case 'POS Payment Entry':
			return 'POS'
		case 'Payment Entry':
			return 'Back Office'
		default:
			return source
	}
}


function calculateDraftTotal(items) {
	if (!items || items.length === 0) return 0
	return items.reduce(
		(sum, item) => sum + (item.quantity || item.qty || 0) * (item.rate || 0),
		0,
	)
}

/** Server drafts carry the invoice total; cached drafts are summed line by line. */
function draftTotal(draft) {
	return draft?.grand_total != null
		? draft.grand_total
		: calculateDraftTotal(draft?.items)
}

// Lifecycle
onMounted(() => {
	checkDeletePermission()
	// Load saved filter presets from localStorage
	filterStore.loadSavedFiltersFromStorage()

	if (show.value) {
		loadUnpaidInvoices()
		loadUnpaidSummary()
		if (activeTab.value === "history" || activeTab.value === "returns") {
			loadServerHistoryInvoices()
		}
	}
})
</script>

<style scoped>
/* Fade transition for overlay */
.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}

/* Slide down transition for filter panel */
.slide-down-enter-active,
.slide-down-leave-active {
	transition: all 0.3s ease-in-out;
	max-height: 600px;
	overflow: hidden;
}

.slide-down-enter-from,
.slide-down-leave-to {
	max-height: 0;
	opacity: 0;
	transform: translateY(-10px);
}

.slide-down-enter-to,
.slide-down-leave-from {
	max-height: 600px;
	opacity: 1;
	transform: translateY(0);
}
</style>
