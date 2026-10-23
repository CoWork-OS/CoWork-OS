export const CODE_PREVIEWS_EXPANDED_KEY = "cowork:codePreviewsExpanded";
export const TASK_TITLE_MAX_LENGTH = 50;
export const TITLE_ELLIPSIS_REGEX = /(\.\.\.|…)$/u;
export const MAX_ATTACHMENTS = 10;
export const MAX_QUOTED_ASSISTANT_MESSAGE_CHARS = 4000;
export const MAX_QUOTED_ASSISTANT_PREVIEW_CHARS = 280;
export const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
export const VIDEO_FILE_EXT_RE = /\.(mp4|webm)$/i;
/** glTF models the in-chat 3D viewer shows. */
export const MODEL_FILE_EXT_RE = /\.(glb|gltf)$/i;
export type PermissionAccessMode = import("../../../shared/access-profiles").AccessProfileId;
export const HTML_FILE_EXT_RE = /\.html?$/i;
export const DOCUMENT_PREVIEW_EXT_RE =
  /\.(pdf|docx|docm|dotx|dotm|doc|rtf|odt|ott|pages|md|markdown|tex|txt)$/i;
export const WELCOME_TASK_SUGGESTION_LIMIT = 5;
export const WELCOME_SUGGESTION_TEXT_MAX = 96;
export const TASK_FEED_MEASUREMENT_LAYOUT_VERSION = "diff-spacing-v2";
export const COLLAPSED_USER_BUBBLE_MAX_HEIGHT = 220;
export const COLLAPSED_USER_BUBBLE_MIN_HEIGHT = 96;
