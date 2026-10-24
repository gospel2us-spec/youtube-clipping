"use strict";
/*
 * Youtube Clipping
 *
 * 유튜브 주소 → 전체 스크립트(자막) 수집 → Gemini로 뉴스 클리핑처럼 분류·요약 → 볼트에 노트로 저장.
 * 자막은 유튜브 InnerTube(ANDROID 클라이언트)로 가져오고, 실패하면 영상 페이지에서 가져온다.
 * 자막이 아예 없으면 Gemini가 영상을 직접 보고 요약한다(스크립트는 없음).
 */
const obsidian = require("obsidian");
const { Plugin, Modal, Notice, Setting, PluginSettingTab, TFile, normalizePath, requestUrl } = obsidian;

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-3.8-flash",
  folder: "YouTube Clipping",
  categories: "Politics, Economy, Society, World, IT·Science, Medicine·Health, Culture·Life, Education, Other",
  subfolderByCategory: true,
  includeScript: true,
  scriptTimestamps: true,
  preferredLangs: "ko, en",
  fallbackModel: "gemini-flash-latest",
  scriptLanguage: "original", // "original" | "preferred"
  translateTarget: "Korean",
  openAfter: true,
};

const UA_WEB =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_ANDROID = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

/* ------------------------------------------------------------------ */
/* 오류 알림: 사라지지 않고, 복사·닫기 버튼 제공                          */
/* ------------------------------------------------------------------ */
function showError(message) {
  const notice = new Notice("", 0);
  const el = notice.noticeEl || notice.containerEl;
  el.empty();
  el.addClass("ytclip-error-notice");
  el.createDiv({ cls: "ytclip-error-text", text: String(message) });
  const row = el.createDiv({ cls: "ytclip-error-btns" });
  const copy = row.createEl("button", { text: "Copy" });
  copy.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(message));
      copy.setText("Copied ✓");
    } catch (err) {
      copy.setText("Copy failed");
    }
  });
  row.createEl("button", { text: "Close" }).addEventListener("click", (e) => {
    e.stopPropagation();
    notice.hide();
  });
  return notice;
}

/* ------------------------------------------------------------------ */
/* 유틸                                                                  */
/* ------------------------------------------------------------------ */
function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m;
  if ((m = /(?:youtu\.be\/|youtube\.com\/(?:shorts|embed|live|v)\/)([\w-]{11})/.exec(s))) return m[1];
  if ((m = /[?&]v=([\w-]{11})/.exec(s))) return m[1];
  if (/^[\w-]{11}$/.test(s)) return s;
  return null;
}

function decodeEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)));
}

/** 자막 XML(format 3: <p t d><s>…</s></p> 또는 구형 <text start dur>)을 [{t(초), text}]로 바꾼다 */
function parseCaptionXml(xml) {
  const out = [];
  let m;
  const reP = /<p\s[^>]*?t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = reP.exec(xml))) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (text) out.push({ t: parseInt(m[1], 10) / 1000, text });
  }
  if (out.length) return out;
  const reT = /<text\s[^>]*?start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = reT.exec(xml))) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (text) out.push({ t: parseFloat(m[1]), text });
  }
  return out;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const mi = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? h + ":" + p(mi) + ":" + p(s) : p(mi) + ":" + p(s);
}

/** 짧은 줄들을 약 windowSec초 단위의 문단으로 묶는다 */
function groupSegments(segs, windowSec) {
  const groups = [];
  let cur = null;
  for (const s of segs) {
    if (!cur || s.t - cur.t >= windowSec) {
      cur = { t: s.t, parts: [] };
      groups.push(cur);
    }
    cur.parts.push(s.text);
  }
  return groups.map((g) => ({ t: g.t, text: g.parts.join(" ").replace(/\s+/g, " ").trim() }));
}

/**
 * mode "original": 영상에서 실제로 말하는 언어(자동 생성 자막의 언어)로 스크립트를 고른다.
 *   같은 언어의 수동 자막이 있으면 그것을 우선한다.
 * mode "preferred": 설정의 언어 우선순위(예: ko, en)를 따른다.
 */
