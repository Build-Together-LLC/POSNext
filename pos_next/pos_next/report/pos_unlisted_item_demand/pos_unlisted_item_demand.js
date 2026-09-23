// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

frappe.query_reports["POS Unlisted Item Demand"] = {
	filters: [
		{
			fieldname: "company",
			label: __("Company"),
			fieldtype: "Link",
			options: "Company",
			reqd: 1,
			default: frappe.defaults.get_user_default("Company"),
		},
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			reqd: 1,
			default: frappe.datetime.month_start(),
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
			reqd: 1,
			default: frappe.datetime.get_today(),
		},
		{
			fieldname: "group_by",
			label: __("Group By"),
			fieldtype: "Select",
			options: [
				"Requested Item",
				"Brand",
				"Item Group",
				"Customer",
				"Cashier",
				"POS Profile",
				"Date",
				"Detail",
			].join("\n"),
			default: "Requested Item",
		},
		{
			fieldname: "requested_item",
			label: __("Asked For"),
			fieldtype: "Data",
		},
		{
			fieldname: "status",
			label: __("Status"),
			fieldtype: "Select",
			options: ["", "Open", "Sourced", "Not Stocking", "Discarded"].join("\n"),
		},
		{
			fieldname: "pos_profile",
			label: __("POS Profile"),
			fieldtype: "Link",
			options: "POS Profile",
		},
		{
			fieldname: "cashier",
			label: __("Cashier"),
			fieldtype: "Link",
			options: "User",
		},
		{
			fieldname: "customer",
			label: __("Customer"),
			fieldtype: "Link",
			options: "Customer",
		},
		{
			fieldname: "brand",
			label: __("Brand"),
			fieldtype: "Data",
		},
		{
			fieldname: "include_discarded",
			label: __("Include Discarded"),
			fieldtype: "Check",
			default: 0,
		},
	],

	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);

		// Asked for again and again and still not stocked - the ones to act on.
		if (column.fieldname === "requests" && data && cint(data.requests) >= 3) {
			value = `<span style="color: var(--red-600); font-weight: 600">${value}</span>`;
		}

		return value;
	},
};
