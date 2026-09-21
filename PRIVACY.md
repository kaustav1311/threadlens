# Privacy

## Web app

- Your file is read with the browser's File API and analysed in JavaScript inside the tab. **It is never uploaded.**
- The built page (`dist/index.html`) carries a Content-Security-Policy: `default-src 'none'; connect-src 'none'; script-src` limited to hashes of the page's own scripts. The browser therefore blocks any `fetch`, XHR, WebSocket, beacon, image or font request the page might try to make.
- There are no analytics, cookies, local storage writes, fonts or CDNs. JSZip (for `.zip` and `.docx` files) is bundled inline.
- The GitHub Pages host sees a normal page request for the HTML file, like any website. It never sees your chat.
- To verify: open DevTools → Network, analyse a chat, and watch nothing leave. Or save the page and use it offline.

## Self-hosted API

- The upload is read into memory, analysed, and dropped. Nothing is written to disk, and request bodies are not logged (`--no-access-log`).
- Rate limits are held in memory, keyed by IP, and hold timestamps only.
- `deep` mode runs Hugging Face models **on your server**. The first run downloads the model weights; after that, no data leaves the machine.

## Ethics

A chat has more than one author. Before you analyse or share:

1. Analyse only conversations you are part of.
2. Use **Replace names with Person A, B…** before sharing a report or screenshot.
3. Don't publish anyone's messages without consent.
4. Remember that word counts are not diagnoses. Threadlens never labels a person, and you shouldn't either.