/** 기본 오디오 트랙(예: "en-US.4")에서 영상의 원어 코드("en")를 얻는다. 다국어 더빙 영상에서 정확하다 */
function originalLangOf(renderer) {
  const at = renderer && renderer.audioTracks;
  const i = renderer && renderer.defaultAudioTrackIndex;
  if (at && at.length && Number.isInteger(i) && at[i] && at[i].audioTrackId) {
    return String(at[i].audioTrackId).split(".")[0].split("-")[0].toLowerCase();
  }
  return "";
}

function pickTrack(tracks, preferred, mode, origLang) {
  if (!tracks || !tracks.length) return null;
  if (mode !== "preferred") {
    if (origLang) {
      const same = tracks.filter((t) => (t.languageCode || "").toLowerCase().split("-")[0] === origLang);
      const hit = same.find((t) => t.kind !== "asr") || same[0];
      if (hit) return hit;
    }
    const asr = tracks.find((t) => t.kind === "asr");
    if (asr) {
      const base = (asr.languageCode || "").split("-")[0].toLowerCase();
      const manual = tracks.find((t) => t.kind !== "asr" && (t.languageCode || "").toLowerCase().startsWith(base));
      return manual || asr;
    }
    return tracks[0]; // 자동 자막이 없으면 목록 맨 앞(보통 원어)
  }
  const langs = preferred.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const l of langs) {
    const manual = tracks.find((t) => (t.languageCode || "").toLowerCase().startsWith(l) && t.kind !== "asr");
    if (manual) return manual;
    const auto = tracks.find((t) => (t.languageCode || "").toLowerCase().startsWith(l));
    if (auto) return auto;
  }
  return tracks.find((t) => t.kind !== "asr") || tracks[0];
}

const safeName = (s) =>
  String(s || "Untitled").replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";

const yamlStr = (s) => JSON.stringify(String(s == null ? "" : s));

/* ------------------------------------------------------------------ */
/* 유튜브에서 정보·자막 가져오기                                           */
/* ------------------------------------------------------------------ */
async function fetchPlayerViaInnertube(videoId) {
  const res = await requestUrl({
    url: "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA_ANDROID },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "ko", gl: "KR" } },
      videoId,
    }),
    throw: false,
  });
  if (res.status !== 200) throw new Error("InnerTube response " + res.status);
  return res.json;
}

