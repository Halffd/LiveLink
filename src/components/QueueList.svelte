<script lang="ts">
  import type { StreamSource } from '$types/stream';
  import { streamQueues } from '$lib/stores';

  let { screen, queue } = $props<{
    screen: number;
    queue: StreamSource[];
  }>();

  let draggedIndex = $state<number | null>(null);

  async function reorderQueue(sourceIndex: number, targetIndex: number) {
    try {
      const response = await fetch('/api/streams/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screen,
          sourceIndex,
          targetIndex
        })
      });

      if (!response.ok) throw new Error('Failed to reorder queue');

      // Update local queue
      streamQueues.update(queues => {
        const currentQueue = [...(queues.get(screen) || [])];
        const [item] = currentQueue.splice(sourceIndex, 1);
        currentQueue.splice(targetIndex, 0, item);
        queues.set(screen, currentQueue);
        return queues;
      });

    } catch (error) {
      console.error('Failed to reorder queue:', error);
    }
  }

  function handleDragStart(event: DragEvent, index: number) {
    draggedIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  function handleDragOver(event: DragEvent, index: number) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDrop(event: DragEvent, index: number) {
    event.preventDefault();
    if (draggedIndex !== null && draggedIndex !== index) {
      reorderQueue(draggedIndex, index);
    }
    draggedIndex = null;
  }
</script>

<div class="mt-6">
  <h3 class="text-lg font-semibold mb-4">Queue</h3>
  
  {#if queue.length === 0}
    <div class="text-center py-4 bg-gray-700 rounded text-gray-400">
      Queue is empty
    </div>
  {:else}
    <div class="space-y-2">
      {#each queue as stream, i}
        <div
          class="bg-gray-700 p-3 rounded-lg cursor-move hover:bg-gray-600 transition-colors"
          draggable="true"
          on:dragstart={(e) => handleDragStart(e, i)}
          on:dragover={(e) => handleDragOver(e, i)}
          on:drop={(e) => handleDrop(e, i)}
        >
          <div class="flex justify-between items-start">
            <div class="space-y-1">
              <h4 class="font-medium truncate max-w-[300px]">
                {stream.title || 'Untitled Stream'}
              </h4>
              <p class="text-sm text-gray-400 truncate max-w-[300px]">
                {stream.url}
              </p>
              {#if stream.viewerCount !== undefined}
                <p class="text-sm text-gray-400">
                  {stream.viewerCount.toLocaleString()} viewers
                </p>
              {/if}
            </div>

            <div class="flex items-center space-x-2">
              {#if stream.platform}
                <span class="text-xs px-2 py-1 rounded bg-gray-800 text-gray-300">
                  {stream.platform}
                </span>
              {/if}
              <button
                class="p-1.5 rounded hover:bg-gray-500 transition-colors"
                on:click={() => {
                  streamQueues.update(queues => {
                    const currentQueue = [...(queues.get(screen) || [])];
                    currentQueue.splice(i, 1);
                    queues.set(screen, currentQueue);
                    return queues;
                  });
                }}
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div> 