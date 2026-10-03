/** Settle each section independently so a failed dependency cannot discard saved routines. */
export async function loadRoutineSettingsData<
  TRoutines,
  TRuns,
  TWorkspaces,
  THooks,
  TServers,
  TCron,
>(loaders: {
  routines: () => Promise<TRoutines>;
  runs: () => Promise<TRuns>;
  workspaces: () => Promise<TWorkspaces>;
  hooks: () => Promise<THooks>;
  servers: () => Promise<TServers>;
  cron: () => Promise<TCron>;
}) {
  const [routines, runs, workspaces, hooks, servers, cron] = await Promise.allSettled([
    Promise.resolve().then(loaders.routines),
    Promise.resolve().then(loaders.runs),
    Promise.resolve().then(loaders.workspaces),
    Promise.resolve().then(loaders.hooks),
    Promise.resolve().then(loaders.servers),
    Promise.resolve().then(loaders.cron),
  ]);
  return { routines, runs, workspaces, hooks, servers, cron };
}
