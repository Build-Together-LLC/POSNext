// Copyright (c) 2026, BrainWise and contributors
// For license information, please see license.txt

frappe.ui.form.on("POS Order Loss", {
	refresh(frm) {
		if (frm.doc.is_void) {
			frm.dashboard.set_headline_alert(
				__("Voided: {0}", [frm.doc.void_reason || __("no reason given")]),
				"orange",
			);
			return;
		}

		// A mistyped quantity shows up here: the customer's last ask is a
		// fraction of the largest one recorded for the same sale.
		const demanded = flt(frm.doc.demanded_qty);
		const last = flt(frm.doc.last_demanded_qty);
		if (last && demanded && last * 10 <= demanded) {
			frm.dashboard.set_headline_alert(
				__("Last asked for {0} but this row records {1} - check for a mistyped quantity.", [
					format_number(last),
					format_number(demanded),
				]),
				"yellow",
			);
		}

		if (frappe.user.has_role(["System Manager", "Sales Manager"])) {
			frm.add_custom_button(__("Void"), () => {
				frappe.prompt(
					{
						fieldname: "reason",
						fieldtype: "Small Text",
						label: __("Why is this not real demand?"),
						reqd: 1,
					},
					({ reason }) => {
						frappe
							.call({
								method: "pos_next.api.order_loss.void_loss",
								args: { name: frm.doc.name, reason },
							})
							.then(() => frm.reload_doc());
					},
					__("Void Loss"),
					__("Void"),
				);
			});
		}
	},
});