async function fetchPlayerViaWatchPage(videoId) {
  const res = await requestUrl({
    url: "https://www.youtube.com/watch?v=" + videoId + "&hl=ko",
    headers: { "User-Agent": UA_WEB, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" },
    throw: false,
  });
  if (res.status !== 200) throw new Error("Watch page response " + res.status);
  const m = /ytInitialPlayerResponse\s*=\s*({.+?});\s*(?:var|<\/script>)/s.exec(res.text);
  if (!m) throw new Error("Could not find video info");
  return JSON.parse(m[1]);
}

async function fetchVideo(videoId, preferredLangs, mode) {
  let player = null;
  let lastErr = null;
  for (const fn of [fetchPlayerViaInnertube, fetchPlayerViaWatchPage]) {
    try {
      const p = await fn(videoId);
      if (p && p.videoDetails) {
        player = p;
        const tr = p.captions && p.captions.playerCaptionsTracklistRenderer;
        if (tr && tr.captionTracks && tr.captionTracks.length) break; // 자막을 얻었으면 끝
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (!player) throw lastErr || new Error("Could not fetch video info");

  const vd = player.videoDetails || {};
  const mf = (player.microformat && player.microformat.playerMicroformatRenderer) || {};
  const info = {
    id: videoId,
    title: vd.title || "YouTube video",
    channel: vd.author || "",
    description: (vd.shortDescription || "").slice(0, 1500),
    lengthSec: parseInt(vd.lengthSeconds || "0", 10),
    published: (mf.publishDate || mf.uploadDate || "").slice(0, 10),
    url: "https://www.youtube.com/watch?v=" + videoId,
    transcript: [],
    transcriptLang: "",
    transcriptKind: "",
  };

  const tracks = player.captions && player.captions.playerCaptionsTracklistRenderer && player.captions.playerCaptionsTracklistRenderer.captionTracks;
  const renderer = player.captions && player.captions.playerCaptionsTracklistRenderer;
  const track = pickTrack(tracks, preferredLangs, mode, originalLangOf(renderer));
  if (track && track.baseUrl) {
    try {
      const cap = await requestUrl({ url: track.baseUrl, headers: { "User-Agent": UA_ANDROID }, throw: false });
      if (cap.status === 200) {
        info.transcript = parseCaptionXml(cap.text);
        info.transcriptLang = track.languageCode || "";
        info.transcriptKind = track.kind === "asr" ? "auto-generated" : "manual";
      }
    } catch (e) {
      /* 자막 없이 진행 */
    }
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* Gemini                                                                */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = [429, 500, 502, 503, 504];

/**
 * Gemini 호출. 일시적 오류(과부하 503 등)는 잠시 기다렸다 다시 시도하고,
 * 계속 실패하면 대체 모델(설정의 fallbackModel)로 한 번 더 시도한다.
 */
async function geminiPost(settings, label, onRetry, body) {
  const models = [settings.model];
  if (settings.fallbackModel && settings.fallbackModel !== settings.model) models.push(settings.fallbackModel);
  const waits = [3000, 8000, 15000]; // 모델마다 최대 3번 재시도
  let first = null;
  for (let m = 0; m < models.length; m++) {
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(models[m]) + ":generateContent?key=" + encodeURIComponent(settings.apiKey.trim());
      const res = await requestUrl({
        url, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), throw: false,
      });
      if (res.status === 200) return res;
      const msg = (res.json && res.json.error && res.json.error.message) || res.text || "unknown";
      const err = new Error(label + " (" + res.status + "): " + msg);
      if (!first) first = err;
      if (RETRYABLE.indexOf(res.status) === -1) {
        if (m === 0) throw err; // 키·요청 오류는 재시도해도 소용없음
        throw first;
      }
      if (attempt < waits.length) {
        if (onRetry) onRetry(models[m] + " is busy (" + res.status + "), retrying in " + waits[attempt] / 1000 + "s (" + (attempt + 1) + "/" + waits.length + ")…");
        await sleep(waits[attempt]);
      } else if (m + 1 < models.length) {
        if (onRetry) onRetry("Trying fallback model " + models[m + 1] + "…");
      }
    }
  }
  throw first;
}

async function callGemini(settings, info, categories, onRetry) {
  const hasScript = info.transcript.length > 0;
  const script = hasScript
    ? groupSegments(info.transcript, 30)
        .map((g) => "[" + fmtTime(g.t) + "] " + g.text)
        .join("\n")
        .slice(0, 350000)
    : "";

  const system =
    "당신은 뉴스 에디터입니다. 유튜브 영상 내용을 뉴스 클리핑 기사처럼 분류하고 요약합니다. " +
    "headline을 제외한 모든 항목은 반드시 한국어로 쓰고(headline은 영상 제목과 같은 언어), 영상에 실제로 나온 내용만 사용해 쓰고, 추측이나 없는 사실을 만들지 마세요. " +
    "숫자·이름·날짜는 영상에 나온 그대로 쓰세요.";

  const instruction =
    "아래 영상을 분석해 JSON으로만 답하세요.\n" +
    "- headline: 뉴스 제목처럼 간결하고 정보가 담긴 제목. 반드시 아래 '영상 제목'과 같은 언어로 쓰세요 (영어 제목이면 영어로, 한국어 제목이면 한국어로, 그 외 언어도 동일). 영어는 80자, 그 외는 40자 이내\n" +
    "- category: 다음 중 정확히 하나: " + categories.join(", ") + "\n" +
    "- lead: 기사 첫 문단처럼 핵심을 2~3문장으로\n" +
    "- key_points: 핵심 내용 5~10개 (각각 한 문장, 가능하면 [mm:ss] 시각 포함)\n" +
    "- keywords: 핵심 키워드/주제어 3~8개 (띄어쓰기 없는 짧은 단어)\n" +
    "- people_orgs: 영상에 등장하는 주요 인물·기관 (없으면 빈 배열)\n\n" +
    "영상 제목: " + info.title + "\n채널: " + info.channel + "\n게시일: " + info.published + "\n" +
    (hasScript ? "\n[전체 스크립트 (" + info.transcriptLang + ", " + info.transcriptKind + ")]\n" + script
               : "\n(자막이 없습니다. 첨부된 영상을 직접 보고 분석하세요.)\n설명: " + info.description);

  const parts = [{ text: instruction }];
  if (!hasScript) parts.unshift({ fileData: { fileUri: info.url } });

  const res = await geminiPost(settings, "Gemini error", onRetry, {
      contents: [{ role: "user", parts }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            headline: { type: "STRING" },
            category: { type: "STRING" },
            lead: { type: "STRING" },
            key_points: { type: "ARRAY", items: { type: "STRING" } },
            keywords: { type: "ARRAY", items: { type: "STRING" } },
            people_orgs: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["headline", "category", "lead", "key_points", "keywords"],
        },
      },
  });

  const cand = res.json && res.json.candidates && res.json.candidates[0];
  const text = cand && cand.content && cand.content.parts && cand.content.parts.map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini returned an empty response (" + ((cand && cand.finishReason) || "unknown reason") + ")");
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("Could not parse the Gemini response: " + text.slice(0, 300));
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* 번역                                                                   */
/* ------------------------------------------------------------------ */
const TRANSLATE_LANG_ID = "youtube-clipping-translate";
const TRANSLATE_BLOCK = "```" + TRANSLATE_LANG_ID + "\n```";
const TARGET_LANGS = ["Korean", "English", "Japanese", "Chinese (Simplified)", "Spanish", "French", "German"];
const SCRIPT_HEADING = "## Full script";
const TRANSLATE_BLOCK_RE = /\n*```youtube-clipping-translate\n```\n*/g;

/** 번역 선택 블록을 원문 스크립트 callout 바로 아래(번역 섹션들 앞)에 둔다. 이미 있으면 그 위치로 옮긴다. */
function placeTranslateBlock(md) {
  const text = md.replace(TRANSLATE_BLOCK_RE, "\n\n");
  const start = text.indexOf("\n" + SCRIPT_HEADING + "\n");
  if (start === -1) return null;
  const after = text.slice(start + 1);
  const nextH = after.indexOf("\n## ", SCRIPT_HEADING.length);
  const end = nextH === -1 ? text.length : start + 1 + nextH;
  const head = text.slice(0, end).replace(/\s*$/, "");
  return head + "\n\n" + TRANSLATE_BLOCK + "\n" + text.slice(end);
}

/** 노트 본문에서 원문 스크립트 callout을 [{stamp, text}]로 뽑는다 (번역 스크립트 섹션은 제외) */
function extractScript(md) {
  const start = md.indexOf("\n" + SCRIPT_HEADING + "\n");
  if (start === -1) return null;
  const after = md.slice(start + 1);
  const nextH = after.indexOf("\n## ", SCRIPT_HEADING.length);
  const section = nextH === -1 ? after : after.slice(0, nextH);
  const lines = section.split("\n");
  const head = lines.findIndex((l) => /^> \[!note\]/.test(l));
  if (head === -1) return null;
  const paras = [];
  for (let i = head + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith(">")) break;
    const body = l.replace(/^>\s?/, "");
    if (!body.trim()) continue;
    const m = /^(\[[^\]]+\]\([^)]+\))\s+([\s\S]*)$/.exec(body);
    paras.push(m ? { stamp: m[1], text: m[2] } : { stamp: "", text: body });
  }
  return paras.length ? paras : null;
}

/** 단락 목록을 Gemini로 번역한다. 긴 스크립트는 나눠서 보낸다 */
async function translateParagraphs(settings, paras, target, onProgress, onRetry) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (let i = 0; i < paras.length; i++) {
    if (cur.length && size + paras[i].text.length > 9000) { chunks.push(cur); cur = []; size = 0; }
    cur.push(i);
    size += paras[i].text.length;
  }
  if (cur.length) chunks.push(cur);

  const out = new Array(paras.length);
  for (let c = 0; c < chunks.length; c++) {
    if (onProgress) onProgress(c + 1, chunks.length);
    const idx = chunks[c];
    const prompt =
      "다음은 유튜브 영상 스크립트의 단락들입니다. 각 단락을 " + target + "(으)로 자연스럽게 번역하세요.\n" +
      "규칙: 단락 수와 순서를 그대로 유지하고, 요약하거나 빼거나 덧붙이지 마세요. 고유명사는 원어를 병기하지 않아도 됩니다. " +
      "이미 " + target + "(이)면 그대로 두세요. 번역문만 담은 JSON 문자열 배열로 답하세요.\n\n" +
      idx.map((i, k) => "[" + (k + 1) + "] " + paras[i].text).join("\n\n");
    const res = await geminiPost(settings, "Gemini translation error", onRetry, {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 16384,
          responseMimeType: "application/json",
          responseSchema: { type: "ARRAY", items: { type: "STRING" } },
        },
    });
    const cand = res.json && res.json.candidates && res.json.candidates[0];
    const text = cand && cand.content && cand.content.parts && cand.content.parts.map((p) => p.text || "").join("");
    let arr;
    try { arr = JSON.parse(text); } catch (e) { throw new Error("Could not parse the translation response: " + String(text).slice(0, 200)); }
    if (!Array.isArray(arr) || arr.length !== idx.length)
      throw new Error("The translation returned the wrong number of paragraphs (" + (Array.isArray(arr) ? arr.length : "?") + "/" + idx.length + "). Please try again.");
    idx.forEach((i, k) => (out[i] = String(arr[k]).trim()));
  }
  return out;
}

