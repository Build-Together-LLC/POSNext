<template>
	<component :is="tag" :="$attrs" v-html="sanitizedHtml" />
</template>

<script setup>
import DOMPurify from "dompurify"
import { computed } from "vue"

const props = defineProps({
	tag: {
		type: String,
		required: false,
		default: "span",
	},
	inner: {
		type: String,
		required: true,
	},
})

const sanitizedHtml = computed(() => DOMPurify.sanitize(props.inner || ""))
</script>
