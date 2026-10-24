# Youtube Clipping

Turn any YouTube link into a news-style clipping note in Obsidian: the full transcript, a category, an AI summary and key points with timestamp links, powered by Google Gemini.

## Demo

<video src="https://github.com/gospel2us-spec/youtube-clipping/raw/main/docs/demo.mp4" controls muted width="100%"></video>

[▶ Watch the demo video](docs/demo.mp4)

## Features

- 🎥 **Full transcript** fetched in the video's **original language** (English video → English, Japanese video → Japanese). Manual and auto-generated captions both work.
- 🗂️ **Automatic classification** into categories you define (default: Politics, Economy, Society, World, IT·Science, Medicine·Health, Culture·Life, Education, Other).
- 📰 **News-style clipping**: a headline written in the same language as the video title, a short lead, 5–10 key points, keywords and the people/organizations mentioned.
- ⏱️ **Timestamp links**: key points and every transcript paragraph jump to that exact moment in the video.
- 🌐 **One-click translation** of the original transcript into another language with the **Script Translation** button inside the note.
- 📝 **Ready-to-use notes**: properties (title, source, channel, category, tags, duration), thumbnail and a collapsible transcript, saved into per-category folders.
- 🔁 **Resilient**: temporary Gemini overload (503) is retried automatically, with an optional fallback model.
- 📋 **Copyable errors**: error messages stay on screen with **Copy** and **Close** buttons.

## Installation

### From Community Plugins

*Available after the plugin is approved for the Obsidian community plugin directory.*

1. Open Obsidian **Settings**.
2. Go to **Community plugins** and turn off Restricted mode.
3. Click **Browse** and search for "Youtube Clipping".
4. Click **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/gospel2us-spec/youtube-clipping/releases/latest).
2. Copy them into `<your vault>/.obsidian/plugins/youtube-clipping/`.
3. Reload Obsidian and enable **Youtube Clipping** under Community plugins.

### Beta testing with BRAT

Install the BRAT plugin, choose **Add beta plugin** and enter `https://github.com/gospel2us-spec/youtube-clipping`.

## Requirements

- Obsidian v1.14.5 or later (desktop or mobile)
- A Google Gemini API key ([get a free key here](https://aistudio.google.com/apikey))
- An internet connection (YouTube and the Gemini API are contacted when you create a clipping)

## Configuration

### Initial setup

1. Open **Settings → Youtube Clipping**.
2. Paste your **Gemini API key**.
3. (Optional) Adjust the model, save folder and category list.

That's it — the plugin is ready to create clippings.

### Settings reference

| Setting | Description | Default |
|---|---|---|
| Gemini API key | Your Google AI Studio key. Stored in the plugin's `data.json` (plain text). | — |
| Gemini model | Model used for classification and summary. | `gemini-3.8-flash` |
| Fallback model | Tried automatically if the main model keeps failing (e.g. 503 overload). Leave empty to disable. | `gemini-flash-latest` |
| Save folder | Where clippings are saved. | `YouTube Clipping` |
| Category list | Comma-separated. The last item is used when nothing fits. | 9 categories |
| Subfolder per category | Save into `<folder>/<category>/`. | On |
| Include transcript | Add the full transcript to the note. | On |
| Timestamp links | Prefix each transcript paragraph with a clickable `[mm:ss]` link. | On |
| Transcript language | **Original language** of the video, or follow the priority list below. | Original |
| Caption language priority | Used when "follow priority list" is selected, e.g. `ko, en`. | `ko, en` |
| Open note after saving | Open the new note when it is ready. | On |

## Usage

### Method 1: Ribbon icon / Command palette

1. Copy a YouTube URL.
2. Click the **newspaper icon** in the left ribbon, or open the command palette (`Ctrl/Cmd + P`) and run **Clip a YouTube link**.
3. The URL is filled in from your clipboard. Click **Create clipping**.
4. The note opens when it is finished.

### Method 2: Clip straight from the clipboard

1. Copy a YouTube URL.
2. Run **Clip the YouTube link in the clipboard** from the command palette — no dialog needed.

### Method 3: Script Translation button

Every clipping contains a **Script Translation** button right below the original transcript.

1. Choose the target language: Korean, English, Japanese, Chinese (Simplified), Spanish, French or German.
2. Click **Script Translation**.
3. A new section **Translated script (language)** is added at the bottom of the note. The original transcript and the timestamp links are kept.

Running the same language again replaces that section; other languages are added as separate sections. For notes created elsewhere, run the command **Add / move the translation box below the original script**.

<!-- SCREENSHOT (optional): Script Translation button -->

## Output Format

Each clipping is saved as `YouTube Clipping/<category>/<headline>.md` with the following structure:

````markdown
---
title: "Headline in the video's language"
source: "https://www.youtube.com/watch?v=VIDEO_ID"
channel: "Channel name"
published: 2026-01-01
clipped: 2026-10-24
category: "IT·Science"
duration: "02:56"
tags: ["youtube-clipping", "keyword1", "keyword2"]
script_lang: "en"
type: youtube-clip
---
# Headline
![](https://img.youtube.com/vi/VIDEO_ID/hqdefault.jpg)
> [!info] Category · Channel · Date
## Summary
## Key points            (each point links to its timestamp)
## People & organizations
## Full script
> [!note]- Script (collapsible, 30-second paragraphs with timestamp links)
[ Language selector ]  [ Script Translation ]
## Translated script (language)   (added by the button)
````

The headline is written in the **same language as the video title**. The summary, key points and keywords are written in Korean.

<!-- SCREENSHOT (optional): finished clipping note -->

## How it works, network use and privacy

The plugin only connects to the internet when you create a clipping or press **Script Translation**. It has no telemetry and no ads.

| Service | Purpose | What is sent |
|---|---|---|
| `youtube.com` | Read video info and captions | The video ID |
| `generativelanguage.googleapis.com` (Google Gemini API) | Classify, summarize and translate | Video title, channel, transcript text (or the video URL when there are no captions) and your API key |

Your API key is stored **in plain text** in the plugin's `data.json` inside your vault. Do not share that file or sync it to a public location.

## Limitations and troubleshooting

- **503 "high demand" from Gemini** — a temporary Google-side overload. The plugin retries three times and then tries the fallback model. If it still fails, wait a few minutes.
- **No captions** — if a video has no captions, Gemini analyses the video directly and the note contains no transcript.
- **Captions come from an unofficial YouTube endpoint** and may stop working if YouTube changes it.
- **AI summaries can contain mistakes.** Check important facts against the video.
- **Translation quality** depends on the model; very long transcripts are translated in several parts.

## Support

If this plugin helps your YouTube + Obsidian workflow, please consider giving it a star.


Starring the repository, reporting issues or sharing feedback also helps a lot.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
