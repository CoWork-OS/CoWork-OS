import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileViewerResult } from '../../electron/preload';

interface FileViewerProps {
  filePath: string;
  workspacePath: string;
  onClose: () => void;
}

export function FileViewer({ filePath, workspacePath, onClose }: FileViewerProps) {
  const [loading, setLoading] = useState(true);
  const [fileData, setFileData] = useState<FileViewerResult['data'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load file on mount
  useEffect(() => {
    const loadFile = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await window.electronAPI.readFileForViewer(filePath, workspacePath);
        if (result.success && result.data) {
          setFileData(result.data);
        } else {
          setError(result.error || 'Failed to load file');
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load file');
      } finally {
        setLoading(false);
      }
    };
    loadFile();
  }, [filePath, workspacePath]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Open in external app
  const handleOpenExternal = async () => {
    try {
      await window.electronAPI.openFile(filePath, workspacePath);
    } catch (err) {
      console.error('Failed to open file externally:', err);
    }
  };

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Get file icon based on type
  const getFileIcon = (type?: string): string => {
    switch (type) {
      case 'markdown': return '📝';
      case 'code': return '💻';
      case 'text': return '📄';
      case 'docx': return '📘';
      case 'pdf': return '📕';
      case 'image': return '🖼️';
      case 'pptx': return '📊';
      default: return '📁';
    }
  };

  // Render content based on file type
  const renderContent = () => {
    if (!fileData) return null;

    switch (fileData.fileType) {
      case 'markdown':
        return (
          <div className="file-viewer-markdown markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {fileData.content || ''}
            </ReactMarkdown>
          </div>
        );

      case 'code':
      case 'text':
        return (
          <pre className="file-viewer-code">
            {fileData.content}
          </pre>
        );

      case 'docx':
        return (
          <div
            className="file-viewer-docx"
            dangerouslySetInnerHTML={{ __html: fileData.htmlContent || '' }}
          />
        );

      case 'pdf':
        return (
          <div className="file-viewer-pdf">
            <pre className="file-viewer-code">{fileData.content}</pre>
          </div>
        );

      case 'image':
        return (
          <div className="file-viewer-image-container">
            <img
              src={fileData.content || ''}
              alt={fileData.fileName}
              className="file-viewer-image"
            />
          </div>
        );

      case 'pptx':
        return (
          <div className="file-viewer-placeholder">
            <span className="file-viewer-placeholder-icon">📊</span>
            <p>PowerPoint preview is not available.</p>
            <button onClick={handleOpenExternal} className="file-viewer-open-btn">
              Open in PowerPoint
            </button>
          </div>
        );

      default:
        return (
          <div className="file-viewer-placeholder">
            <span className="file-viewer-placeholder-icon">📁</span>
            <p>This file type cannot be previewed.</p>
            <button onClick={handleOpenExternal} className="file-viewer-open-btn">
              Open with Default App
            </button>
          </div>
        );
    }
  };

  // Use portal to render at document body level (escapes parent container constraints)
  return createPortal(
    <div className="file-viewer-overlay" onClick={onClose}>
      <div className="file-viewer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="file-viewer-header">
          <div className="file-viewer-title">
            <span className="file-viewer-icon">{getFileIcon(fileData?.fileType)}</span>
            <span className="file-viewer-filename">{fileData?.fileName || filePath.split('/').pop()}</span>
            {fileData && (
              <span className="file-viewer-size">{formatSize(fileData.size)}</span>
            )}
          </div>
          <div className="file-viewer-actions">
            <button
              className="file-viewer-action-btn"
              onClick={handleOpenExternal}
              title="Open in external app"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z"/>
                <path d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z"/>
              </svg>
            </button>
            <button
              className="file-viewer-action-btn file-viewer-close-btn"
              onClick={onClose}
              title="Close (Esc)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
              </svg>
            </button>
          </div>
        </div>

        <div className="file-viewer-content">
          {loading && (
            <div className="file-viewer-loading">
              <div className="file-viewer-spinner"></div>
              <span>Loading file...</span>
            </div>
          )}

          {error && (
            <div className="file-viewer-error">
              <span className="file-viewer-error-icon">⚠️</span>
              <p>{error}</p>
              <button onClick={handleOpenExternal} className="file-viewer-open-btn">
                Try Opening with Default App
              </button>
            </div>
          )}

          {!loading && !error && renderContent()}
        </div>
      </div>
    </div>,
    document.body
  );
}
