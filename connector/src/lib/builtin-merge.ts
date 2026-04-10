/**
 * Builtin merge marker pattern (from HiClaw manager/scripts/lib/builtin-merge.sh)
 *
 * Allows system-managed skill content to be upgraded without destroying user modifications.
 *
 * Format:
 * <!-- builtin-start -->
 * > DO NOT EDIT this section. Managed by Connector.
 * <!-- builtin-end -->
 * [user content here - preserved across upgrades]
 */

export const BUILTIN_START = '<!-- builtin-start -->';
export const BUILTIN_START_COMMENT = '> DO NOT EDIT this section. Managed by Connector.';
export const BUILTIN_END = '<!-- builtin-end -->';

export interface BuiltinMergeResult {
  merged: string;
  userContent: string;
  hasBuiltin: boolean;
}

/**
 * Merge new builtin content with existing user content.
 * User content after builtin markers is preserved; builtin section is replaced.
 *
 * File format:
 * <!-- builtin-start -->
 * > DO NOT EDIT this section. Managed by Connector.
 * [builtin content]
 * <!-- builtin-end -->
 * [user content here - preserved across upgrades]
 */
export function mergeBuiltinContent(
  builtinContent: string,
  existingFileContent: string
): BuiltinMergeResult {
  const endIdx = existingFileContent.indexOf(BUILTIN_END);

  if (endIdx === -1) {
    // No existing marker — treat entire file as user content
    return {
      merged: builtinContent + '\n\n' + existingFileContent,
      userContent: existingFileContent,
      hasBuiltin: false,
    };
  }

  // Extract user content (after the builtin-end marker)
  const userContent = existingFileContent.substring(endIdx + BUILTIN_END.length).trim();
  const merged = builtinContent + '\n\n' + userContent;

  return { merged, userContent, hasBuiltin: true };
}

/**
 * Strip builtin markers from content to get pure user content.
 * Removes everything from BUILTIN_START through BUILTIN_END.
 */
export function stripBuiltinMarkers(content: string): string {
  const startIdx = content.indexOf(BUILTIN_START);
  const endIdx = content.indexOf(BUILTIN_END);
  if (startIdx === -1 || endIdx === -1) return content;
  return content.substring(endIdx + BUILTIN_END.length).trim();
}
