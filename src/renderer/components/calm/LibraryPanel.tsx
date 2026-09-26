import { FileHub } from "../FileHub";

interface LibraryPanelProps {
  workspaceId?: string;
}

/** One place for every file CoWork has produced or can reach. */
export function LibraryPanel({ workspaceId }: LibraryPanelProps) {
  return (
    <main className="main-content calm-view calm-library">
      <div className="calm-view-inner">
        <header className="calm-view-header">
          <h1 className="calm-view-title">Library</h1>
          <p className="calm-view-subtitle">
            Documents, spreadsheets, decks and apps your tasks have created, plus files from
            connected sources.
          </p>
        </header>
        <section className="calm-card calm-library-card">
          <FileHub workspaceId={workspaceId} />
        </section>
      </div>
    </main>
  );
}
