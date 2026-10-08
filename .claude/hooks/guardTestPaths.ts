import { readFileSync } from 'node:fs'
import { evaluateToolCall } from './pathPolicy.ts'

const decision = evaluateToolCall(
  readFileSync(0, 'utf8'),
  process.env.CLAUDE_PROJECT_DIR,
)

if (!decision.allowed) {
  process.stderr.write(`${decision.reason}\n`)
  process.exit(2)
}
