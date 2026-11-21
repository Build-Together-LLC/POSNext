import { ref } from "vue"

// Global toast state
const toastNotification = ref(null)
const showToast = ref(false)

export function useToast() {
	function showToastNotification(title, message, type = "success", icon = null) {
		toastNotification.value = { title, message, type, icon }
		showToast.value = true

		// Auto-hide after 4 seconds
		setTimeout(() => {
			showToast.value = false
			setTimeout(() => {
				toastNotification.value = null
			}, 300) // Wait for fade animation
		}, 4000)
	}

	function showSuccess(message) {
		showToastNotification("Success", message, "success")
	}

	function showError(message, icon = null) {
		showToastNotification("Error", message, "error", icon)
	}

	function showLocked(message, title = "Draft Locked") {
		showToastNotification(title, message, "error", "lock")
	}

	function showWarning(message) {
		showToastNotification("Validation Error", message, "warning")
	}

	function hideToast() {
		showToast.value = false
		setTimeout(() => {
			toastNotification.value = null
		}, 300)
	}

	return {
		toastNotification,
		showToast,
		showSuccess,
		showError,
		showLocked,
		showWarning,
		hideToast,
	}
}
