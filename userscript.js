// ==UserScript==
// @name          LibreGRAB
// @namespace     http://tampermonkey.net/
// @version       2026-11-12.5
// @description   Download all the booty!
// @author        PsychedelicPalimpsest
// @license       MIT
// @supportURL    https://github.com/PsychedelicPalimpsest/LibbyRip/issues
// @match         *://*.listen.libbyapp.com/*
// @match         *://*.listen.overdrive.com/*
// @match         *://*.read.libbyapp.com/?*
// @match         *://*.read.overdrive.com/?*
// @run-at        document-start
// @icon          https://www.google.com/s2/favicons?sz=64&domain=libbyapp.com
// @grant         none
// @downloadURL https://raw.githubusercontent.com/michealespinola/LibbyRip/main/userscript.js
// @updateURL   https://raw.githubusercontent.com/michealespinola/LibbyRip/main/userscript.js
// ==/UserScript==

/* =========================================
   CHANGE 00 | 2026-11-12 | UPDATE SUMMARY AND MODIFICATION INDEX
   Baseline: LibreGRAB_original.js, version 2026-10-30.
   Current: 2026-11-12.5.

   2026-11-12.5: Resolve audio URLs before building preview controls,
   refresh them on reopening, and distinguish audio parts from chapters.
   Normalize part indices and captured URL keys; show playback errors.

   2026-11-12.4: ESLint pass. Remove obsolete URL collectors,
   unused variables/helpers and unused catch/callback parameters.
   Replace control-character regex matching with character-code checks
   while preserving Windows-safe filenames. No export-flow redesign.

   2026-11-12.3: Use browser downloads for ZIP and EPUB without a script
   save picker. Name both archives "Author - Title.ext", sanitize Windows
   filename characters, and provide missing-author/title defaults.
   Chrome's download settings still control destination and prompts.

   2026-11-12.2: Collect audiobook URLs from resource entries and assigned
   media sources, including detached audio elements. Observe new entries,
   retry missing parts up to three times with elapsed-time deadlines,
   report incomplete collection, and restore the playback position.

   2026-11-12.1: Add a hidden-tab ebook fallback for complete, healthy
   chapters waiting on fonts.ready. Allow 180 seconds without loading
   stage progress while hidden, or 30 seconds while visible. Invalidate
   pending reader work before releasing a fallback-captured frame.

   2026-11-11.3-.4: Capture loaded chapter frames without callback
   replacement, DevTools, or Local Overrides. Preserve captured base URLs
   and stylesheet references. Accept data-document-status="ok".

   Earlier compatibility changes: sequential chapter loading, private
   state/ZIP initialization, per-load UI names, audio-only JSON capture,
   fixed-page image/text-overlay styling, EPUB 3 metadata/navigation,
   complete language codes, and visible export errors.

   01 Version/update policy       11 EPUB navigation document
   02 Private ZIP loader          12 Ebook initialization
   03 Audio-only JSON capture     13 Visible export errors
   04 Archive status label        14 Per-load UI identifiers
   05 Private chapter storage     15 Standalone frame capture
   06 Sequential chapter loading  16 Successful document status
   07 Captured page resources     17 Background chapter loading
   08 Image-backed page styling   18 Background audio URL collection
   09 EPUB 3 package metadata     19 Automatic saves/archive filenames
   10 Language metadata handling  20 Lint cleanup
   21 Audio part preview controls

   LIMITS: Detector hashes remain a snapshot, not live discovery.
   Browser freezing/discard can still interrupt work. Background audio
   has passed initial user testing; background ebook verification remains
   pending. Blob archive downloads can use more memory than streaming.

   RETAINED: Author/license, MP3 and audiobook ZIP options, metadata/cover
   export and FFmpeg processing. Automatic updates use this GitHub fork.
   END CHANGE 00
   ========================================= */
// @author        michealespinola
// @supportURL    https://github.com/michealespinola/LibbyRip/issues

