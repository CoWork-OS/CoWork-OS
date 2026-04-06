import type { CoreLearningsEntry, ListCoreLearningsRequest } from "../../shared/types";
import { CoreLearningsRepository } from "./CoreLearningsRepository";

export class CoreLearningsService {
  constructor(private readonly repo: CoreLearningsRepository) {}

  append(entry: Omit<CoreLearningsEntry, "id"> & { id?: string }) {
    return this.repo.append(entry);
  }

  list(request: ListCoreLearningsRequest = {}) {
    return this.repo.list(request);
  }
}
