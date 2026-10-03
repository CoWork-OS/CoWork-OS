/**
 * Applies Memory Hub and kit back-sync changes to the legacy record a memory item mirrors
 * (docs/memory-engine.md §5). Legacy stores remain readable by some prompt paths until the
 * read side switches to `memory_items`, so a forget or an edit must reach them too.
 *
 * Curated entries are changed in the table directly (no kit file sync): the caller is
 * either already inside a kit sync or re-renders the files itself.
 */
import { CuratedMemoryService } from "./CuratedMemoryService";
import type { MemoryItemsLegacyMirror } from "./MemoryItemsHubService";
import { MEMORY_LANE_STORES } from "./memory-items-lanes";
import { RelationshipMemoryService } from "./RelationshipMemoryService";
import { UserProfileService } from "./UserProfileService";

export function createLegacyMemoryMirror(): MemoryItemsLegacyMirror {
  return {
    async edit(ref, content) {
      switch (ref.store) {
        case MEMORY_LANE_STORES.userProfile:
          UserProfileService.updateFact({ id: ref.id, value: content });
          return;
        case MEMORY_LANE_STORES.relationship:
          RelationshipMemoryService.updateItem(ref.id, { text: content });
          return;
        case MEMORY_LANE_STORES.curated:
          await CuratedMemoryService.applyMirroredEdit(ref.id, content);
          return;
        default:
          return;
      }
    },
    async remove(ref, mode) {
      switch (ref.store) {
        case MEMORY_LANE_STORES.userProfile:
          UserProfileService.deleteFact(ref.id);
          return;
        case MEMORY_LANE_STORES.relationship:
          RelationshipMemoryService.deleteItem(ref.id);
          return;
        case MEMORY_LANE_STORES.curated:
          // The curated table has no tombstone; both a forget and a removed kit line
          // archive the entry so it leaves prompts and kit files.
          void mode;
          await CuratedMemoryService.archiveMirroredEntry(ref.id);
          return;
        default:
          return;
      }
    },
    async setPinned(ref, pinned) {
      if (ref.store === MEMORY_LANE_STORES.userProfile) {
        UserProfileService.updateFact({ id: ref.id, pinned });
      }
    },
  };
}
