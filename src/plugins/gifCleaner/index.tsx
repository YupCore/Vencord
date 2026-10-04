/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Forms, showToast, Toasts, UserSettingsActionCreators, UserSettingsProtoStore, useState } from "@webpack/common";

interface StoredFavoriteGif {
    src?: string;
    gifSrc?: string;
    url?: string;
}

type FavoriteGifs = {
    gifs?: Record<string, StoredFavoriteGif>;
    hideTooltip?: boolean;
};

interface GifCheckResult {
    url: string;
    mediaUrl: string;
    ok: boolean;
}

function isIntegerInRange(value: unknown, min: number, max: number) {
    const numberValue = typeof value === "number" ? value : Number(value);
    return Number.isInteger(numberValue) && numberValue >= min && numberValue <= max;
}

const settings = definePluginSettings({
    scanButton: {
        type: OptionType.COMPONENT,
        component: ScanButton
    },
    concurrency: {
        type: OptionType.NUMBER,
        description: "How many GIF URLs to check at the same time",
        default: 12,
        isValid: value => isIntegerInRange(value, 1, 64) || "Must be an integer from 1 to 64"
    },
    timeoutMs: {
        type: OptionType.NUMBER,
        description: "How long to wait for each URL before treating it as broken",
        default: 8000,
        isValid: value => isIntegerInRange(value, 1000, 60000) || "Must be an integer from 1000 to 60000"
    },
    retries: {
        type: OptionType.NUMBER,
        description: "How many times a failed URL should be retried before deletion",
        default: 2,
        isValid: value => isIntegerInRange(value, 1, 5) || "Must be an integer from 1 to 5"
    },
    highFailureRateAbort: {
        type: OptionType.BOOLEAN,
        description: "Abort cleanup instead of deleting if many GIFs fail, which can indicate rate limits or provider/network issues",
        default: true
    }
});

function getFavoriteGifs() {
    return UserSettingsProtoStore.frecencyWithoutFetchingLatest.favoriteGifs?.gifs as Record<string, StoredFavoriteGif> | undefined;
}

function getMediaUrl(url: string, gif: StoredFavoriteGif) {
    return gif.src || gif.gifSrc || gif.url || url;
}

function testImage(url: string, timeoutMs: number) {
    return new Promise<boolean>(resolve => {
        const image = new Image();
        const timeout = window.setTimeout(() => done(false), timeoutMs);

        function done(ok: boolean) {
            window.clearTimeout(timeout);
            image.onload = null;
            image.onerror = null;
            image.src = "";
            resolve(ok);
        }

        image.onload = () => done(true);
        image.onerror = () => done(false);
        image.src = url;
    });
}

function testVideo(url: string, timeoutMs: number) {
    return new Promise<boolean>(resolve => {
        const video = document.createElement("video");
        const timeout = window.setTimeout(() => done(false), timeoutMs);

        function done(ok: boolean) {
            window.clearTimeout(timeout);
            video.onloadedmetadata = null;
            video.oncanplay = null;
            video.onerror = null;
            video.removeAttribute("src");
            video.load();
            resolve(ok);
        }

        video.muted = true;
        video.preload = "metadata";
        video.onloadedmetadata = () => done(true);
        video.oncanplay = () => done(true);
        video.onerror = () => done(false);
        video.src = url;
    });
}

