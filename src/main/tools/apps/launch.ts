/**
 * How to start an app from its Start-menu id. Most ids are app ids for the Apps folder; game
 * launchers register links instead (steam://rungameid/730, com.epicgames.launcher://apps/…),
 * which have to be opened as links.
 */
export function launchKind(appId: string): 'link' | 'apps-folder' {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(appId) && !/^(?:file|javascript|data):/i.test(appId)
    ? 'link'
    : 'apps-folder';
}
