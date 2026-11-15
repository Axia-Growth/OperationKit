/** Mock arm: replays a recorded transcript. No model call, no network. */
import { loadTranscript, replayTranscript } from '../transcript.js'
import type { Arm } from '../types.js'
import type { ArmContext, ArmResult, ArmRunner } from './common.js'

export function replayArm(arm: Arm, transcriptsDir: string): ArmRunner {
  return {
    arm,
    async run(ctx: ArmContext): Promise<ArmResult> {
      const tr = loadTranscript(transcriptsDir, arm, ctx.task.id)
      return { outcome: replayTranscript(tr, ctx.workdir) }
    },
  }
}
