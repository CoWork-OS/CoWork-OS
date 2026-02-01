import { ToastNotification } from '../../shared/types';

interface ToastContainerProps {
  toasts: ToastNotification[];
  onDismiss: (id: string) => void;
  onTaskClick?: (taskId: string) => void;
}

function getToastIcon(type: ToastNotification['type']): string {
  switch (type) {
    case 'success':
      return 'OK';
    case 'error':
      return '!';
    case 'info':
      return 'i';
    default:
      return '?';
  }
}

export function ToastContainer({
  toasts,
  onDismiss,
  onTaskClick,
}: ToastContainerProps) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast toast-${toast.type} ${toast.action ? 'toast-with-action' : ''}`}
          onClick={() => toast.taskId && onTaskClick?.(toast.taskId)}
          style={{ cursor: toast.taskId ? 'pointer' : 'default' }}
        >
          <div className={`toast-icon toast-icon-${toast.type}`}>
            {getToastIcon(toast.type)}
          </div>
          <div className="toast-content">
            <div className="toast-title">{toast.title}</div>
            {toast.message && (
              <div className="toast-message">{toast.message}</div>
            )}
            {toast.action && (
              <button
                className="toast-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  toast.action?.callback();
                  onDismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
          <button
            className="toast-dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(toast.id);
            }}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}

export default ToastContainer;
