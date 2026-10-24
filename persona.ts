/**
 * Persona for the `discord` agent preset (replaces @deepseek-ai/dsh-persona there).
 * Registers the complete system prompt: the base persona from the preset config
 * plus your writing style from style.local.md. DSH evaluates the text on every
 * request and the file is re-read when it changes, so style edits need no reload.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostContext } from './types.ts'

export const name = 'discord-autoreply-persona'
export const inject = ['systemPrompt']

const HERE = dirname(fileURLToPath(import.meta.url))
/** The section the stock persona plugin owns; a scoped registration shadows the global one. */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

export interface PersonaConfig {
  prefix: string
  /** Style file path, relative to this folder. */
  styleFile?: string
  includeRuntimeContext?: boolean
}

function styleReader(file: string): () => string {
  let mtime = -1
  let text = ''
  return () => {
    let current = -1
    try { current = statSync(file).mtimeMs } catch {}
    if (current !== mtime) {
      mtime = current
      // HTML comments are notes for whoever edits the file, not for the model.
      try { text = current < 0 ? '' : readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim() } catch { text = '' }
    }
    return text
  }
}

export function apply(ctx: HostContext, config: PersonaConfig): void {
  const file = config.styleFile ?? 'style.local.md'
  const readStyle = styleReader(isAbsolute(file) ? file : join(HERE, file))
  const compose = (): string => {
    // `{{name}}` is DSH prompt-variable syntax; keep chat samples from being parsed as one.
    const style = readStyle().replaceAll('{{', '{ {')
    return style
      ? `${config.prefix}\n\n# How the user writes\nMirror this style. Where it conflicts with the general style above, this wins.\n\n${style}`
      : config.prefix
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: compose,
    complete: true,
  }), 'discord-autoreply-persona.section()')
  if (!(config.includeRuntimeContext ?? false)) ctx.systemPrompt.suppressRuntimeContext()
}
