import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import url from "url";

import yargs from "yargs";
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

const defaultURLJSONPath = "~/.config/abemadl/urls.json"

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

const getText = (eh: puppeteer.ElementHandle | null) => eh !== null
                ? eh.getProperty("textContent").then(p => p.jsonValue())
                : null;

const getHref = async (eh: puppeteer.ElementHandle | null) => eh !== null
                ? await (await eh.getProperty("href")).jsonValue() as string
                : null;


async function getNestedEpisodeURLs(browser: puppeteer.Browser, URL: string): Promise<string[]> {
    const page = await browser.newPage();
    await page.goto(URL);

    const tablist = await page.$$("li.com-m-TabList__tab > a.com-m-TabList__label-container");
    function isNonNull(URL: string | null): URL is string {
        return URL !== null
    }
    return tablist === []
        ? [URL]
        : Promise.all(tablist.map(getHref))
            .then(urls => urls.filter(isNonNull))
            .then(urls => [URL, ...urls]);
}

async function wait (ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function scrape(browser: puppeteer.Browser, URL: string): Promise<VODStatus> {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    await page.goto(URL);
    await page.waitForSelector("p.com-video-EpisodeList__title");
    await page.waitForSelector("span.com-vod-VODLabel");

    // scroll to the bottom for programs later then ep40 
    let lastHeight = 0;
    let bottom = 0;
    do {
        lastHeight = bottom
        bottom = await page.evaluate(() => {
            window.scrollBy(0, document.body.scrollHeight);
            return document.body.scrollHeight
        })

        await wait(5000);
    } while (lastHeight < bottom)

    //const html = await page.content();
    //fs.writeFile("./hoge.html", html, () => {});

    //await page.screenshot({ path: "./hoge.jpg", type: "jpeg", quality: 100 });


    const title = await page.$("h1.com-video-TitleSection__title").then(getText) as string;

    const episodeEHs = await page.$$("div.com-video-EpisodeList__listitem");
    const episodes = await Promise.all(episodeEHs.map(async episode => {

        const videoURLEH = await episode.$("a.com-a-Link");
        const videoURL: string | null = await getHref(videoURLEH)

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
    const dstPath = path.join(recordedDir, sanitize(title));
    fs.mkdirSync(dstPath, { recursive: true });

    const filePath = abspath(path.join(dstPath, filename));


    try {
        execSync(`streamlink ${videoURL} best -o '${filePath}'`);
    } catch (err) {
        throw err;
    }
    return episode;
}

function downloadVideos(programs: VODStatus[], rawRecordedDir: string) {
    const logPath = abspath("~/.log/abemadl/downloads.json");
    initFile(logPath, "{}");

    const log = JSON.parse(fs.readFileSync(logPath, "utf8")) as Log;
    const recordedDir = abspath(rawRecordedDir);

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
    // append a log
    downloadedLog.forEach((program: Recorded) => {
        const alreadyDownloaded: Episode[] = newLog[program.url]?.episodes || [];
        program.episodes = [...alreadyDownloaded, ...program.episodes]
        Object.assign(newLog, { [program.url]: program });
    });

    fs.writeFileSync(logPath, JSON.stringify(newLog));
}


async function crawl(rawUrlsPath: string, recordedDir: string, dryrun: boolean, browserPath?: string){
    const urlsPath = abspath(rawUrlsPath);
    initFile(urlsPath, "[]");
    const urls = JSON.parse(fs.readFileSync(urlsPath, "utf8")) as string[];


    const browser = await launchBrowser(browserPath);
    try {
        // fetch nested urls
        const nested_urls = ([] as string[]).concat(...await Promise.all(urls.map(URL => getNestedEpisodeURLs(browser, URL))));
        // fetch metadata
        const programs: VODStatus[] = await Promise.all(nested_urls.map(URL => scrape(browser, URL)));
        await browser.close();

        dryrun ? console.log(programs.map(p => p.episodes))
            : downloadVideos(programs, recordedDir);
    }
    catch (err) {
        await browser.close();
        process.exit(1);
    }

}


async function launchBrowser(browserPath?: string): Promise<puppeteer.Browser> {
    const defaultOption = {
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }

    const option = typeof browserPath === undefined
        ? defaultOption
        : {
            executablePath: browserPath,
            headless: true,
            ...defaultOption
        }

    return puppeteer.launch(option);
}

function add(URL: string, jsonpath: string){
    const urlsPath = abspath(jsonpath);
    initFile(urlsPath, "[]");

    const old = JSON.parse(fs.readFileSync(urlsPath, "utf8")) as string[];
    const _new = [URL].concat(old);
    fs.writeFileSync(urlsPath, JSON.stringify(_new, null, 4));
    
}


(function main(){

    yargs.command("crawl", "download videos from URLs in a JSON List", {
        "urls": {
            default: defaultURLJSONPath
        },
        "recorded-dir": {
            alias: "dst",
            default: "./"
        },
        "browser-path": {
            alias: "dst",
        },
        "dry-run": {
            alias: "dryrun",
            boolean: true,
            default: false
        }
    },
    args => {
        const browserPath = args.browserpath;
        crawl(args.urls as string, args.dst as string, args.dryrun as boolean, browserPath as string);
    })
    .command("add <URL>", "add a specified URL into a JSON list", yargs => {
        yargs.positional("URL", {
            describe: "abema URL"
        })
    },
    args => {
        add(args.URL as string, defaultURLJSONPath)
    })
    .argv;

})();
