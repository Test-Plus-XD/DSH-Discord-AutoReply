// Persona for the `lightrag-judge` agent preset. It replaces the stock persona section with the judge persona from
// the preset config and suppresses DSH's runtime-context message (working folder, sandbox policy), so the judge sees
// only its persona and the RAGAS prompt. DSH evaluates `{{model}}` in the text on every request.
export const name = 'lightrag-judge-persona'
export const inject = ['systemPrompt']

// The section the stock persona plugin owns; a preset-scoped registration shadows the global one.
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

// Registers the judge persona as the complete persona section for sessions that use this preset.
export function apply(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: () => config.prefix,
    complete: true,
  }), 'lightrag-judge-persona.section()')
  ctx.systemPrompt.suppressRuntimeContext()
}
