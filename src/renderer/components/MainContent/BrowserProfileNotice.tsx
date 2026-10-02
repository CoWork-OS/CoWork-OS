/** Browser preview explanations must never alter the native composer. */
export function BrowserProfileNotice({
  notice,
  onReview,
}: {
  notice: string | null;
  onReview: () => void;
}) {
  if (window.coworkBrowserHost !== true || !notice) return null;
  return (
    <div className="permission-profile-notice" role="note">
      <span>{notice}</span>
      <button type="button" className="permission-profile-notice-action" onClick={onReview}>
        Review profiles
      </button>
    </div>
  );
}
