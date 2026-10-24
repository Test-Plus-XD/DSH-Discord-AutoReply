import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Per-user data (state.json, style.local.md, the sessions' working directory).
 * It lives outside the package, so reinstalling or updating the plugin keeps it.
 */
export const DATA_DIR = join(homedir(), '.dsh', 'discord-autoreply')
