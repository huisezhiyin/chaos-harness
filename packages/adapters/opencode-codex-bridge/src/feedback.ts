export interface LocalFeedback {
  source: "chaos_command" | "legacy_survey" | "feedback_api"
  score?: 1 | 2 | 3
  disposition: "rated" | "dismissed" | "prompt_only"
}

/** Narrow compatibility guard for the observed survey, not a generic number filter. */
export function parseLocalFeedback(text: string): LocalFeedback | undefined {
  const value = text.trim()
  const command = /^\/chaos-feedback(?:\s+([0-3]))?$/.exec(value)
  if (command) return feedback(command[1], "chaos_command")
  const survey = /^─{10,}\r?\n\*\*[^\r\n]+\*\*\r?\n─{10,}\r?\n\*\*1\*\* [^\r\n]+?\s+\*\*2\*\* [^\r\n]+?\s+\*\*3\*\* [^\r\n]+?\s+0 [^\r\n]+\r?\n_[^\r\n]+_\r?\n─{10,}(?:\s*([0-3]))?$/.exec(value)
  return survey ? feedback(survey[1], "legacy_survey") : undefined
}

export function parseFeedbackSubmission(value: unknown): LocalFeedback {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "score") ||
      !("score" in value) || ![0, 1, 2, 3].includes(value.score as number)) {
    throw new TypeError("Feedback requires only an integer score from 0 to 3")
  }
  return feedback(String(value.score), "feedback_api")
}

function feedback(score: string | undefined, source: LocalFeedback["source"]): LocalFeedback {
  return score === undefined ? { source, disposition: "prompt_only" }
    : score === "0" ? { source, disposition: "dismissed" }
    : { source, disposition: "rated", score: Number(score) as 1 | 2 | 3 }
}

export function feedbackAcknowledgement(value: LocalFeedback): string {
  return value.disposition === "prompt_only"
    ? "反馈不会启动任务。使用 /chaos-feedback 1、2、3 评分，或 /chaos-feedback 0 跳过。"
    : value.disposition === "dismissed" ? "已跳过反馈。"
    : "反馈已在本地记录。"
}
