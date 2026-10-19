import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { usePOSSettingsStore } from "../posSettings"

vi.mock("frappe-ui", () => ({
	createResource: vi.fn(() => ({
		submit: vi.fn(),
		reload: vi.fn(),
		fetch: vi.fn(),
		loading: false,
		data: null,
		error: null,
	})),
	call: vi.fn(),
}))

vi.mock("../bootstrap", () => ({
	useBootstrapStore: () => ({
		pos_settings: {},
		isLoaded: true,
	}),
}))

describe("POS Settings Store - Reports Flag", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		localStorage.clear()
	})

	it("defaults enable_reports_in_posnext to 0 and enableReportsInPosNext to false", () => {
		const store = usePOSSettingsStore()
		expect(store.settings.enable_reports_in_posnext).toBe(0)
		expect(store.enableReportsInPosNext).toBe(false)
	})

	it("reflects enabled reports when enable_reports_in_posnext is set to 1", () => {
		const store = usePOSSettingsStore()
		store.settings.enable_reports_in_posnext = 1
		expect(store.enableReportsInPosNext).toBe(true)

		store.settings.enable_reports_in_posnext = 0
		expect(store.enableReportsInPosNext).toBe(false)
	})

	it("updates enableReportsInPosNext when settings are loaded from server", () => {
		const store = usePOSSettingsStore()
		Object.assign(store.settings, {
			pos_profile: "Standard Profile",
			enable_reports_in_posnext: 1,
		})
		expect(store.enableReportsInPosNext).toBe(true)
	})
})

