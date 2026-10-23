import type { IpcMainInvokeEvent } from "electron";
import type { PrincipalCapabilityMiddleware } from "../security/PrincipalCapabilityMiddleware";

/** Reuses session membership for task reads, before the handler can load any task data. */
export function createTaskReadHandler<Args extends unknown[], Result>(
  authorization: Pick<PrincipalCapabilityMiddleware, "principalForClient" | "authorizeTaskRead">,
  read: (event: IpcMainInvokeEvent, ...args: Args) => Result,
) {
  return async (event: IpcMainInvokeEvent, ...args: Args): Promise<Awaited<Result>> => {
    const raw = args[0];
    const taskId =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && "taskId" in raw && typeof raw.taskId === "string"
          ? raw.taskId
          : "";
    await authorization.authorizeTaskRead(
      taskId,
      authorization.principalForClient(event.sender.id),
    );
    return await read(event, ...args);
  };
}
