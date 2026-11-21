import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

let mockCallResponse = {}
const mockCall = vi.fn().mockImplementation(() => Promise.resolve(mockCallResponse))

vi.mock("@/utils/apiWrapper", () => ({
	call: (...args) => mockCall(...args),
}))

import { useEditLock } from "../useEditLock"

describe("useEditLock composable", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		mockCall.mockClear()
	})

	afterEach(async () => {
		const { release } = useEditLock()
		await release()
		vi.useRealTimers()
	})

	it("acquires lock successfully when document is not locked by another user", async () => {
		mockCallResponse = { ok: true, locked: false, user: "test@example.com" }
		const { acquire, isHolding, lockedBy } = useEditLock()

		const success = await acquire("Sales Invoice", "SINV-001")

		expect(success).toBe(true)
		expect(isHolding("Sales Invoice", "SINV-001")).toBe(true)
		expect(lockedBy.value).toBeNull()
		expect(mockCall).toHaveBeenCalledWith("pos_next.api.edit_lock.claim", {
			doctype: "Sales Invoice",
			name: "SINV-001",
		})
	})

	it("returns false and sets lockedBy when document is locked by another user", async () => {
		mockCallResponse = {
			ok: true,
			locked: true,
			user: "other@example.com",
			full_name: "Other User",
			message: "This draft is currently being edited by Other User. Please try again later.",
		}
		const { acquire, isHolding, lockedBy } = useEditLock()

		const success = await acquire("Sales Invoice", "SINV-002")

		expect(success).toBe(false)
		expect(isHolding("Sales Invoice", "SINV-002")).toBe(false)
		expect(lockedBy.value).toEqual(mockCallResponse)
	})

	it("runs heartbeat to renew lock while held", async () => {
		mockCallResponse = { ok: true, locked: false, user: "test@example.com" }
		const { acquire } = useEditLock()

		await acquire("Sales Invoice", "SINV-003")
		expect(mockCall).toHaveBeenCalledTimes(1)

		// Advance timer by 25s (HEARTBEAT_MS)
		await vi.advanceTimersByTimeAsync(25000)
		expect(mockCall).toHaveBeenCalledTimes(2)

		// Advance timer by another 25s
		await vi.advanceTimersByTimeAsync(25000)
		expect(mockCall).toHaveBeenCalledTimes(3)
	})

	it("releases lock and stops heartbeat on release", async () => {
		mockCallResponse = { ok: true, locked: false, user: "test@example.com" }
		const { acquire, release, isHolding } = useEditLock()

		await acquire("Sales Invoice", "SINV-004")
		expect(isHolding("Sales Invoice", "SINV-004")).toBe(true)

		mockCall.mockClear()
		mockCallResponse = { ok: true, released: true }

		await release()
		expect(isHolding("Sales Invoice", "SINV-004")).toBe(false)
		expect(mockCall).toHaveBeenCalledWith("pos_next.api.edit_lock.release", {
			doctype: "Sales Invoice",
			name: "SINV-004",
		})

		// Timer should be cleared, no further heartbeat calls
		mockCall.mockClear()
		await vi.advanceTimersByTimeAsync(50000)
		expect(mockCall).not.toHaveBeenCalled()
	})
})
