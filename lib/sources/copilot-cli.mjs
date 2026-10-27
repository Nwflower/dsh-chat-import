// Copilot CLI host IO: one events.jsonl per session directory. cwd and the
// workspace identity live inside the transcript (session.start.context), so no
// sidecar derive is needed; collection only picks the event stream itself.
import { collectFiles } from '../import-batch.mjs'

export function collectCopilotCliFiles(ctx, target, out, recursive) {
  return collectFiles(ctx, target, out, recursive, (entry) =>
    /^events\.jsonl$/i.test(entry.name))
}
