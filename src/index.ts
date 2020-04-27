import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import url from "url";

import sanitize from "sanitize-filename";
import puppeteer from "puppeteer";

type Log = {
    [url: string]: Recorded
}

type VODStatus = ProgramId & {
    episodes: VOD[],
}

type Recorded = ProgramId & {
    episodes: Episode[]
}

type ProgramId = {
    url: string,
    title: string
}

type VOD = Episode & {
    free: boolean,
}

type Episode = {
    videoURL: string,
    subtitle: string | null,
}

function initFile(filePath: string, init: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
        fs.accessSync(filePath)
    } catch (err) {
        fs.writeFileSync(filePath, init)
    }
}

function abspath(relative: string) {
    if (relative[0] === '~') {
        return path.normalize(path.join(os.homedir(), relative.slice(1)))
    }
    return path.normalize(relative)
}


async function crawl(browser: puppeteer.Browser, URL: string): Promise<VODStatus> {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    await page.goto(URL);
    await page.waitForSelector("p.com-video-EpisodeList__title");
    await page.waitForSelector("span.com-vod-VODLabel");

    //const html = await page.content();
    //fs.writeFile("./hoge.html", html, () => {});

    //await page.screenshot({ path: "./hoge.jpg", type: "jpeg", quality: 100 });

    const getText = (eh: puppeteer.ElementHandle | null) => eh !== null
        ? eh.getProperty("textContent").then(p => p.jsonValue())
        : null;

    const title = await page.$("h1.com-video-TitleSection__title").then(getText) as string;

    const episodeEHs = await page.$$("div.com-video-EpisodeList__listitem");
    const episodes = await Promise.all(episodeEHs.map(async episode => {

        const videoURLEH = await episode.$("a.com-a-Link");
        const videoURL: string | null = videoURLEH !== null
                ? await (await videoURLEH.getProperty("href")).jsonValue() as string
                : null;
        if (videoURL === null) return Promise.reject(new Error("No URL"));

        const subtitle = await episode.$("span.com-a-CollapsedText__container").then(getText) as string;
        const free = await episode.$("span.com-vod-VODLabel").then(getText) as string;
        return {
            videoURL,
            subtitle,
            free: free === "無料",
        }
    }));

    return {
        url: URL,
        title,
        episodes,
    }
};

function download(episode: Episode, title: string, recordedDir: string): Episode {
    const { subtitle, videoURL } = episode;
    const ext = "m2ts";

    const videoURLPath = (url.parse(videoURL).pathname as string).split("/").pop();
    const filename = sanitize(`${title} - ${subtitle}_${videoURLPath}.${ext}`);
    const dstPath = path.join(recordedDir, title);
    fs.mkdirSync(dstPath, { recursive: true });

    const filePath = abspath(path.join(dstPath, filename));


    try {
        execSync(`streamlink ${videoURL} best -o '${filePath}'`);
    } catch (err) {
        throw err;
    }
    return episode;
}

(async function main(){
    const logPath = abspath("~/.log/abemadl/downloads.json");
    const urlsPath = abspath("~/.config/abemadl/urls.json");
    initFile(logPath, "{}");
    initFile(urlsPath, "[]");

    const recordedDir = abspath(process.argv[2] || "./");

    const log = JSON.parse(fs.readFileSync(logPath, "utf8")) as Log;
    const urls = JSON.parse(fs.readFileSync(urlsPath, "utf8")) as string[];

    const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });

    // fetch metadata
    const programs: VODStatus[] = await Promise.all(urls.map(URL => crawl(browser, URL)));
    browser.close();

    const downloadTargets: VODStatus[] = programs.map((program: VODStatus) => {
        const logProgram: Recorded | undefined = log[program.url];
        const logEps = logProgram != null ? logProgram.episodes : [];
        const targets = program.episodes.filter(    // find target to download 
            fetchedEp => fetchedEp.free && logEps.every(logEp => fetchedEp.videoURL !== logEp.videoURL)
        );
        return {
            ...program,
            episodes: targets
        }
    });
    // download videos
    const downloadedLog: Recorded[] = downloadTargets.map(program => {
        const _program = program as Recorded;
        _program.episodes = program.episodes.map(ep => 
                download(ep, program.title, recordedDir));
        return _program;
    })


    let newLog = log;
    downloadedLog.forEach((program: Recorded) => {
        const alreadyDownloaded: Episode[] = newLog[program.url].episodes || [];
        program.episodes = [...alreadyDownloaded, ...program.episodes]
        Object.assign(newLog, { [program.url]: program });
    });

    fs.writeFileSync(logPath, JSON.stringify(newLog));

})();
