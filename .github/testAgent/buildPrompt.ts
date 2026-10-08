import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export type PromptMode = 'pr' | 'coverage'

const commitSha = /^[0-9a-f]{40}$/
const scopes = new Set(['frontend', 'backend', 'all'])
const turnLimit = /^[1-9][0-9]{0,3}$/

export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
    if (!(name in values))
      throw new Error(`No value for placeholder ${placeholder}`)
    return values[name]
  })
}

export function promptValues(
  mode: PromptMode,
  options: { base?: string; head?: string; scope?: string; maxTurns?: string },
): Record<string, string> {
  const maxTurns = options.maxTurns ?? (mode === 'pr' ? '80' : '150')
  if (!turnLimit.test(maxTurns) || Number(maxTurns) < 20) {
    throw new Error('--maxTurns must be a whole number of at least 20')
  }
  if (mode === 'pr') {
    if (!options.base || !commitSha.test(options.base)) {
      throw new Error('--base must be a full 40 character commit SHA')
    }
    if (!options.head || !commitSha.test(options.head)) {
      throw new Error('--head must be a full 40 character commit SHA')
    }
    return { baseSha: options.base, headSha: options.head, maxTurns }
  }
  const scope = options.scope ?? 'all'
  if (!scopes.has(scope))
    throw new Error('--scope must be frontend, backend or all')
  return { scope, maxTurns }
}

export function buildPrompt(
  mode: PromptMode,
  options: { base?: string; head?: string; scope?: string; maxTurns?: string },
  templateDirectory: string,
): string {
  const template = readFileSync(
    path.join(templateDirectory, `${mode}Prompt.md`),
    'utf8',
  )
  return fillTemplate(template, promptValues(mode, options))
}

function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      scope: { type: 'string' },
      maxTurns: { type: 'string' },
    },
  })
  const [mode] = positionals
  if (mode !== 'pr' && mode !== 'coverage') {
    process.stderr.write(
      'Usage: buildPrompt.ts pr --base <sha> --head <sha> [--maxTurns <n>]\n       buildPrompt.ts coverage [--scope frontend|backend|all] [--maxTurns <n>]\n',
    )
    process.exit(64)
  }
  process.stdout.write(
    buildPrompt(mode, values, path.join(import.meta.dirname, 'prompts')),
  )
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
