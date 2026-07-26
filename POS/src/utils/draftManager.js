// Draft Invoice Management with IndexedDB
const DB_NAME = "pos_next_drafts"
const DB_VERSION = 1
const STORE_NAME = "invoices"

let db = null

function sanitizeDraftData(data) {
	if (data === null || data === undefined) {
		return data
	}

	try {
		// Vue reactive refs/proxies can't be stored directly in IndexedDB.
		// Serializing through JSON removes reactivity while keeping data shallow.
		return JSON.parse(JSON.stringify(data))
	} catch (error) {
		console.warn("Failed to sanitize draft data for IndexedDB storage", error)
		throw error
	}
}

export function buildDraftId() {
	// Pick number format: DDMMYYHHMMSS
	//   DD = day, MM = month, YY = year (2-digit), HH = hour (24h), MM = minute, SS = second
	// e.g. 26 Jul 2026 12:08:45 -> 260726120845
	const now = new Date()
	const pad = (value) => String(value).padStart(2, "0")
	const dd = pad(now.getDate())
	const mm = pad(now.getMonth() + 1)
	const yy = pad(now.getFullYear() % 100)
	const hh = pad(now.getHours())
	const min = pad(now.getMinutes())
	const ss = pad(now.getSeconds())

	return `${dd}${mm}${yy}${hh}${min}${ss}`
}

function getExistingDraftIds(database) {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction([STORE_NAME], "readonly")
		const request = transaction.objectStore(STORE_NAME).index("draft_id").getAllKeys()

		request.onsuccess = () => resolve(new Set(request.result))
		request.onerror = () => reject(request.error)
	})
}

async function buildUniqueDraftId(database) {
	const baseId = buildDraftId()
	const existingIds = await getExistingDraftIds(database)

	if (!existingIds.has(baseId)) return baseId

	// Same-second collision: the 2nd save gets "1" appended, the 3rd "2", etc.
	// e.g. 260726120845, then 2607261208451, then 2607261208452, ...
	let suffix = 1
	while (existingIds.has(`${baseId}${suffix}`)) suffix++

	return `${baseId}${suffix}`
}

// Initialize IndexedDB
async function initDB() {
	if (db) return db

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION)

		request.onerror = () => reject(request.error)
		request.onsuccess = () => {
			db = request.result
			resolve(db)
		}

		request.onupgradeneeded = (event) => {
			const database = event.target.result

			// Create object store if it doesn't exist
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				const objectStore = database.createObjectStore(STORE_NAME, {
					keyPath: "id",
					autoIncrement: true,
				})

				// Create indexes
				objectStore.createIndex("draft_id", "draft_id", { unique: true })
				objectStore.createIndex("created_at", "created_at", { unique: false })
				objectStore.createIndex("customer", "customer", { unique: false })
			}
		}
	})
}

// Save draft invoice
export async function saveDraft(invoiceData) {
	const database = await initDB()
	const sanitizedInvoiceData = sanitizeDraftData(invoiceData) || {}

	const draft = {
		draft_id: await buildUniqueDraftId(database),
		...sanitizedInvoiceData,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	}

	return new Promise((resolve, reject) => {
		const transaction = database.transaction([STORE_NAME], "readwrite")
		const store = transaction.objectStore(STORE_NAME)
		const request = store.add(draft)

		request.onsuccess = () => resolve(draft)
		request.onerror = () => reject(request.error)
	})
}

// Update existing draft
export async function updateDraft(draftId, invoiceData) {
	const database = await initDB()

	return new Promise(async (resolve, reject) => {
		try {
			// Get existing draft
			const existingDraft = await getDraftById(draftId)
			if (!existingDraft) {
				return reject(new Error("Draft not found"))
			}

			const sanitizedInvoiceData = sanitizeDraftData(invoiceData) || {}
			const updatedDraft = {
				...existingDraft,
				...sanitizedInvoiceData,
				updated_at: new Date().toISOString(),
			}

			const transaction = database.transaction([STORE_NAME], "readwrite")
			const store = transaction.objectStore(STORE_NAME)
			const request = store.put(updatedDraft)

			request.onsuccess = () => resolve(updatedDraft)
			request.onerror = () => reject(request.error)
		} catch (error) {
			reject(error)
		}
	})
}

// Get all draft invoices
export async function getAllDrafts() {
	const database = await initDB()

	return new Promise((resolve, reject) => {
		const transaction = database.transaction([STORE_NAME], "readonly")
		const store = transaction.objectStore(STORE_NAME)
		const request = store.getAll()

		request.onsuccess = () => {
			// Sort by created_at descending
			const drafts = request.result.sort(
				(a, b) => new Date(b.created_at) - new Date(a.created_at),
			)
			resolve(drafts)
		}
		request.onerror = () => reject(request.error)
	})
}

// Get draft by ID
export async function getDraftById(draftId) {
	const database = await initDB()

	return new Promise((resolve, reject) => {
		const transaction = database.transaction([STORE_NAME], "readonly")
		const store = transaction.objectStore(STORE_NAME)
		const index = store.index("draft_id")
		const request = index.get(draftId)

		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

// Delete draft
export async function deleteDraft(draftId) {
	const database = await initDB()

	return new Promise(async (resolve, reject) => {
		try {
			const draft = await getDraftById(draftId)
			if (!draft) {
				return reject(new Error("Draft not found"))
			}

			const transaction = database.transaction([STORE_NAME], "readwrite")
			const store = transaction.objectStore(STORE_NAME)
			const request = store.delete(draft.id)

			request.onsuccess = () => resolve(true)
			request.onerror = () => reject(request.error)
		} catch (error) {
			reject(error)
		}
	})
}

// Clear all drafts
export async function clearAllDrafts() {
	const database = await initDB()

	return new Promise((resolve, reject) => {
		const transaction = database.transaction([STORE_NAME], "readwrite")
		const store = transaction.objectStore(STORE_NAME)
		const request = store.clear()

		request.onsuccess = () => resolve(true)
		request.onerror = () => reject(request.error)
	})
}

// Get drafts count
export async function getDraftsCount() {
	const database = await initDB()

	return new Promise((resolve, reject) => {
		const transaction = database.transaction([STORE_NAME], "readonly")
		const store = transaction.objectStore(STORE_NAME)
		const request = store.count()

		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}
