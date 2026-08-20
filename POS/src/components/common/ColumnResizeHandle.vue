<!--
	Drag grip for a resizable table column. Sits on the trailing edge of a
	<th> (which must be position: relative) - slide it out to expand the
	column, back in to collapse it, double-click to reset.

	`column` is an object built by createResizableColumn() in the parent.
-->
<template>
	<span
		role="separator"
		aria-orientation="vertical"
		tabindex="0"
		:aria-label="__('Resize {0} column', [column.label])"
		:aria-valuenow="column.width"
		:aria-valuemin="column.minWidth"
		:aria-valuemax="column.maxWidth"
		:title="__('Drag left or right to resize, double-click to reset')"
		@pointerdown="column.start"
		@dblclick="column.reset"
		@keydown="column.onKeydown"
		:class="[
			'group/resize absolute top-0 end-0 h-full w-3 flex items-center justify-center',
			'cursor-col-resize select-none touch-none focus:outline-none',
			column.resizing ? 'bg-blue-100' : 'hover:bg-blue-50',
		]"
	>
		<span
			:class="[
				'block h-1/2 w-[2px] rounded-full transition-colors duration-100',
				column.resizing
					? 'bg-blue-500'
					: 'bg-gray-300 group-hover/resize:bg-blue-400 group-focus/resize:bg-blue-500',
			]"
		></span>
	</span>
</template>

<script setup>
defineProps({
	column: {
		type: Object,
		required: true,
	},
})
</script>
