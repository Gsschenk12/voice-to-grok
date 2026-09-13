# Voice to Code — Meet Captions (Chrome extension)

Free capture layer: reads Google Meet live captions from the DOM and streams them into the Voice to Code app. No ASR service, no audio key, no server.

## Load unpacked

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `extension/` (the directory that contains `manifest.json`)
5. Pin the extension so the popup status is easy to check

## Demo flow

1. Run the Next.js app (`npm run dev` → http://localhost:3000)
2. Sign in and open **Meeting setup**
3. Start a meeting in the app
4. Open (or join) a Google Meet tab in the **same Chrome profile**
5. Turn on captions (**CC**) in Meet
6. In the Voice to Code meeting page, click **Start listening**
7. Say a wake phrase (“grok make an issue” / “grok make a PR”)

## Popup status

| Badge | Meaning |
| --- | --- |
| Meet tab | A `meet.google.com` tab is registered |
| Captions | Captions region found in the Meet DOM |
| App tab | `localhost:3000` (or `127.0.0.1:3000`) tab is registered |
| Capturing | App sent `start` and Meet is observing |

## Notes

- Meet’s caption DOM is not a public API — selectors prefer `aria-label` / `aria-live`, then fall back to structural parsing.
- Captions must be visible (CC on). The extension will try to click “Turn on captions” when capture starts.
- Only works on `http://localhost:3000` and `http://127.0.0.1:3000` for this hackathon scaffold.
