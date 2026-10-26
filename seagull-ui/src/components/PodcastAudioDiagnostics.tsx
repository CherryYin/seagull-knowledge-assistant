import type { PodcastAudioFailure, PodcastAudioRender } from "@/lib/api/podcasts";

const stages: Record<string, string> = {
  task_validation: "任务校验", input_validation: "稿件校验", credential_validation: "凭据校验",
  provider_request: "服务商合成请求", provider_response: "服务商响应读取", audio_url: "音频链接校验",
  audio_download: "服务商音频下载", audio_validation: "音频格式校验", usage_validation: "计费用量校验",
  storage_upload: "本地音频存储上传", storage_download: "本地音频存储读取",
  segment_finalization: "分段记录保存", audio_assembly: "整期 MP3 合成", task_finalization: "任务结果保存",
};

const codes: Record<string, string> = {
  connect_timeout: "连接超时", read_timeout: "读取超时", write_timeout: "发送超时",
  pool_timeout: "连接池等待超时", timeout: "执行超时", http_error: "HTTP 错误",
  network_error: "网络错误", validation_error: "校验失败", local_error: "本地处理异常",
  rate_limited: "请求受限（限流或额度限制）", provider_error: "服务商拒绝请求",
};

function Failure({ value }: { value: PodcastAudioFailure }) {
  return <div className="space-y-1 text-sm" data-testid="podcast-audio-failure">
    <p>失败阶段：{stages[value.stage] || value.stage} · 类型：{codes[value.code] || value.code}（{value.code}）</p>
    <p>阶段耗时：{(value.elapsed_ms / 1000).toFixed(2)} 秒 · HTTP 状态：{value.http_status ?? "未记录"}</p>
    <p className="break-all">服务商请求 ID：{value.provider_request_id || "未取得或未记录"}</p>
    {value.exception_type && <p>异常类型：{value.exception_type}</p>}
    {value.provider_error_code && <p>服务商错误码：{value.provider_error_code}</p>}
    {value.retry_after_seconds != null && <p>服务商响应时建议等待：{value.retry_after_seconds} 秒（Retry-After，仅供核查，不是重试倒计时）</p>}
    {value.code === "rate_limited" && <p className="text-xs text-amber-700">请核查账号的请求频率、配额及其他调用。等待时间不代表可以自动重试，也不确认本次未计费；结果未知锁保持不变。</p>}
    {value.code === "network_error" && <p className="text-xs text-muted-foreground">这是网络传输异常，不能据此认定为限流或音频时长超限。</p>}
    <p className="text-xs text-muted-foreground">阶段耗时是程序等待或处理时间，不是生成音频的播放时长；超时不代表服务商未执行或未计费。</p>
  </div>;
}

export function PodcastAudioDiagnostics({ task }: { task: PodcastAudioRender }) {
  return <>
    {task.failure_details && <Failure value={task.failure_details} />}
    {(task.status === "outcome_unknown" || task.abandonment?.previous_status === "outcome_unknown") && !task.failure_details && <p className="text-xs text-muted-foreground">此任务未记录详细失败诊断，无法追溯具体阶段或确认是否超时。</p>}
    {Boolean(task.attempts?.length) && <details><summary className="cursor-pointer text-sm">分段调用诊断（{task.attempts!.length} 次）</summary>
      <div className="mt-2 space-y-3">{task.attempts!.map(attempt => <div key={attempt.id} className="space-y-1 rounded border p-3 text-xs">
        <p>第 {attempt.segment_position + 1} 段 · {attempt.status}</p>
        <p>开始：{new Date(attempt.started_at).toLocaleString()} · 结束：{attempt.completed_at ? new Date(attempt.completed_at).toLocaleString() : "未记录"}</p>
        <p className="break-all">请求 ID：{attempt.provider_request_id || "未取得或未记录"} · 服务商报告字符：{attempt.billable_characters ?? "未知"}</p>
        {attempt.failure_details ? <Failure value={attempt.failure_details} /> : attempt.error_code && <p>错误代码：{attempt.error_code}；未记录详细失败诊断。</p>}
      </div>)}</div>
    </details>}
  </>;
}
