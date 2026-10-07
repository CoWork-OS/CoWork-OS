/** Settle each section independently so a failed dependency cannot discard saved routines. */
export async function loadRoutineSettingsData<
  TRoutines,
  TRuns,
  TWorkspaces,
  THooks,
  TServers,
  TCron,
  TMailboxes,
>(loaders: {
  routines: () => Promise<TRoutines>;
  runs: () => Promise<TRuns>;
  workspaces: () => Promise<TWorkspaces>;
  hooks: () => Promise<THooks>;
  servers: () => Promise<TServers>;
  cron: () => Promise<TCron>;
  mailboxes: () => Promise<TMailboxes>;
}) {
  const [routines, runs, workspaces, hooks, servers, cron, mailboxes] = await Promise.allSettled([
    Promise.resolve().then(loaders.routines),
    Promise.resolve().then(loaders.runs),
    Promise.resolve().then(loaders.workspaces),
    Promise.resolve().then(loaders.hooks),
    Promise.resolve().then(loaders.servers),
    Promise.resolve().then(loaders.cron),
    Promise.resolve().then(loaders.mailboxes),
  ]);
  return { routines, runs, workspaces, hooks, servers, cron, mailboxes };
}