(function () {
    function mainCode(privateNames) {

    // Since the ffmpeg.js file is 50mb, it slows the page down too much
    // to be in a "require" attribute, so we load it in async
    function addFFmpegJs(){
        let scriptTag = document.createElement("script");
        scriptTag.setAttribute("type", "text/javascript");
        scriptTag.setAttribute("src", "https://github.com/PsychedelicPalimpsest/FFmpeg-js/releases/download/14/0.12.5.bundle.js");
        document.body.appendChild(scriptTag);

        return new Promise(accept =>{
            let i = setInterval(()=>{
                if (window.createFFmpeg){
                    clearInterval(i);
                    accept(window.createFFmpeg);
                }
            }, 50)
            });
    }

    let downloadElem;
    let BIF;
    /* =========================================
       CHANGE 02 | 2026-11-11 | PRIVATE ZIP INITIALIZATION
       Before: ZIP state and named resolver functions were on window.
       Now: Cache the promise/function privately; use one random temporary
       window callback to receive the library, then remove that callback.
       The library is wrapped so downloadZip also stays private.
       Added: HTTP checks, function validation, a 30-second timeout,
       script-error handling, cleanup, and retry after a failed load.
       Retained: client-zip 2.5.0 and lazy loading on first export.
       Limit: Inline script execution still depends on page CSP.
       END CHANGE 02
       ========================================= */
    let zipPromise;
    async function getDownloadZip() {
        if (zipPromise) return zipPromise;
        zipPromise = new Promise((resolve, reject) => {
            const bridge = privateNames.zipBridge;
            let timer;
            let finished = false;
            const finish = (error, zipFunction) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                delete window[bridge];
                if (error) reject(error);
                else resolve(zipFunction);
            };
            Object.defineProperty(window, bridge, {
                configurable: true,
                value: (zipFunction) => {
                    if (typeof zipFunction !== 'function') {
                        finish(new Error('ZIP library did not initialize'));
                    } else finish(null, zipFunction);
                }
            });
            timer = setTimeout(() => finish(new Error(
                'ZIP library did not load within 30 seconds; check Console for CSP errors'
            )), 30000);
            fetch('https://unpkg.com/client-zip@2.5.0/worker.js')
                .then(response => {
                    if (!response.ok) throw new Error(`ZIP library HTTP ${response.status}`);
                    return response.text();
                })
                .then(code => {
                    if (finished) return;
                    const tag = document.createElement('script');
                    tag.textContent = '(function(){' + code + '\n;window[' + JSON.stringify(bridge) + '](downloadZip);})();';
                    tag.onerror = () => finish(new Error('ZIP library script was blocked'));
                    (document.head || document.documentElement).appendChild(tag);
                    tag.remove();
                })
                .catch(error => finish(error));
        });
        try { return await zipPromise; }
        catch (error) { zipPromise = undefined; throw error; }
    }
    const CSS = `
    .pNav{
        background-color: red;
        width: 100%;
        display: flex;
        justify-content: space-between;
    }
    .pLink{
        color: blue;
        text-decoration-line: underline;
        padding: .25em;
        font-size: 1em;
    }
    .foldMenu{
        position: absolute;
        width: 100%;
        height: 0%;
        z-index: 1000;

        background-color: grey;
        color: white;

        overflow-x: hidden;
        overflow-y: scroll;

        transition: height 0.3s
    }
    .active{
        height: 40%;
        border: double;
    }
    .pChapLabel{
        font-size: 2em;
    }`;
    /* =========================================
              BEGIN AUDIOBOOK SECTION!
       =========================================
    */


    // Libby, somewhere, gets the crypto stuff we need for mp3 urls, then removes it before adding it to the BIF.
    // here, we simply hook json parse to get it for us!

    /* =========================================
       CHANGE 03 | 2026-11-11 | LIMIT JSON CAPTURE TO AUDIO
       Before: JSON.parse was replaced on every matching page; parsing
       null could throw when the wrapper accessed ret["b"].
       Now: Install the wrapper only on .listen. hosts, check for null,
       and call the original parser with Reflect.apply.
       Ebook pages keep their native JSON.parse. Audio still wraps it.
       END CHANGE 03
       ========================================= */
    let odreadCmptParams = null;
    // Audio bootstrap capture is unnecessary on ebook pages.
    if (location.hostname.includes('.listen.')) {
        const oldParse = JSON.parse;
        JSON.parse = function(...args) {
            const result = Reflect.apply(oldParse, this, args);
            if (result && typeof result === 'object' &&
                result.b && result.b['-odread-cmpt-params'] != null) {
                odreadCmptParams = Array.from(result.b['-odread-cmpt-params']);
            }
            return result;
        };
    }

    // OverDrive stopped sending -odread-cmpt-params (upstream issue #82), so
    // chapter URLs built from it end in "?undefined" and fetch as 502s. The
    // player itself still requests working URLs, so record the media URLs it
    // requests and prefer those when building chapter URLs. Capture can never
    // break playback: every step is guarded.
    let capturedPlayerUrls = new Map();
    function partKeyFromUrl(u){
        try { return decodeURIComponent(new URL(u, location.href).pathname.split("/").pop()); }
        catch { return null; }
    }
    const audioBookNav = `
        <a class="pLink" id="chap"> <h1> View chapters </h1> </a>
        <a class="pLink" id="down"> <h1> Export as MP3 </h1> </a>
        <a class="pLink" id="exp"> <h1> Export audiobook </h1> </a>
    `;
    const chaptersMenu = `
        <h2>This book contains {CHAPTERS} audio parts.</h2>
        <button class="shibui-button" style="background-color: white" id="dumpAll"> Download all </button><br>
    `;
    let chapterMenuElem;
    let libreShadowHost = null;
    let libreShadowRoot = null;

    function buildPirateUi(){
        // Create the nav
        let nav = document.createElement("div");
        nav.innerHTML = audioBookNav;
        nav.querySelector("#chap").onclick = viewChapters;
        nav.querySelector("#down").onclick = exportMP3;
        nav.querySelector("#exp").onclick = exportChapters;
        nav.classList.add("pNav");
        let pbar = document.querySelector(".nav-progress-bar");
        pbar.insertBefore(libreShadowHost, pbar.children[1]);
        libreShadowRoot.appendChild(nav);

        // Create the chapters menu
        chapterMenuElem = document.createElement("div");
        chapterMenuElem.classList.add("foldMenu");
        chapterMenuElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
        const urls = getUrls();

        chapterMenuElem.innerHTML = chaptersMenu.replace("{CHAPTERS}", urls.length);
        libreShadowRoot.appendChild(chapterMenuElem);

        downloadElem = document.createElement("div");
        downloadElem.classList.add("foldMenu");
        downloadElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
        libreShadowRoot.appendChild(downloadElem);
    }
    function getUrls(){
        let ret = [];
        for (const [position, spine] of BIF.objects.spool.components.entries()){
            const partFile = partKeyFromUrl(spine.meta.path);
            const captured = partFile ? capturedPlayerUrls.get(partFile) : null;
            const rawIndex = spine.meta["-odread-spine-position"];
            const numericIndex = Number(rawIndex);
            const index = rawIndex != null && rawIndex !== "" &&
                Number.isInteger(numericIndex) && numericIndex >= 0
                ? numericIndex : position;
            let data = {

                url: captured || location.origin + "/" + spine.meta.path + "?" + (odreadCmptParams || [])[spine.spinePosition],
                index,
                duration: spine.meta["audio-duration"],
                size: spine.meta["-odread-file-bytes"],
                type: spine.meta["media-type"]
            };
            ret.push(data);
        }
        return ret;
    }
    function paddy(num, padlen, padchar) {
        var pad_char = typeof padchar !== 'undefined' ? padchar : '0';
        var pad = new Array(1 + padlen).join(pad_char);
        return (pad + num).slice(-pad.length);
    }
    // CHANGE 21: Resolve current URLs before creating playable audio rows.
    // These are source-file parts, not the publisher's chapter boundaries.
    async function viewChapters() {
        if (chapterMenuElem.classList.contains("active")) {
            chapterMenuElem.classList.remove("active");
            chapterMenuElem.querySelectorAll("audio").forEach(audio => audio.pause());
            return;
        }
        if (downloadState !== -1) return;
        downloadState = 0;
        chapterMenuElem.classList.add("active");
        chapterMenuElem.replaceChildren();
        const message = document.createElement("p");
        message.textContent = "Resolving audio part URLs...";
        chapterMenuElem.appendChild(message);
        try {
            const urls = await ensurePlayerUrls(getUrls());
            chapterMenuElem.innerHTML = chaptersMenu.replace("{CHAPTERS}", urls.length);
            const note = document.createElement("p");
            note.textContent = "Audio parts may contain multiple chapters.";
            chapterMenuElem.appendChild(note);
            for (const part of urls) {
                const label = document.createElement("div");
                label.classList.add("pChapLabel");
                label.textContent = "Part " + (part.index + 1);
                chapterMenuElem.appendChild(label);
                const status = document.createElement("div");
                if (!hasWorkingUrl(part)) {
                    status.textContent = "Audio URL unavailable. Close and reopen this panel to retry.";
                    chapterMenuElem.appendChild(status);
                    continue;
                }
                const audio = document.createElement("audio");
                audio.controls = true;
                audio.preload = "metadata";
                audio.addEventListener("loadedmetadata", () => {
                    const seconds = Math.floor(audio.duration);
                    if (Number.isFinite(seconds) && seconds >= 0) {
                        const hours = Math.floor(seconds / 3600);
                        const minutes = Math.floor(seconds % 3600 / 60);
                        const duration = (hours ? hours + ":" + paddy(minutes, 2)
                            : String(minutes)) + ":" + paddy(seconds % 60, 2);
                        label.textContent = "Part " + (part.index + 1) + " (" + duration + ")";
                    }
                    status.textContent = "";
                });
                audio.addEventListener("error", () => {
                    status.textContent = "Playback failed (media error " +
                        (audio.error?.code || "unknown") +
                        "). Close and reopen this panel to refresh its URL.";
                });
                // Let the browser inspect the actual media instead of relying
                // on potentially missing or stale metadata MIME declarations.
                audio.src = part.url;
                chapterMenuElem.appendChild(audio);
                chapterMenuElem.appendChild(status);
            }
            const button = chapterMenuElem.querySelector("#dumpAll");
            button.onclick = async () => {
                if (downloadState !== -1) return;
                downloadState = 0;
                button.disabled = true;
                const result = document.createElement("p");
                chapterMenuElem.appendChild(result);
                try {
                    const current = await ensurePlayerUrls(getUrls());
                    if (current.some(part => !hasWorkingUrl(part))) {
                        throw new Error("Some audio URLs are unavailable. Reopen the panel to retry.");
                    }
                    await Promise.all(current.map(async part => {
                        const response = await fetch(part.url);
                        if (!response.ok) throw new Error(
                            `Part ${part.index + 1}: HTTP ${response.status}`);
                        const objectUrl = URL.createObjectURL(await response.blob());
                        const link = document.createElement("a");
                        link.href = objectUrl;
                        link.download = `${getAuthorString()} - ${BIF.map.title.main}.${part.index}.mp3`;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                    }));
                    result.textContent = "Downloads sent to browser.";
                } catch (error) {
                    result.textContent = error.message || String(error);
                } finally {
                    button.disabled = false;
                    downloadState = -1;
                }
            };
        } catch (error) {
            chapterMenuElem.replaceChildren(message);
            message.textContent = error.message || String(error);
        } finally {
            downloadState = -1;
        }
    }
    function getAuthorString(){
        return (Array.isArray(BIF.map.creator) ? BIF.map.creator : [])
            .filter(creator => creator && creator.role === "author" && creator.name)
            .map(creator => creator.name).join(", ");
    }

    // CHANGE 19: Use one Windows-safe archive filename convention.
    function getArchiveFilename(extension) {
        const author = getAuthorString().trim() || "Unknown author";
        const title = String(BIF.map.title?.main || "Untitled").trim() || "Untitled";
        const name = Array.from(author + " - " + title, character =>
            character.charCodeAt(0) < 32 ? "_" : character).join("")
            .replace(/[<>:"/\\|?*]/g, "_")
            .replace(/[. ]+$/, "");
        return name + "." + extension;
    }

    function getMetadata(){
        let spineToIndex = BIF.map.spine.map((x)=>x["-odread-original-path"]);
        let metadata = {
            title: BIF.map.title.main,
            description: BIF.map.description,
            coverUrl: BIF.root.querySelector("image").getAttribute("href"),
            creator: BIF.map.creator,
            spine: BIF.map.spine.map((x)=>{return {
                duration: x["audio-duration"],
                type: x["media-type"],
                bitrate: x["audio-bitrate"],
            }})
        };
        if (BIF.map.nav.toc != undefined){
            metadata.chapters = BIF.map.nav.toc.map((rChap)=>{
                return {
                    title: rChap.title,
                    spine: spineToIndex.indexOf(rChap.path.split("#")[0]),
                    offset: 1*(rChap.path.split("#")[1] | 0)
                };
            });
        }
        return metadata;

    }

    async function createMetadata(){
        let metadata = getMetadata();
        const response = await fetch(metadata.coverUrl);
        const blob = await response.blob();
        const csplit = metadata.coverUrl.split(".");
        return [
            {
                name: "metadata/cover." + csplit[csplit.length-1],
                input: blob
            },
            {
                name: "metadata/metadata.json",
                input: JSON.stringify(metadata, null, 2)
            }
        ];
    }
    function generateTOCFFmpeg(metadata){
        if (!metadata.chapters) return null;
        let lastTitle = null;

        const duration = Math.round(BIF.map.spine.map((x)=>x["audio-duration"]).reduce((acc, val) => acc + val)) * 1000000000;

        let toc = ";FFMETADATA1\n\n";

        // Get the offset for each spine element
        let temp = 0;
        const spineSpecificOffset = BIF.map.spine.map((x)=>{
            let old = temp;
            temp += x["audio-duration"]*1;
            return old;
        });

        // Libby chapter split over many mp3s have duplicate chapters, so we must filter them
        // then convert them to be in [title, start_in_nanosecs]
        let chapters = metadata.chapters.filter((x)=>{
            let ret = x.title !== lastTitle;
            lastTitle = x.title;
            return ret;
        }).map((x)=>[
            // Escape the title
            x.title.replaceAll("\\", "\\\\").replaceAll("#", "\\#").replaceAll(";", "\\;").replaceAll("=", "\\=").replaceAll("\n", ""),
            // Calculate absolute offset in nanoseconds
            Math.round(spineSpecificOffset[x.spine] + x.offset) * 1000000000
        ]);

        // Transform chapter to be [title, start_in_nanosecs, end_in_nanosecounds]
        let last = duration;
        for (let i = chapters.length - 1; -1 != i; i--){
            chapters[i].push(last);
            last = chapters[i][1];
        }

        chapters.forEach((x)=>{
            toc += "[CHAPTER]\n";
            toc += `START=${x[1]}\n`;
            toc += `END=${x[2]}\n`;
            toc += `title=${x[0]}\n`;
        });

        return toc;
    }

    let downloadState = -1;
    let ffmpeg = null;
    async function createAndDownloadMp3(urls){
        await initFFmpeg();
        let metadata = getMetadata();
        downloadElem.innerHTML += "Downloading mp3 files <br>";
        await ffmpeg.writeFile("chapters.txt", generateTOCFFmpeg(metadata));


        let fetchPromises = urls.map(async (url) => {
            // Download the mp3
            const response = await fetch(url.url);
            const blob = await response.blob();

            // Dump it into ffmpeg (We do the request here as not to bog down the worker thread)
            const blob_url = URL.createObjectURL(blob);
            await ffmpeg.writeFileFromUrl((url.index + 1) + ".mp3", blob_url);
            URL.revokeObjectURL(blob_url);


            downloadElem.innerHTML += `Download of disk ${url.index + 1} complete! <br>`
            downloadElem.scrollTo(0, downloadElem.scrollHeight);
        });

        let coverName = null;

        if (metadata.coverUrl){
            console.log(metadata.coverUrl);
            const csplit = metadata.coverUrl.split(".");
            const response = await fetch(metadata.coverUrl);
            const blob = await response.blob();

            coverName = "cover." + csplit[csplit.length-1];

            const blob_url = URL.createObjectURL(blob);
            await ffmpeg.writeFileFromUrl(coverName, blob_url);
            URL.revokeObjectURL(blob_url);
        }


        await Promise.all(fetchPromises);

        downloadElem.innerHTML += `<br><b>Downloads complete!</b> Now combining them together! (This might take a <b><i>minute</i></b>) <br> Transcode progress: <span id="mp3Progress">0</span> hours in to audiobook<br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        let files = "";

        for (let i = 0; i < urls.length; i++){
            files += `file '${i+1}.mp3'\n`
        }
        await ffmpeg.writeFile("files.txt", files);

        ffmpeg.setProgress((progress)=>{
            // The progress.time feature seems to be in micro secounds
            downloadElem.querySelector("#mp3Progress").textContent = (progress.time / 1000000 / 3600).toFixed(2);
        });
        ffmpeg.setLogger(console.log);

        await ffmpeg.exec([
                           "-y", "-f", "concat",
                           "-i", "files.txt",
                           "-i", "chapters.txt"]
                          .concat(coverName ? ["-i", coverName] : [])
                          .concat([
                            "-map_metadata", "1",
                            "-codec", "copy",
                            "-map", "0:a",
                            "-metadata", `title=${metadata.title}`,
                            "-metadata", `album=${metadata.title}`,
                            "-metadata", `artist=${getAuthorString()}`,
                            "-metadata", `encoded_by=LibbyRip/LibreGRAB`,
                            "-c:a", "copy"])
                          .concat(coverName ? [
                            "-map", "2:v",
                            "-metadata:s:v", "title=Album cover",
                            "-metadata:s:v", "comment=Cover (front)"]
                            : [])
                            .concat(["out.mp3"]));



        let blob_url = await ffmpeg.readFileToUrl("out.mp3");

        const link = document.createElement('a');
        link.href = blob_url;

        link.download = getAuthorString() + ' - ' + BIF.map.title.main + '.mp3';
        document.body.appendChild(link);
        link.click();
        link.remove();

        downloadState = -1;
        downloadElem.innerHTML = ""
        downloadElem.classList.remove("active");

        // Clean up the object URL
        setTimeout(() => URL.revokeObjectURL(blob_url), 100);

    }

    let ffmpegInitPromise = null;

    async function initFFmpeg() {
        console.log("initFFmpeg");
        if (ffmpegInitPromise) return ffmpegInitPromise;
        ffmpegInitPromise = (async () => {
            if (!window.createFFmpeg) {
                downloadElem.innerHTML += "Downloading FFmpeg.wasm (~50MB)<br>";
                console.log("Downloading FFmpeg.wasm (~50MB)");
                await addFFmpegJs();
                downloadElem.innerHTML += "Completed FFmpeg.wasm download<br>";
                console.log("Completed FFmpeg.wasm download");
            }

            // Initialize FFmpeg if not already done
            if (!ffmpeg) {
                downloadElem.innerHTML += "Initializing FFmpeg.wasm<br>";
                console.log("Initializing FFmpeg.wasm");
                ffmpeg = await window.createFFmpeg({ log: true });
                downloadElem.innerHTML += "FFmpeg.wasm initialized<br>";
                console.log("FFmpeg.wasm initialized");
            }
        })();
        return ffmpegInitPromise;
    }

    /* CHANGE 18 | BACKGROUND AUDIO URL COLLECTION
       Collect assigned media URLs as well as completed resource entries.
       Inspect a bounded reader-object graph for detached Audio elements;
       do not patch browser media prototypes or change tab visibility.
       Retry missing parts with elapsed-time deadlines in every tab state.
       Keep observers private and remove them when collection ends.
    */
    function hasWorkingUrl(u) {
        return !!u && /\?.+=/.test(u.url);
    }

    async function ensurePlayerUrls(urls) {
        const spool = BIF.objects?.spool;
        const compass = BIF.objects?.compass;
        const expected = new Set((spool?.components || []).map(component =>
            partKeyFromUrl(component.meta.path)));
        function collectUrl(value) {
            try {
                if (typeof value !== "string") return;
                const url = new URL(value, location.href);
                if (!/^https?:$/.test(url.protocol) ||
                    !expected.has(partKeyFromUrl(url.href)) ||
                    !hasWorkingUrl({url: url.href})) return;
                // Replace stale entries with the player's latest assigned URL.
                capturedPlayerUrls.set(partKeyFromUrl(url.href), url.href);
            } catch { /* Not a usable media URL. */ }
        }
        function collectResources(entries) {
            for (const entry of entries) collectUrl(entry.name);
        }
        function collectAssignedUrls() {
            // This also sees requests whose timing entries have not completed.
            const queue = [{value: spool, depth: 0},
                {value: BIF.objects?.audioManager, depth: 0}];
            for (const element of document.querySelectorAll("audio, video")) {
                collectUrl(element.src);
                collectUrl(element.currentSrc);
            }
            const seen = new Set();
            for (let i = 0; i < queue.length && i < 300; i++) {
                const {value, depth} = queue[i];
                if (!value || typeof value !== "object" || seen.has(value)) continue;
                seen.add(value);
                if (value instanceof HTMLMediaElement) {
                    collectUrl(value.src);
                    collectUrl(value.currentSrc);
                    continue;
                }
                if (value instanceof Node || value === window || depth > 6) continue;
                try {
                    // Data descriptors only: do not invoke arbitrary getters.
                    for (const descriptor of Object.values(
                        Object.getOwnPropertyDescriptors(value))) {
                        const child = descriptor.value;
                        if (typeof child === "string") collectUrl(child);
                        else if (child && typeof child === "object" &&
                            queue.length < 300) {
                            queue.push({value: child, depth: depth + 1});
                        }
                    }
                } catch { /* An inaccessible reader object is optional. */ }
            }
        }
        function collect() {
            collectResources(performance.getEntriesByType("resource") || []);
            collectAssignedUrls();
            return getUrls();
        }
        urls = collect();
        if (urls.every(hasWorkingUrl)) return urls;
        if (!spool || !compass || typeof compass.at !== "function") return urls;

        const origFloc = spool.focus ? spool.focus.floc : 0;
        let observer;
        downloadElem.innerHTML += "Gathering audio <span id=\"sweepAcc\"></span><br>";
        const status = downloadElem.querySelector("span#sweepAcc");
        try {
            if (typeof PerformanceObserver === "function") {
                try {
                    observer = new PerformanceObserver(list =>
                        collectResources(list.getEntries()));
                    observer.observe({type: "resource", buffered: true});
                } catch { observer?.disconnect(); }
            }
            for (let attempt = 1; attempt <= 3; attempt++) {
                const missing = collect().filter(item => !hasWorkingUrl(item));
                if (!missing.length) break;
                for (const part of missing) {
                    if (hasWorkingUrl(collect().find(item => item.index === part.index))) continue;
                    if (status) status.textContent =
                        `part ${part.index + 1} of ${urls.length}, attempt ${attempt}/3`;
                    const place = compass.at({floc: part.index +
                        [0.25, 0.5, 0.75][attempt - 1]});
                    if (!place || typeof place.seek !== "function") continue;
                    place.seek();
                    // Poll actual elapsed time; never depend on a fixed number
                    // of timer ticks or require the tab to become visible.
                    const deadline = performance.now() + 30000;
                    do {
                        if (hasWorkingUrl(collect().find(item => item.index === part.index))) break;
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } while (performance.now() < deadline);
                }
            }
            urls = collect();
        } finally {
            if (observer) {
                collectResources(observer.takeRecords());
                observer.disconnect();
            }
            urls = collect();
            const missing = urls.filter(item => !hasWorkingUrl(item));
            if (status) status.textContent = missing.length
                ? "incomplete; missing part(s) " + missing.map(item => item.index + 1).join(", ")
                : "complete";
            try {
                const back = compass.at({floc: origFloc});
                if (back && typeof back.seek === "function") back.seek();
            } catch { /* Do not mask the export result. */ }
        }
        return urls;
    }

    function exportMP3(){
        if (downloadState != -1)
            return;

        downloadState = 0;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting MP3</b><br>";
        ensurePlayerUrls(getUrls()).then(function(urls){
            let bad = urls.filter(function(u){ return !hasWorkingUrl(u); });
            if (bad.length) {
                downloadElem.innerHTML += "<b>Cannot export:</b> no working URL for part(s) " + bad.map(function(u){ return u.index + 1; }).join(", ") + ". Try playing through those parts first, then export again.<br>";
                downloadState = -1;
                return;
            }
            createAndDownloadMp3(urls).then(()=>{});
        }).catch(function(err){
            downloadElem.innerHTML += "<b>Error:</b> " + err.message + "<br>";
            downloadState = -1;
        });
    }



    // CHANGE 19: Always use browser downloads; no script-created save dialog.
    async function fallbackBlobDownload(files, filename) {
        downloadElem.innerHTML += "Preparing browser download...<br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const zipBlob = await (await getDownloadZip())(files).blob();

        /* =========================================
           CHANGE 04 | 2026-11-11 | FORMAT-NEUTRAL STATUS
           Before: The shared fallback reported Generated zip file!
           Now: Generated archive! applies to both ZIP and EPUB downloads.
           The output filename/extension still comes from the calling path.
           END CHANGE 04
           ========================================= */
        downloadElem.innerHTML += "Generated archive! <br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const downloadUrl = URL.createObjectURL(zipBlob);

        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(downloadUrl), 100);
    }

    async function createAndDownloadZip(urls, addMeta) {
        const files = [];

        // Fetch all files and add them to the files array
        const fetchPromises = urls.map(async (url) => {
            const response = await fetch(url.url);
            const blob = await response.blob();
            const filename = "Part " + paddy(url.index + 1, 3) + ".mp3";

            let partElem = document.createElement("div");
            partElem.textContent = "Download of "+ filename + " complete";
            downloadElem.appendChild(partElem);
            downloadElem.scrollTo(0, downloadElem.scrollHeight);

            downloadState += 1;

            return {
                name: filename,
                input: blob
            };
        });

        // Start metadata creation in parallel with file downloads
        const metadataPromise = addMeta ? createMetadata() : Promise.resolve([]);

        // Wait for both file downloads and metadata creation to complete
        const [downloadedFiles, metadataFiles] = await Promise.all([
            Promise.all(fetchPromises),
            metadataPromise
        ]);

        files.push(...downloadedFiles);
        files.push(...metadataFiles);

        downloadElem.innerHTML += "<br><b>Downloads complete!</b> Starting ZIP generation and download...<br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const filename = getArchiveFilename("zip");

        // Browser settings control the destination and any browser-level prompt.
        await fallbackBlobDownload(files, filename);

        downloadState = -1;
        downloadElem.innerHTML = ""
        downloadElem.classList.remove("active");
    }

    function exportChapters(){
        if (downloadState != -1)
            return;

        downloadState = 0;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting export</b><br>";
        ensurePlayerUrls(getUrls()).then(function(urls){
            let bad = urls.filter(function(u){ return !hasWorkingUrl(u); });
            if (bad.length) {
                downloadElem.innerHTML += "<b>Cannot export:</b> no working URL for part(s) " + bad.map(function(u){ return u.index + 1; }).join(", ") + ". Try playing through those parts first, then export again.<br>";
                downloadState = -1;
                return;
            }
            downloadElem.innerHTML += "Downloading...<br>";
            createAndDownloadZip(urls, true).then(()=>{});
        }).catch(function(err){
            downloadElem.innerHTML += "<b>Error:</b> " + err.message + "<br>";
            downloadState = -1;
        });
    }

    // Main entry point for audiobooks
    function bifFoundAudiobook(){
        // New global style info
        libreShadowHost = document.createElement("div");
        libreShadowHost.style.display = "contents";
        libreShadowRoot = libreShadowHost.attachShadow({mode: "closed"});
        let s = document.createElement("style");
        s.innerHTML = CSS;
        libreShadowRoot.appendChild(s)
        if (odreadCmptParams == null){
            alert("odreadCmptParams not set, so cannot resolve book urls! Please try refreshing.")
            return;
        }

        buildPirateUi();
        initFFmpeg().catch(console.error);
    }



    /* =========================================
              END AUDIOBOOK SECTION!
       =========================================
    */

    /* =========================================
              BEGIN BOOK SECTION!
       =========================================
    */
    const bookNav = `
        <div style="text-align: center; width: 100%;">
           <a class="pLink" id="download"> <h1> Download EPUB </h1> </a>
        </div>
    `;
    /* =========================================
       CHANGE 05 | 2026-11-11 | PRIVATE CHAPTER COLLECTION
       Before: The collection was also exposed as window.pages.
       Now: Use a private object without a prototype; all collection
       reads and writes were updated to reference this local variable.
       Removed: The global Function.prototype.bind hook and its heuristic
       decryption-function global. CHANGE 15 now reads loaded frames
       instead of obtaining a decoding callback.
       Old Console diagnostics using window.pages no longer apply.
       END CHANGE 05
       ========================================= */
    const pages = Object.create(null);

    // Loaded-frame capture requires no callback replacement or global bind patch.

    /* =========================================
       CHANGE 06 | 2026-11-11 | SEQUENTIAL CHAPTER LOADING
       Before: Called private _loadContent with no work token for every
       chapter, then polled forever and repeatedly logged missing counts.
       Now: Skip captured chapters; halt stale work, fetch one chapter,
       copy the loaded frame before release, then advance to the next.
       Added: Progress-based timeouts (30 seconds visible, 180 hidden)
       and explicit failure paths; see CHANGE 17.
       Why: Avoid invalid work-token failures and indefinite waiting.
       Limit: halt/fetch still use reader internals. Avoid navigating
       the reader during export, as navigation can start competing work.
       END CHANGE 06
       ========================================= */
    /* =========================================
       CHANGE 15 | 2026-11-11 | NO-OVERRIDE FRAME CAPTURE
       Before: Replace a locked chapter callback using Local Overrides.
       Now: Let the reader decode normally; copy its loaded document
       inside fetch() completion, before fetch() releases the frame.
       Store base URLs and stylesheet URLs with each captured chapter.
       Existing loaded frames are copied without forcing another load.
       Only cloned markup is sanitized; the live reader is not edited.
       Limits: Needs a readable same-origin frame and the current
       component fetch() lifecycle. Background verification remains pending.
       ========================================= */
    const pageResources = Object.create(null);
    function captureLoadedChapter(component) {
        const frame = component.frameBox || component.sheetBox?.querySelector('iframe');
        const doc = frame?.contentDocument;
        if (!doc?.body || !doc.documentElement) {
            throw new Error(`Chapter frame is unavailable: ${component.id}`);
        }
        // CHANGE 16: The reader marks successful documents as "ok".
        // Attribute presence alone does not indicate a loading failure.
        const documentStatus = doc.documentElement
            .getAttribute('data-document-status');
        if (documentStatus && documentStatus.trim().toLowerCase() !== 'ok') {
            throw new Error(`Reader reported ${documentStatus} for ${component.id}`);
        }
        const base = [doc.baseURI, frame.src].find(value => /^https?:/i.test(value || '')) ||
            new URL(component.meta.path, location.href).href;
        const root = doc.documentElement.cloneNode(true);
        root.querySelectorAll('script, base').forEach(node => node.remove());
        root.querySelectorAll('*').forEach(element => {
            for (const attribute of Array.from(element.attributes)) {
                if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
            }
        });
        const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))
            .map(link => new URL(link.getAttribute('href'), base).href);
        root.querySelectorAll('link[rel~="stylesheet"]').forEach(link => link.remove());
        root.querySelectorAll('img[src], image').forEach(image => {
            for (const attribute of ['src', 'href', 'xlink:href']) {
                const value = image.getAttribute(attribute);
                if (value && !value.startsWith('#')) {
                    image.setAttribute(attribute, new URL(value, base).href);
                }
            }
        });
        const body = root.querySelector('body');
        if (!body || (!body.textContent.trim() && !body.querySelector('img, image, svg, canvas'))) {
            throw new Error(`Chapter frame has no readable content: ${component.id}`);
        }
        if (body.querySelector('canvas')) {
            throw new Error(`Chapter uses canvas rendering; export is unsupported: ${component.id}`);
        }
        pageResources[component.id] = {base, links};
        // fixXhtml supplies the outer html element; preserve head and body.
        pages[component.id] = (root.querySelector('head')?.outerHTML || '') + body.outerHTML;
    }

    async function waitForChapters(callback) {
        const components = getBookComponents();

        for (const component of components) {
            if (pages[component.id] !== undefined) {
                callback();
                continue;
            }

            if (component.isLoaded()) {
                captureLoadedChapter(component);
                callback();
                continue;
            }
            // Clear stale work before beginning this sequential load.
            component.halt();

            await new Promise((resolve, reject) => {
                let settled = false;
                let lastStage = component._?.loadingStage;
                let lastProgress = performance.now();
                let wasHidden = document.hidden;
                let timer;

                // CHANGE 17: Continue exports in hidden tabs. The inspected
                // reader waits for fonts.ready after loading/modifying markup.
                // Export needs that markup, not completed visual font layout.
                // Capture only at that exact stage, with a complete, healthy
                // document. Never synthesize reader completion callbacks.
                const checkProgress = () => {
                    if (settled) return;
                    const stage = component._?.loadingStage;
                    const now = performance.now();
                    if (stage !== lastStage) {
                        lastStage = stage;
                        lastProgress = now;
                    }
                    // Give foreground work a fresh budget on return, rather
                    // than immediately expiring a background operation.
                    if (wasHidden && !document.hidden) lastProgress = now;
                    wasHidden = document.hidden;
                    if (document.hidden &&
                        stage === "waiting for fonts.ready promise to fulfill") {
                        try {
                            const doc = component.frameBox?.contentDocument;
                            if (doc?.readyState === "complete" &&
                                doc.documentElement?.getAttribute(
                                    "data-document-status") === "ok") {
                                captureLoadedChapter(component);
                                // Invalidate pending reader work before releasing
                                // its frame, including a later fonts.ready callback.
                                component.halt();
                                component.unprime();
                                finish();
                                return;
                            }
                        } catch (error) {
                            finish(error);
                            return;
                        }
                    }
                    // Hidden timers may run much less often. Keep a finite
                    // failure budget, but allow background loading more time.
                    const limit = document.hidden ? 180000 : 30000;
                    if (now - lastProgress >= limit) {
                        finish(new Error(
                            `Chapter loading timed out: ${component.id}\n` +
                            `Stage: ${stage || "unknown"}\n` +
                            `Tab: ${document.hidden ? "background" : "foreground"}`
                        ));
                        return;
                    }
                    timer = setTimeout(checkProgress, 1000);
                };

                const finish = (error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);

                    if (error) reject(error);
                    else resolve();
                };

                timer = setTimeout(checkProgress, 1000);

                try {
                    component.fetch(() => {
                        if (settled) return;
                        try {
                            captureLoadedChapter(component);
                            finish();
                        } catch (error) {
                            finish(error);
                        }
                    });
                } catch (error) {
                    finish(error);
                }
            });

            callback();
        }
    }
    function getBookComponents(){
        return BIF.objects.reader._.context.spine._.components.filter(p => "hidden" != (p.block || {}).behavior)
    }
    function truncate(path){
        return path.substring(path.lastIndexOf('/') + 1);
    }
    function getFilenameFromURL(url) {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname;
        return pathname.substring(pathname.lastIndexOf('/') + 1);
    }
    async function createContent(files, imgAssests){


        let components = getBookComponents();
        let totComp = components.length;
        downloadElem.innerHTML += `Gathering chapters <span id="chapAcc"> 0/${totComp} </span><br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        let gc = 0;
        await waitForChapters(()=>{
            gc+=1;
            downloadElem.querySelector("span#chapAcc").innerHTML = ` ${components.filter((page)=>undefined!=pages[page.id]).length}/${totComp}`;
        });

        downloadElem.innerHTML += `Chapter gathering complete<br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        /* =========================================
           CHANGE 07 / 15 | CAPTURED PAGE RESOURCES
           IDs, base URLs and stylesheet references no longer depend
           on reader frames surviving until the packaging stage.
           ========================================= */
        for (const component of components) {
            component.meta.id = component.meta.id || crypto.randomUUID();
            const resource = pageResources[component.id];
            if (!resource || pages[component.id] === undefined) {
                throw new Error(`Missing captured chapter: ${component.id}`);
            }
            for (const href of resource.links) {
                if (!imgAssests.includes(href)) imgAssests.push(href);
            }
            files.push({
                name: "OEBPS/" + truncate(component.id),
                input: fixXhtml(component.meta.id, resource.base,
                    pages[component.id], imgAssests, resource.links)
            });
        }

        downloadElem.innerHTML += `Downloading assets <span id="assetGath"> 0/${imgAssests.length} </span><br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);


        gc = 0;
        await Promise.all(imgAssests.map(name=>(async function(){
            const response = await fetch(name.startsWith("http") ? name : location.origin + "/" + name);
            if (response.status != 200) {
                downloadElem.innerHTML += `<b>WARNING:</b> Could not fetch ${name}<br>`
                downloadElem.scrollTo(0, downloadElem.scrollHeight);
                return;
            }
            const blob = await response.blob();

            files.push({
                name: "OEBPS/" + (name.startsWith("http") ? getFilenameFromURL(name) : name),
                input: blob
            });

            gc+=1;
            downloadElem.querySelector("span#assetGath").innerHTML = ` ${gc}/${imgAssests.length} `;
        })()));
    }
    /* =========================================
       CHANGE 08 | 2026-11-11 | IMAGE AND TEXT OVERLAY LAYOUT
       Added: Inline positioning and transparent text-overlay styling,
       plus viewport dimensions taken from the page image.
       Applied only to markup containing .imageLayer img and .textLayer.
       Why: Without CSS, overlay text flowed as extra visible text after
       the image. Keep the overlay rather than deleting its text.
       Missing/invalid image dimensions now raise an explicit error.
       Limit: This is a format-specific repair, not a general recreation
       of arbitrary publisher CSS or fonts.
       END CHANGE 08
       ========================================= */
    const CSS_FIXED_PAGES = 'html, body { margin:0; padding:0; overflow:hidden; }\nbody { position:relative; }\n.imageLayer, .textLayer { position:absolute; left:0; top:0; width:100%; height:100%; }\n.imageLayer img { display:block; width:100%; height:100%; }\n.textLayer { overflow:hidden; line-height:1; direction:ltr; }\n.textLayer > span { position:absolute; color:transparent !important; white-space:pre; transform-origin:0% 0%; }\n.textLayer > br { display:none; }\n';

    function enforceEpubXHTML(metaId, url, htmlString, assetRegistry, links) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');
        const bod = doc.querySelector("body");
        if (bod){
            if (metaId) bod.setAttribute("id", metaId);
        }

        // Convert all elements to lowercase tag names
        const elements = doc.getElementsByTagName('*');
        for (let el of elements) {
            const newElement = doc.createElement(el.tagName.toLowerCase());

            // Copy attributes to the new element
            for (let attr of el.attributes) {
                newElement.setAttribute(attr.name, attr.value);
            }

            // Move child nodes to the new element
            while (el.firstChild) {
                newElement.appendChild(el.firstChild);
            }

            // Replace old element with the new one
            el.parentNode.replaceChild(newElement, el);
        }

        for (let el of elements) {
            if (el.tagName.toLowerCase() == "img" || el.tagName.toLowerCase() == "image"){
                let src = el.getAttribute("src") || el.getAttribute("xlink:href");
                if (!src) continue;

                if (!(src.startsWith("http://") ||  src.startsWith("https://"))){
                    src = (new URL(src, new URL(url))).toString();
                }
                if (!assetRegistry.includes(src))
                    assetRegistry.push(src);

                if (el.getAttribute("src"))
                    el.setAttribute("src", truncate(src));
                if (el.getAttribute("xlink:href"))
                    el.setAttribute("xlink:href", truncate(src));
            }
        }


        // Ensure the <head> element exists with a <title>
        let head = doc.querySelector('head');
        if (!head) {
            head = doc.createElement('head');
            doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
        }

        let title = head.querySelector('title');
        if (!title) {
            title = doc.createElement('title');
            title.textContent = BIF.map.title.main; // Default title
            head.appendChild(title);
        }

        for (let link of links){
            let src = link;
            if (!(src.startsWith("http://") || src.startsWith("https://"))) {
              src = (new URL(src, new URL(url))).toString();
            }
            let linkElement = doc.createElement('link');
            linkElement.setAttribute("href", truncate(src));
            linkElement.setAttribute("rel", "stylesheet");
            linkElement.setAttribute("type", "text/css");
            head.appendChild(linkElement);
        }

        // Image-backed fixed pages contain a transparent text overlay.
        // Recreate its styling from captured markup, not discarded reader frames.
        const pageImage = doc.querySelector('.imageLayer img');
        if (pageImage && doc.querySelector('.textLayer')) {
            const width = Number(pageImage.getAttribute('width'));
            const height = Number(pageImage.getAttribute('height'));
            if (!(width > 0 && height > 0)) {
                throw new Error('Missing dimensions for image-backed page');
            }
            const viewport = doc.createElement('meta');
            viewport.name = 'viewport';
            viewport.content = `width=${width}, height=${height}`;
            head.appendChild(viewport);
            const style = doc.createElement('style');
            style.textContent = CSS_FIXED_PAGES;
            head.appendChild(style);
        }

        // Get the serialized XHTML string
        const serializer = new XMLSerializer();
        let xhtmlString = serializer.serializeToString(doc);

        // Ensure proper namespaces (if not already present)
        if (!xhtmlString.includes('xmlns="http://www.w3.org/1999/xhtml"')) {
            xhtmlString = xhtmlString.replace('<html>', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML" xmlns:pls="http://www.w3.org/2005/01/pronunciation-lexicon" xmlns:ssml="http://www.w3.org/2001/10/synthesis" xmlns:svg="http://www.w3.org/2000/svg">');
        }

        return xhtmlString;
    }
    function fixXhtml(metaId, url, html, assetRegistry, links){
        html = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
` + enforceEpubXHTML(metaId, url, `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML" xmlns:pls="http://www.w3.org/2005/01/pronunciation-lexicon" xmlns:ssml="http://www.w3.org/2001/10/synthesis" xmlns:svg="http://www.w3.org/2000/svg">`
            + html + `</html>`, assetRegistry, links);



        return html;
    }
    function getMimeTypeFromFileName(fileName) {
        const mimeTypes = {
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            gif: 'image/gif',
            bmp: 'image/bmp',
            webp: 'image/webp',
            mp4: 'video/mp4',
            mp3: 'audio/mp3',
            pdf: 'application/pdf',
            txt: 'text/plain',
            html: 'text/html',
            css: 'text/css',
            json: 'application/json',
            // Add more extensions as needed
        };

        const ext = fileName.split('.').pop().toLowerCase();
        return mimeTypes[ext] || 'application/octet-stream';
    }
    function makePackage(files, assetRegistry){
        const idStore = [];
        const doc = document.implementation.createDocument(
            'http://www.idpf.org/2007/opf', // default namespace
            'package', // root element name
            null // do not specify a doctype
        );

        // Step 2: Set attributes for the root element
        /* =========================================
           CHANGE 09 | 2026-11-11 | EPUB 3 AND FIXED-LAYOUT METADATA
           Before: Declared EPUB 2.0 with no fixed-layout declaration.
           Now: Declare EPUB 3.0 and the rendition vocabulary; add a UTC
           modified timestamp. If every selected component has both layer
           markers, declare pre-paginated layout and disable spreads.
           The existing NCX is retained alongside the new EPUB navigation.
           This change alone is not proof of full EPUB specification validity.
           END CHANGE 09
           ========================================= */
        const packageElement = doc.documentElement;
        packageElement.setAttribute('version', '3.0');
        packageElement.setAttribute('prefix', 'rendition: http://www.idpf.org/vocab/rendition/#');
        packageElement.setAttribute('xml:lang', 'en');
        packageElement.setAttribute('unique-identifier', 'pub-identifier');
        packageElement.setAttribute('xmlns', 'http://www.idpf.org/2007/opf');
        packageElement.setAttribute('xmlns:dc', 'http://purl.org/dc/elements/1.1/');
        packageElement.setAttribute('xmlns:dcterms', 'http://purl.org/dc/terms/');
        packageElement.setAttribute('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance');

        // Step 3: Create and append child elements to the root
        const metadata = doc.createElementNS('http://www.idpf.org/2007/opf', 'metadata');
        packageElement.appendChild(metadata);

        // Create child elements for metadata
        const dcIdentifier = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:identifier');
        dcIdentifier.setAttribute('id', 'pub-identifier');
        dcIdentifier.textContent = "" + BIF.map["-odread-buid"];
        metadata.appendChild(dcIdentifier);
        const fixedPages = getBookComponents().every(c => {
            const raw = pages[c.id] || '';
            return raw.includes('imageLayer') && raw.includes('textLayer');
        });
        const metadataValues = {'dcterms:modified': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')};
        if (fixedPages) {
            metadataValues['rendition:layout'] = 'pre-paginated';
            metadataValues['rendition:spread'] = 'none';
        }
        for (const [property, value] of Object.entries(metadataValues)) {
            const meta = doc.createElementNS('http://www.idpf.org/2007/opf', 'meta');
            meta.setAttribute('property', property);
            meta.textContent = value;
            metadata.appendChild(meta);
        }


        /* =========================================
           CHANGE 10 | 2026-11-11 | PRESERVE FULL LANGUAGE VALUE
           Before: Always used language[0], turning a string like en into e.
           Now: Take the first item for arrays, or use the full string.
           Use that same value for package xml:lang.
           END CHANGE 10
           ========================================= */
        // Language
        if (BIF.map.language.length){
            const dcLanguage = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:language');
            dcLanguage.setAttribute('xsi:type', 'dcterms:RFC4646');
            dcLanguage.textContent = Array.isArray(BIF.map.language) ? BIF.map.language[0] : BIF.map.language;
            packageElement.setAttribute('xml:lang', dcLanguage.textContent);
            metadata.appendChild(dcLanguage);
        }

        // Identifier
        const metaIdentifier = doc.createElementNS('http://www.idpf.org/2007/opf', 'meta');
        metaIdentifier.setAttribute('id', 'meta-identifier');
        metaIdentifier.setAttribute('property', 'dcterms:identifier');
        metaIdentifier.textContent = "" + BIF.map["-odread-buid"];
        metadata.appendChild(metaIdentifier);

        // Title
        const dcTitle = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:title');
        dcTitle.setAttribute('id', 'pub-title');
        dcTitle.textContent = BIF.map.title.main;
        metadata.appendChild(dcTitle);


        // Creator (Author)
        if(BIF.map.creator.length){
            const dcCreator = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:creator');
            dcCreator.textContent = BIF.map.creator[0].name;
            metadata.appendChild(dcCreator);
        }

        // Description
        if(BIF.map.description){
            // Remove HTML tags
            let p = document.createElement("p");
            p.innerHTML = BIF.map.description.full;


            const dcDescription = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:description');
            dcDescription.textContent = p.textContent;
            metadata.appendChild(dcDescription);
        }

        // Step 4: Create the manifest, spine, guide, and other sections...
        const manifest = doc.createElementNS('http://www.idpf.org/2007/opf', 'manifest');
        packageElement.appendChild(manifest);

        const spine = doc.createElementNS('http://www.idpf.org/2007/opf', 'spine');
        spine.setAttribute("toc", "ncx");
        packageElement.appendChild(spine);


        const item = doc.createElementNS('http://www.idpf.org/2007/opf', 'item');
        item.setAttribute('id', 'ncx');
        item.setAttribute('href', 'toc.ncx');
        item.setAttribute('media-type', 'application/x-dtbncx+xml');
        manifest.appendChild(item);


        // Generate out the manifest
        let components = getBookComponents();
        components.forEach(chapter =>{
            const item = doc.createElementNS('http://www.idpf.org/2007/opf', 'item');
            let id = chapter.meta.id || crypto.randomUUID();
            while (idStore.includes(id)) {
              id = id + "-" + crypto.randomUUID();
            }
            item.setAttribute('id', id);
            idStore.push(id);
            item.setAttribute('href', truncate(chapter.meta.path));
            item.setAttribute('media-type', 'application/xhtml+xml');
            manifest.appendChild(item);


            const itemref = doc.createElementNS('http://www.idpf.org/2007/opf', 'itemref');
            itemref.setAttribute('idref', id); // Use the same id as the manifest item
            itemref.setAttribute('linear', "yes");
            spine.appendChild(itemref);
        });

        assetRegistry.forEach(asset => {
            const item = doc.createElementNS('http://www.idpf.org/2007/opf', 'item');
            let aname = asset.startsWith("http") ? getFilenameFromURL(asset) : asset;
            let id = aname.split(".")[0];
            while (idStore.includes(id)) {
              id = id + "-" + crypto.randomUUID();
            }
            item.setAttribute('id', id);
            idStore.push(id);
            item.setAttribute('href', aname);
            item.setAttribute('media-type', getMimeTypeFromFileName(aname));
            manifest.appendChild(item);
        });

        /* =========================================
           CHANGE 11 | 2026-11-11 | EPUB NAVIGATION DOCUMENT
           Added: OEBPS/nav.xhtml, registered with properties="nav".
           Its entries follow component order and use Page N labels.
           The older toc.ncx generation remains unchanged.
           Limit: The added navigation is a flat page list; it does not
           reconstruct the original chapter-title hierarchy.
           END CHANGE 11
           ========================================= */
        const navDoc = document.implementation.createDocument('http://www.w3.org/1999/xhtml', 'html');
        const ns = 'http://www.w3.org/1999/xhtml';
        const navHead = navDoc.createElementNS(ns, 'head');
        const navTitle = navDoc.createElementNS(ns, 'title');
        navTitle.textContent = 'Contents';
        navHead.appendChild(navTitle);
        navDoc.documentElement.appendChild(navHead);
        const navBody = navDoc.createElementNS(ns, 'body');
        const nav = navDoc.createElementNS(ns, 'nav');
        nav.setAttributeNS('http://www.idpf.org/2007/ops', 'epub:type', 'toc');
        const list = navDoc.createElementNS(ns, 'ol');
        components.forEach((component, index) => {
            const li = navDoc.createElementNS(ns, 'li');
            const a = navDoc.createElementNS(ns, 'a');
            a.setAttribute('href', truncate(component.meta.path));
            a.textContent = `Page ${index + 1}`;
            li.appendChild(a); list.appendChild(li);
        });
        nav.appendChild(list); navBody.appendChild(nav);
        navDoc.documentElement.appendChild(navBody);
        files.push({name:'OEBPS/nav.xhtml', input:new XMLSerializer().serializeToString(navDoc)});
        const navItem = doc.createElementNS('http://www.idpf.org/2007/opf', 'item');
        navItem.setAttribute('id','epub-nav');
        navItem.setAttribute('href','nav.xhtml');
        navItem.setAttribute('media-type','application/xhtml+xml');
        navItem.setAttribute('properties','nav');
        manifest.appendChild(navItem);

        // Step 5: Serialize the document to a string
        const serializer = new XMLSerializer();
        const xmlString = serializer.serializeToString(doc);

        files.push({
            name: "OEBPS/content.opf",
            input: `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n` + xmlString
        });
    }
    function makeToc(files){
        // Step 1: Create the document with a default namespace
        const doc = document.implementation.createDocument(
            'http://www.daisy.org/z3986/2005/ncx/', // default namespace
            'ncx', // root element name
            null // do not specify a doctype
        );

        // Step 2: Set attributes for the root element
        const ncxElement = doc.documentElement;
        ncxElement.setAttribute('version', '2005-1');

        // Step 3: Create and append child elements to the root
        const head = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'head');
        ncxElement.appendChild(head);

        const uidMeta = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'meta');
        uidMeta.setAttribute('name', 'dtb:uid');
        uidMeta.setAttribute('content', "" + BIF.map["-odread-buid"]);
        head.appendChild(uidMeta);

        // Step 4: Create docTitle and add text
        const docTitle = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'docTitle');
        ncxElement.appendChild(docTitle);

        const textElement = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'text');
        textElement.textContent = BIF.map.title.main;
        docTitle.appendChild(textElement);

        // Step 5: Create navMap and append navPoint elements
        const navMap = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'navMap');
        ncxElement.appendChild(navMap);


        let components = getBookComponents();

        components.forEach(chapter =>{
            // First navPoint
            const navPoint1 = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'navPoint');
            navPoint1.setAttribute('id', chapter.meta.id);
            navPoint1.setAttribute('playOrder', '' + (1+chapter.index));
            navMap.appendChild(navPoint1);

            const navLabel1 = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'navLabel');
            navPoint1.appendChild(navLabel1);

            const text1 = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'text');
            text1.textContent = BIF.map.title.main;
            navLabel1.appendChild(text1);

            const content1 = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'content');
            content1.setAttribute('src', truncate(chapter.meta.path));
            navPoint1.appendChild(content1);
        });


        // Step 6: Serialize the document to a string
        const serializer = new XMLSerializer();
        const xmlString = serializer.serializeToString(doc);

        files.push({
            name: "OEBPS/toc.ncx",
            input: `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n` + xmlString
        });
    }
    async function downloadEPUB(){
        let imageAssets = new Array();
        const files = [];

        // Add mimetype file (must be first and uncompressed for EPUB spec)
        files.push({
            name: "mimetype",
            input: "application/epub+zip"
        });

        // Add META-INF files
        files.push({
            name: "META-INF/container.xml",
            input: `<?xml version="1.0" encoding="UTF-8"?>
                <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                    <rootfiles>
                        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
                    </rootfiles>
                </container>
        `
        });

        // Add required encryption file for DRM compliance (required by EPUB spec)
        files.push({
            name: "META-INF/encryption.xml",
            input: `<?xml version="1.0" encoding="UTF-8"?>
                <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>
        `
        });

        await createContent(files, imageAssets);

        makePackage(files, imageAssets);
        makeToc(files);


        downloadElem.innerHTML += "<br><b>Downloads complete!</b> Starting EPUB generation and download...<br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const filename = getArchiveFilename("epub");

        // Browser settings control the destination and any browser-level prompt.
        await fallbackBlobDownload(files, filename);

        downloadState = -1;
    }

    /* =========================================
       CHANGE 12 | 2026-11-11 | EBOOK INITIALIZATION
       The previous version intercepted __bif_cfc3 through an external
       theme.js override. CHANGE 15 removes that requirement entirely.
       Startup now adds the UI without touching any reader callback.
       ========================================= */
    // Main entry point for books
    function bifFoundBook(){
        // New global style info
        let s = document.createElement("style");
        s.innerHTML = CSS;
        document.head.appendChild(s)

        console.info('LibreGRAB: loaded-frame export ready');

        buildBookPirateUi();
    }

    function downloadEPUBBBtn(){
        if (downloadState != -1)
            return;

        downloadState = 0;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting download</b><br>";

        /* =========================================
           CHANGE 13 | 2026-11-11 | SHOW EXPORT FAILURES
           Before: No rejection handler on the EPUB export promise.
           Now: Log the error, show it as text in the download panel, and
           reset downloadState so the user can attempt another export.
           END CHANGE 13
           ========================================= */
        downloadEPUB().catch(error => {
            console.error("LibreGRAB: download failed", error);

            const message = document.createElement("pre");
            message.style.whiteSpace = "pre-wrap";
            message.textContent = error.message || String(error);
            downloadElem.appendChild(message);

            downloadState = -1;
        });
    }
    function buildBookPirateUi(){
        // Create the nav
        let nav = document.createElement("div");
        nav.innerHTML = bookNav;
        nav.querySelector("#download").onclick = downloadEPUBBBtn;
        nav.classList.add("pNav");
        let pbar = document.querySelector(".nav-progress-bar");
        pbar.insertBefore(nav, pbar.children[1]);



        downloadElem = document.createElement("div");
        downloadElem.classList.add("foldMenu");
        downloadElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
        document.body.appendChild(downloadElem);
    }

    /* =========================================
              END BOOK SECTION!
       =========================================
    */

    /* =========================================
              BEGIN INITIALIZER SECTION!
       =========================================
    */

    // The "BIF" contains all the info we need to download
    // stuff, so we wait until the page is loaded, and the
    // BIF is present, to inject the pirate menu.
    // Delay audiobook UI until the player has fully initialized: building
    // during load races the player's own setup and redirects to terms.
    // Readiness = BIF + spool components + bootstrap params + a progress
    // bar whose child count is stable across polls. Ebooks keep the old
    // trigger untouched. A throw while checking never escapes: keep polling.
    let __pbarCount = -1, __stablePolls = 0;
    let intr = setInterval(()=>{
        try {
            const pbar = document.querySelector(".nav-progress-bar");
            if (window.BIF == undefined || pbar == undefined) { __pbarCount = -1; __stablePolls = 0; return; }
            let mode = location.hostname.split(".")[1];
            if (mode != "listen") {
                clearInterval(intr);
                BIF = window.BIF;
                bifFoundBook();
                return;
            }
            const spool = window.BIF.objects && window.BIF.objects.spool;
            const ready = spool && Array.isArray(spool.components) && spool.components.length > 0 &&
                odreadCmptParams != null;
            if (!ready) { __pbarCount = -1; __stablePolls = 0; return; }
            if (pbar.children.length !== __pbarCount) { __pbarCount = pbar.children.length; __stablePolls = 0; return; }
            if (++__stablePolls < 2) return;
            clearInterval(intr);
            BIF = window.BIF;
            bifFoundAudiobook();
        } catch { __pbarCount = -1; __stablePolls = 0; }
    }, 500);
    }

    function injectPageScript(code) {
        const script = document.createElement('script');
        script.textContent = code;
        (document.documentElement || document.head || document.body).appendChild(script);
        script.remove();
    }

    /* =========================================
       CHANGE 14 | 2026-11-11 | PER-LOAD UI NAMES AND HASH CHECKS
       Before: UI class/ID markers used stable names on the page.
       Now: Generate 128-bit random suffixes and reject duplicates,
       existing window property names, and known detector-hash matches.
       Rewrite the eight listed UI tokens consistently in the main
       function source before injecting it; also generate the ZIP bridge.
       CSS strings, HTML strings, and selectors share the same mapping.
       The mapping remains private. Reader API names are not renamed.
       Limit: reservedHashes is the inspected detector snapshot. This
       does not fetch or decode updated detector code automatically,
       randomize every DOM identifier, or guarantee future non-detection.
       END CHANGE 14
       ========================================= */
    // Generate CSS-safe, per-load names. No name map is exposed on window.
    const reservedHashes = new Set([
        2884670943, 3715490804, 1042643420, 3879434267,
        2174135392, 1753812077, 767634082, 3553780316,
        199939980, 1202545083, 3798819573, 4213409763
    ]);
    function hashName(value) {
        let hash = 2166136261;
        for (let i = 0; i < value.length; i++) {
            hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
        }
        return hash;
    }
    const used = new Set();
    function freshName() {
        let name;
        do {
            const bytes = crypto.getRandomValues(new Uint8Array(16));
            name = 'lg_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        } while (used.has(name) || name in window || reservedHashes.has(hashName(name)));
        used.add(name);
        return name;
    }
    const tokens = ['pNav', 'pLink', 'foldMenu', 'dumpAll',
        'mp3Progress', 'sweepAcc', 'chapAcc', 'assetGath'];
    const names = Object.fromEntries(tokens.map(token => [token, freshName()]));
    const privateNames = {zipBridge: freshName()};
    // These tokens occur only in our UI strings/selectors, not reader APIs.
    const tokenPattern = new RegExp('\\b(' + tokens.join('|') + ')\\b', 'g');
    const source = mainCode.toString().replace(tokenPattern, token => names[token]);
    injectPageScript(`(${source})(${JSON.stringify(privateNames)});`);

})();