async function isReachableMedia(url: string, timeoutMs: number) {
    return await testImage(url, timeoutMs) || await testVideo(url, timeoutMs);
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function jitterDelay() {
    return 150 + Math.floor(Math.random() * 301);
}

async function checkGif(url: string, gif: StoredFavoriteGif): Promise<GifCheckResult> {
    const mediaUrl = getMediaUrl(url, gif);

    for (let i = 0; i < settings.store.retries; i++) {
        if (i > 0) await sleep(jitterDelay());

        if (await isReachableMedia(mediaUrl, settings.store.timeoutMs)) {
            return { url, mediaUrl, ok: true };
        }
    }

    return { url, mediaUrl, ok: false };
}

async function mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
    onProgress?: (done: number) => void
) {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    let done = 0;

    async function worker() {
        for (; ;) {
            const index = nextIndex++;
            if (index >= items.length) return;

            results[index] = await mapper(items[index], index);
            done++;
            onProgress?.(done);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}

async function removeBrokenGifs(urls: string[]) {
    if (!urls.length) return;

    await UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync("favoriteGifs", (favoriteGifs: FavoriteGifs) => {
        if (favoriteGifs.gifs == null) return false;

        let changed = false;
        for (const url of urls) {
            if (url in favoriteGifs.gifs) {
                delete favoriteGifs.gifs[url];
                changed = true;
            }
        }

        if (!changed) return false;
        favoriteGifs.hideTooltip = Object.keys(favoriteGifs.gifs).length > 2;
    });
}

async function cleanStaleGifs(onProgress?: (done: number, total: number) => void) {
    await UserSettingsActionCreators.FrecencyUserSettingsActionCreators.loadIfNecessary();

    const favorites = getFavoriteGifs();
    const entries = Object.entries(favorites ?? {});
    if (!entries.length) {
        return { checked: 0, removed: 0 };
    }

    const results = await mapConcurrent(
        entries,
        settings.store.concurrency,
        async ([url, gif]) => {
            await sleep(jitterDelay());
            return checkGif(url, gif);
        },
        done => onProgress?.(done, entries.length)
    );
    const brokenUrls = results.filter(result => !result.ok).map(result => result.url);

    if (settings.store.highFailureRateAbort && brokenUrls.length >= 10 && brokenUrls.length / entries.length >= 0.25) {
        throw new Error(`Aborted because ${brokenUrls.length} of ${entries.length} GIFs failed to load. This may be a rate limit or provider/network issue.`);
    }

    await removeBrokenGifs(brokenUrls);

    return {
        checked: entries.length,
        removed: brokenUrls.length
    };
}

function ScanButton() {
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [summary, setSummary] = useState("");

    async function run() {
        if (running) return;

        setRunning(true);
        setProgress({ done: 0, total: 0 });
        setSummary("");

        try {
            const result = await cleanStaleGifs((done, total) => setProgress({ done, total }));

            const message = result.removed === 0
                ? `Checked ${result.checked} favorite GIFs. No stale GIFs found.`
                : `Checked ${result.checked} favorite GIFs and removed ${result.removed} stale ${result.removed === 1 ? "GIF" : "GIFs"}.`;

            setSummary(message);
            showToast(message, Toasts.Type.SUCCESS);
        } catch (error) {
            const message = `Failed to clean stale GIFs: ${error instanceof Error ? error.message : String(error)}`;
            setSummary(message);
            showToast(message, Toasts.Type.FAILURE);
        } finally {
            setRunning(false);
        }
    }

    return (
        <Flex flexDirection="column" gap={8}>
            <Forms.FormText>
                Check every favorite GIF media URL and remove entries that no longer load.
            </Forms.FormText>
            <div>
                <Button onClick={run} disabled={running}>
                    {running ? "Scanning..." : "Scan and clean stale GIFs"}
                </Button>
            </div>
            {running && progress.total > 0 && (
                <Forms.FormText>
                    Checked {progress.done} / {progress.total}
                </Forms.FormText>
            )}
            {summary !== "" && (
                <Forms.FormText>
                    {summary}
                </Forms.FormText>
            )}
        </Flex>
    );
}

export default definePlugin({
    name: "StaleGifCleaner",
    description: "Finds and removes favorite GIFs whose media URLs no longer load.",
    authors: [Devs.Yuppers],
    tags: ["Emotes", "Utility"],

    settings,

    toolboxActions: {
        "Clean stale favorite GIFs": () => {
            cleanStaleGifs().then(
                result => showToast(`Checked ${result.checked} favorite GIFs, removed ${result.removed}.`, Toasts.Type.SUCCESS),
                error => showToast(`Failed to clean stale GIFs: ${error instanceof Error ? error.message : String(error)}`, Toasts.Type.FAILURE)
            );
        }
    }
});
