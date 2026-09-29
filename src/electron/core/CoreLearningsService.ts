import { CoreLearningsRepository } from "./core-repository-facades";
import type { CoreLearningsEntry, ListCoreLearningsRequest } from "../../shared/types";

export class CoreLearningsService {
  constructor(private readonly repo: CoreLearningsRepository) {}

  append(entry: Omit<CoreLearningsEntry, "id"> & { id?: string }) {
    return this.repo.append(entry);
  }

  list(request: ListCoreLearningsRequest = {}) {
    return this.repo.list(request);
  }
}
