import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

export const repoRoot = path.resolve(import.meta.dirname, '../../..')
export const fixturesDirectory = path.join(import.meta.dirname, 'fixtures')

export function createTempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'testAgentTooling-'))
  after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}
