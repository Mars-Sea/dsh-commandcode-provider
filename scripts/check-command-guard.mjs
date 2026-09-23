/**
 * Explain what the AI command guard would do with a command, without calling
 * anything: which denylist rule refuses to judge it, or that it would be sent
 * to the decision model.
 *
 * This is the isolation tool for "why was I (not) asked?" and for tuning the
 * list: it imports the REAL module, so the answer cannot drift from what the
 * plugin runs. It judges nothing by itself — `deny` here means the guard
 * delegates to the human prompt, never that the command is refused.
 *
 * Run:
 *   node --import tsx scripts/check-command-guard.mjs 'git push origin main'
 *   node --import tsx scripts/check-command-guard.mjs 'rm -rf ./build' 'sudo ls'
 *   node --import tsx scripts/check-command-guard.mjs            # shows the whole list
 */

import {
  COMMAND_GUARD_DENY_LIST,
  COMMAND_GUARD_DEFAULT_THRESHOLD,
  COMMAND_GUARD_MAX_COMMAND_CHARS,
  commandExcerpt,
  denyReasonOf,
} from '../src/command-guard.ts'

const commands = process.argv.slice(2)

if (commands.length === 0) {
  console.log(`denylist: ${COMMAND_GUARD_DENY_LIST.length} rules, never sent to the model`)
  for (const entry of COMMAND_GUARD_DENY_LIST) console.log(`  ${entry.id.padEnd(24)} ${entry.pattern}`)
  console.log('')
  console.log(`everything else: sent to typesafe/jev, approved only at P(safe) >= ${COMMAND_GUARD_DEFAULT_THRESHOLD}`)
  console.log(`commands longer than ${COMMAND_GUARD_MAX_COMMAND_CHARS} characters are delegated without judging`)
  process.exit(0)
}

for (const command of commands) {
  const rule = denyReasonOf(command)
  const verdict = rule === undefined
    ? `model judgement at P(safe) >= ${COMMAND_GUARD_DEFAULT_THRESHOLD}`
    : `denylisted (${rule}) — delegated to the human prompt`
  console.log(`${verdict}\n  ${commandExcerpt(command, 200)}\n`)
}
