import { CoreLearningsRepository } from "./core-repository-facades";
import type { CoreLearningsEntry, ListCoreLearningsRequest } from "../../shared/types";

/** Repeats of the same learning inside this window are not logged again. */
export const CORE_LEARNINGS_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class CoreLearningsService {
  constructor(private readonly repo: CoreLearningsRepository) {}

  append(entry: Omit<CoreLearningsEntry, "id"> & { id?: string }) {
    return this.repo.append(entry);
  }

  /** Appends unless the same entry was already logged within `windowMs`. */
  appendIfNovel(
    entry: Omit<CoreLearningsEntry, "id"> & { id?: string },
    windowMs = CORE_LEARNINGS_DEDUPE_WINDOW_MS,
  ) {
    return this.repo.appendIfNovel(entry, windowMs);
  }

  list(request: ListCoreLearningsRequest = {}) {
    return this.repo.list(request);
  }
}