/** 번역 스크립트 섹션 마크다운 */
function buildTranslationSection(paras, translated, target) {
  let md = "## Translated script (" + target + ")\n\n";
  md += "> [!note]- Show translation (" + target + ", AI translation, " + paras.length + " paragraphs)\n";
  paras.forEach((p, i) => {
    md += "> " + (p.stamp ? p.stamp + " " : "") + translated[i] + "\n>\n";
  });
  return md + "\n";
}

/** 같은 언어의 번역 섹션이 있으면 바꾸고, 없으면 노트 끝에 붙인다 */
function upsertTranslation(md, section, target) {
  const heading = "## Translated script (" + target + ")";
  const at = md.indexOf("\n" + heading + "\n");
  if (at === -1) return md.replace(/\s*$/, "\n\n") + section;
  const rest = md.slice(at + 1 + heading.length);
  const next = rest.indexOf("\n## ");
  const tail = next === -1 ? "" : rest.slice(next + 1);
  return md.slice(0, at + 1) + section + tail;
}

/* ------------------------------------------------------------------ */
/* 노트 만들기                                                            */
/* ------------------------------------------------------------------ */
function buildNote(info, ai, category, settings) {
  const tags = (ai.keywords || [])
    .map((k) => String(k).replace(/[\s#]+/g, "").replace(/[^\p{L}\p{N}_\-/]/gu, ""))
    .filter(Boolean);
  const fm = [
    "---",
    "title: " + yamlStr(ai.headline || info.title),
    "source: " + yamlStr(info.url),
    "channel: " + yamlStr(info.channel),
    "published: " + (info.published || ""),
    "clipped: " + new Date().toISOString().slice(0, 10),
    "category: " + yamlStr(category),
    "duration: " + yamlStr(info.lengthSec ? fmtTime(info.lengthSec) : ""),
    "tags: [" + ["youtube-clipping", ...tags].map(yamlStr).join(", ") + "]",
    "script_lang: " + yamlStr(info.transcriptLang || ""),
    "type: youtube-clip",
    "---",
    "",
  ].join("\n");

  let md = fm;
  md += "# " + (ai.headline || info.title) + "\n\n";
  md += "![](https://img.youtube.com/vi/" + info.id + "/hqdefault.jpg)\n\n";
  md += "> [!info] " + category + " · " + (info.channel || "Unknown channel") + (info.published ? " · " + info.published : "") + "\n";
  md += "> Source: [" + info.title.replace(/[\[\]]/g, "") + "](" + info.url + ")\n\n";
  md += "## Summary\n\n" + (ai.lead || "").trim() + "\n\n";

  if (ai.key_points && ai.key_points.length) {
    md += "## Key points\n\n";
    for (const p of ai.key_points) {
      // [mm:ss] 또는 [h:mm:ss]를 영상 시각 링크로 바꾼다
      const linked = String(p).replace(/\[(\d{1,2}:)?(\d{1,2}):(\d{2})\]/g, (_m, h, mm, ss) => {
        const sec = (h ? parseInt(h, 10) * 3600 : 0) + parseInt(mm, 10) * 60 + parseInt(ss, 10);
        return "[" + (h || "") + mm + ":" + ss + "](" + info.url + "&t=" + sec + "s)";
      });
      md += "- " + linked.trim() + "\n";
    }
    md += "\n";
  }

  if (ai.people_orgs && ai.people_orgs.length) {
    md += "## People & organizations\n\n" + ai.people_orgs.map((s) => "- " + s).join("\n") + "\n\n";
  }

  if (settings.includeScript) {
    if (info.transcript.length) {
      const groups = groupSegments(info.transcript, 30);
      md += "## Full script\n\n";
      md += "> [!note]- Show script (" + info.transcriptLang + ", " + info.transcriptKind + ", " + groups.length + " paragraphs)\n";
      for (const g of groups) {
        const stamp = settings.scriptTimestamps
          ? "[" + fmtTime(g.t) + "](" + info.url + "&t=" + Math.floor(g.t) + "s) "
          : "";
        md += "> " + stamp + g.text + "\n>\n";
      }
      md += "\n" + TRANSLATE_BLOCK + "\n\n";
    } else {
      md += "## Full script\n\nNo captions were found, so the AI analyzed the video directly. There is no transcript.\n\n";
    }
  }
  return md;
}

/* ------------------------------------------------------------------ */
/* 플러그인                                                               */
/* ------------------------------------------------------------------ */
class YoutubeClippingPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.addRibbonIcon("newspaper", "Youtube Clipping", () => this.openModal());
    this.addCommand({ id: "clip-youtube", name: "Clip a YouTube link", callback: () => this.openModal() });
    this.addCommand({
      id: "clip-from-clipboard",
      name: "Clip the YouTube link in the clipboard",
      callback: async () => {
        let text = "";
        try { text = await navigator.clipboard.readText(); } catch (e) { /* 무시 */ }
        const id = extractVideoId(text);
        if (!id) return showError("There is no YouTube link in the clipboard.");
        await this.clip(text);
      },
    });
    this.addCommand({
      id: "add-translate-button",
      name: "Add / move the translation box below the original script",
      editorCallback: (editor) => {
        const placed = placeTranslateBlock(editor.getValue());
        if (!placed) return showError("Run this in a clipping note that has a '## Full script' section.");
        editor.setValue(placed);
        new Notice("The translation box is now below the original script.");
      },
    });

    // 노트 안의 ```youtube-clipping-translate 블록을 [언어 선택 + 번역 버튼]으로 보여 준다
    this.registerMarkdownCodeBlockProcessor(TRANSLATE_LANG_ID, (_source, el, ctx) => {
      const box = el.createDiv({ cls: "ytclip-translate" });
      const select = box.createEl("select");
      for (const l of TARGET_LANGS) select.createEl("option", { text: l, value: l });
      select.value = (TARGET_LANGS.includes(this.settings.translateTarget) ? this.settings.translateTarget : "Korean");
      select.addEventListener("change", async () => {
        this.settings.translateTarget = select.value;
        await this.saveSettings();
      });
      const btn = box.createEl("button", { text: "Script Translation", cls: "mod-cta" });
      box.createSpan({
        cls: "ytclip-translate-desc",
        text: "To translate the original text into another language, select the language and click.",
      });
      const status = box.createDiv({ cls: "ytclip-translate-status" });
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await this.translateNote(ctx.sourcePath, select.value, (m) => status.setText(m));
          status.setText("Done: a translated script section (" + select.value + ") was added at the bottom of the note.");
        } catch (e) {
          console.error("[youtube-clipping]", e);
          status.setText("Failed");
          showError("Translation failed: " + (e && e.message ? e.message : e));
        } finally {
          btn.disabled = false;
        }
      });
    });

    this.addSettingTab(new YoutubeClippingSettingTab(this.app, this));
  }

  async translateNote(path, target, onStatus) {
    const s = this.settings;
    if (!s.apiKey) throw new Error("No Gemini API key. Enter it in the plugin settings.");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("Note not found: " + path);
    const md = await this.app.vault.read(file);
    const paras = extractScript(md);
    if (!paras) throw new Error("Could not find the original script in this note.");
    const translated = await translateParagraphs(s, paras, target, (i, n) => onStatus("Translating… " + i + " / " + n), onStatus);
    const section = buildTranslationSection(paras, translated, target);
    await this.app.vault.process(file, (cur) => upsertTranslation(cur, section, target));
  }

  async saveSettings() { await this.saveData(this.settings); }

  openModal() { new ClipModal(this.app, this).open(); }

  async clip(input, onStatus) {
    const status = onStatus || (() => {});
    const s = this.settings;
    const videoId = extractVideoId(input);
    if (!videoId) throw new Error("Not a valid YouTube link: " + input);
    if (!s.apiKey) throw new Error("No Gemini API key. Enter it in Settings → Youtube Clipping.");

    status("Fetching video info and transcript…");
    const info = await fetchVideo(videoId, s.preferredLangs, s.scriptLanguage);
    status(
      info.transcript.length
        ? "Got " + info.transcript.length + " transcript lines (" + info.transcriptLang + "). Classifying and summarizing with Gemini…"
        : "No captions found. Gemini will analyze the video directly…"
    );

    const categories = s.categories.split(",").map((c) => c.trim()).filter(Boolean);
    const ai = await callGemini(s, info, categories, status);
    const category = categories.includes(ai.category) ? ai.category : categories[categories.length - 1] || "Other";

    status("Saving note…");
    const md = buildNote(info, ai, category, s);
    const dir = normalizePath(s.folder + (s.subfolderByCategory ? "/" + category : ""));
    await this.ensureFolder(dir);
    const base = safeName(ai.headline || info.title);
    let path = normalizePath(dir + "/" + base + ".md");
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(dir + "/" + base + " (" + ++n + ").md");
    const file = await this.app.vault.create(path, md);
    if (s.openAfter) await this.app.workspace.getLeaf(false).openFile(file);
    new Notice("Clipping saved: " + file.path, 6000);
    return file;
  }

  async ensureFolder(dir) {
    const parts = dir.split("/");
    let cur = "";
    for (const p of parts) {
      cur = cur ? cur + "/" + p : p;
      if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.createFolder(cur);
    }
  }
}

class ClipModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.busy = false;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ytclip-modal");
    contentEl.createEl("h2", { text: "Youtube Clipping" });
    contentEl.createEl("p", { text: "Paste a YouTube link to fetch the full transcript and create a classified, summarized note." });

    let url = "";
    let input;
    new Setting(contentEl).setName("YouTube link").addText((t) => {
      input = t;
      t.setPlaceholder("https://www.youtube.com/watch?v=…").onChange((v) => (url = v));
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    });
    try {
      const clip = await navigator.clipboard.readText();
      if (extractVideoId(clip)) { url = clip.trim(); input.setValue(url); }
    } catch (e) { /* 클립보드 권한 없음 */ }

    const statusEl = contentEl.createDiv({ cls: "ytclip-status" });
    const run = async () => {
      if (this.busy) return;
      if (!extractVideoId(url)) { statusEl.setText("Not a valid YouTube link."); return; }
      this.busy = true;
      try {
        await this.plugin.clip(url, (m) => statusEl.setText(m));
        this.close();
      } catch (e) {
        console.error("[youtube-clipping]", e);
        statusEl.setText("Failed");
        showError("Clipping failed: " + (e && e.message ? e.message : e));
      } finally {
        this.busy = false;
      }
    };
    new Setting(contentEl).addButton((b) => b.setButtonText("Create clipping").setCta().onClick(run));
    input.inputEl.focus();
  }

  onClose() { this.contentEl.empty(); }
}

class YoutubeClippingSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl).setName("Gemini API key").setDesc("Key from Google AI Studio. Stored only in this vault (plugin data.json, plain text).")
      .addText((t) => { t.setValue(s.apiKey).onChange(async (v) => { s.apiKey = v.trim(); await save(); }); t.inputEl.type = "password"; });

    new Setting(containerEl).setName("Gemini model").setDesc("For example: gemini-3.8-flash")
      .addText((t) => t.setValue(s.model).onChange(async (v) => { s.model = v.trim() || DEFAULT_SETTINGS.model; await save(); }));

    new Setting(containerEl).setName("Fallback model").setDesc("Tried if the main model keeps failing (e.g. 503 overload). Leave empty to disable.")
      .addText((t) => t.setValue(s.fallbackModel).onChange(async (v) => { s.fallbackModel = v.trim(); await save(); }));

    new Setting(containerEl).setName("Save folder")
      .addText((t) => t.setValue(s.folder).onChange(async (v) => { s.folder = v.trim() || DEFAULT_SETTINGS.folder; await save(); }));

    new Setting(containerEl).setName("Category list").setDesc("Comma-separated. The last item is used when nothing else fits.")
      .addTextArea((t) => t.setValue(s.categories).onChange(async (v) => { s.categories = v; await save(); }));

    new Setting(containerEl).setName("Subfolder per category")
      .addToggle((t) => t.setValue(s.subfolderByCategory).onChange(async (v) => { s.subfolderByCategory = v; await save(); }));

    new Setting(containerEl).setName("Include transcript")
      .addToggle((t) => t.setValue(s.includeScript).onChange(async (v) => { s.includeScript = v; await save(); }));

    new Setting(containerEl).setName("Timestamp links").setDesc("Prefix each transcript paragraph with a clickable [mm:ss] link.")
      .addToggle((t) => t.setValue(s.scriptTimestamps).onChange(async (v) => { s.scriptTimestamps = v; await save(); }));

    new Setting(containerEl).setName("Transcript language").setDesc("Original: use the captions in the language actually spoken in the video. Priority list: follow the order below.")
      .addDropdown((d) =>
        d.addOption("original", "Original language of the video")
          .addOption("preferred", "Follow the language priority below")
          .setValue(s.scriptLanguage)
          .onChange(async (v) => { s.scriptLanguage = v; await save(); })
      );

    new Setting(containerEl).setName("Caption language priority").setDesc("Comma-separated, e.g. ko, en")
      .addText((t) => t.setValue(s.preferredLangs).onChange(async (v) => { s.preferredLangs = v.trim() || "ko, en"; await save(); }));

    new Setting(containerEl).setName("Open note after saving")
      .addToggle((t) => t.setValue(s.openAfter).onChange(async (v) => { s.openAfter = v; await save(); }));
  }
}

module.exports = YoutubeClippingPlugin;
