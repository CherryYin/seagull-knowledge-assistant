import { useEffect, useRef, useState } from "react";
import { podcastsApi } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function PodcastAudioPlayer({ assetId, renderId }: { assetId: string; renderId: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      controllerRef.current?.abort();
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const close = () => {
    audioRef.current?.pause();
    audioRef.current?.removeAttribute("src");
    audioRef.current?.load();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setSource(null);
  };

  const load = async () => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true); setError("");
    try {
      const blob = await podcastsApi.audioFile(assetId, renderId, controller.signal);
      if (controller.signal.aborted) return;
      if (!blob.size) throw new Error("音频文件为空");
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setSource(url);
    } catch (reason) {
      if (!controller.signal.aborted) setError(`试听加载失败：${String(reason)}。可重新加载或下载 MP3。`);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  return <div className="space-y-2" data-testid="podcast-audio-player">
    <p className="text-xs text-muted-foreground">试听已生成的整期音频，不会重新生成或产生新的 TTS 调用。首次加载需下载完整音频。</p>
    {!source && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={loading} onClick={() => void load()}>
      {loading ? "正在加载试听…" : error ? "重新加载试听" : "加载试听"}
    </Button>{loading && <Button variant="outline" onClick={() => { controllerRef.current?.abort(); setLoading(false); }}>取消加载</Button>}</div>}
    <audio ref={audioRef} src={source || undefined} hidden={!source} controls preload="metadata" className="w-full"
      aria-label="本期成品音频播放器" data-podcast-audio="true"
      onPlay={event => document.querySelectorAll<HTMLAudioElement>("audio[data-podcast-audio]").forEach(audio => {
        if (audio !== event.currentTarget) audio.pause();
      })}
      onError={() => {
        if (!urlRef.current) return;
        close();
        setError("音频无法播放，请重新加载试听，或下载 MP3 使用本地播放器检查。");
      }}>
      浏览器不支持音频播放，请下载 MP3 试听。
    </audio>
    {source && <Button variant="outline" onClick={close}>关闭试听</Button>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
