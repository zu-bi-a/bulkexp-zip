// Blocks publishing while package.json still has placeholder repository fields
// (npm provenance rejects a package whose repository doesn't match the GitHub repo).
import { readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
if (JSON.stringify([pkg.repository, pkg.homepage, pkg.bugs]).includes('YOUR_GITHUB_USER')) {
  console.error('package.json: replace YOUR_GITHUB_USER in repository/homepage/bugs before publishing.')
  process.exit(1)
}
