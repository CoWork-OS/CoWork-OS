export type RoutineListDisplayState = "unavailable" | "empty" | "loaded";

export function getRoutineListDisplayState(
  listLoaded: boolean,
  routineCount: number,
): RoutineListDisplayState {
  if (!listLoaded) return "unavailable";
  return routineCount === 0 ? "empty" : "loaded";
}
