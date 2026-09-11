// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

frappe.query_reports["POS Demand vs Actual"] = {
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
				"Item",
				"Item Group",
				"Brand",
				"Customer",
				"Cashier",
				"Warehouse",
				"POS Profile",
				"Date",
				"Detail",
			].join("\n"),
			default: "Item",
		},
		{
			fieldname: "pos_profile",
			label: __("POS Profile"),
			fieldtype: "Link",
			options: "POS Profile",
		},
		{
			fieldname: "pos_opening_shift",
			label: __("POS Opening Shift"),
			fieldtype: "Link",
			options: "POS Opening Shift",
		},
		{
			fieldname: "cashier",
			label: __("Cashier"),
			fieldtype: "Link",
			options: "User",
		},
		{
			fieldname: "warehouse",
			label: __("Warehouse"),
			fieldtype: "Link",
			options: "Warehouse",
		},
		{
			fieldname: "item_code",
			label: __("Item"),
			fieldtype: "Link",
			options: "Item",
		},
		{
			fieldname: "item_group",
			label: __("Item Group"),
			fieldtype: "Link",
			options: "Item Group",
		},
		{
			fieldname: "brand",
			label: __("Brand"),
			fieldtype: "Link",
			options: "Brand",
		},
		{
			fieldname: "customer",
			label: __("Customer"),
			fieldtype: "Link",
			options: "Customer",
		},
		{
			fieldname: "reason",
			label: __("Reason"),
			fieldtype: "Select",
			options: [
				"",
				"Insufficient Stock",
				"Out of Stock",
				"Batch/Serial Unavailable",
				"Other",
			].join("\n"),
		},
		{
			fieldname: "loss_type",
			label: __("Loss Type"),
			fieldtype: "Select",
			options: ["", "Partial", "Full"].join("\n"),
		},
		{
			fieldname: "include_voided",
			label: __("Include Voided"),
			fieldtype: "Check",
			default: 0,
		},
	],

	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);

		// Nothing sold at all is the loss worth spotting from across the room.
		if (column.fieldname === "lost_qty" && data && flt(data.sold_qty) === 0) {
			value = `<span style="color: var(--red-600)">${value}</span>`;
		}

		return value;
	},
};
