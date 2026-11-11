import { CREATE_HISTORY_PAGE_LIMIT } from '../../features/library/libraryWindow.js';

/** Earlier prompts sent as context to control generation. */
export const PROMPT_HISTORY_LIMIT = 3;

export const CREATE_HISTORY_BINDING = Object.freeze({
  limit: CREATE_HISTORY_PAGE_LIMIT,
});
export const HTTP_NOT_FOUND = 404;
export const DETAIL_FAILED = "This image's settings could not be loaded.";
export const DETAIL_GONE = 'That image is no longer in the library.';
export const DETAIL_SUPERSEDED =
  "The draft changed before that image's settings loaded, so it was left as it is.";
