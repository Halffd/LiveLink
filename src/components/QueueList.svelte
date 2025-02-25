<script lang="ts">
  import type { StreamSource } from '../types/stream.js';
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
  
  function removeFromQueue(index: number) {
    streamQueues.update(queues => {
      const currentQueue = [...(queues.get(screen) || [])];
      currentQueue.splice(index, 1);
      queues.set(screen, currentQueue);
      return queues;
    });
  }
</script>

<div class="mt-4">
  <div class="card card-dark">
    <div class="card-header card-header-dark d-flex justify-content-between align-items-center">
      <h5 class="mb-0">Queue</h5>
      <span class="badge bg-info">{queue.length}</span>
    </div>
    
    <div class="card-body">
      {#if queue.length === 0}
        <div class="alert alert-secondary text-center">
          Queue is empty
        </div>
      {:else}
        <div class="list-group">
          {#each queue as stream, i}
            <div
              class="list-group-item list-group-item-action bg-dark text-light border-secondary"
              draggable="true"
              role="listitem"
              ondragstart={(e) => handleDragStart(e, i)}
              ondragover={(e) => handleDragOver(e, i)}
              ondrop={(e) => handleDrop(e, i)}
            >
              <div class="d-flex justify-content-between align-items-start">
                <div>
                  <h6 class="mb-1 text-truncate" style="max-width: 300px;">
                    {stream.title || 'Untitled Stream'}
                  </h6>
                  <p class="mb-1 text-muted small text-truncate" style="max-width: 300px;">
                    {stream.url}
                  </p>
                  {#if stream.viewerCount !== undefined}
                    <span class="badge bg-secondary">
                      {stream.viewerCount.toLocaleString()} viewers
                    </span>
                  {/if}
                </div>

                <div class="d-flex align-items-center">
                  {#if stream.platform}
                    <span class="badge bg-primary me-2">
                      {stream.platform}
                    </span>
                  {/if}
                  <button
                    class="btn btn-sm btn-outline-danger"
                    aria-label="Remove from queue"
                    onclick={() => removeFromQueue(i)}
                  >
                    <i class="bi bi-x"></i>
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .card-dark {
    background-color: #2c2c2c;
    border-color: #444;
    color: #f8f9fa;
  }
  
  .card-header-dark {
    background-color: #222;
    border-color: #444;
    color: #f8f9fa;
  }
  
  /* Drag and drop styling */
  [draggable=true] {
    cursor: move;
  }
  
  /* Bootstrap Icons fallback */
  .bi-x::before {
    content: "×";
    font-size: 1.5rem;
    line-height: 1;
  }
</style> 