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
import { chooseFile, saveFile } from "@utils/web";
import { Forms, moment, showToast, Toasts, UserSettingsActionCreators, UserSettingsProtoStore, useState } from "@webpack/common";

interface FavoriteGif {
    src?: string;
    gifSrc?: string;
    format?: number | string;
    width?: number;
    height?: number;
    order?: number;
}

interface FavoriteGifs {
    gifs?: Record<string, FavoriteGif>;
    hideTooltip?: boolean;
}

interface GifStorageBackup {
    format: "VencordGifStorageBackup";
    version: 1;
    exportedAt: string;
    favoriteGifs: {
        gifs: Record<string, FavoriteGif>;
        hideTooltip?: boolean;
    };
}

const settings = definePluginSettings({
    backupControls: {
        type: OptionType.COMPONENT,
        component: GifStorageBackupPanel
    }
});

function isSafeObject(obj: unknown): boolean {
    if (obj == null || typeof obj !== "object") return true;

    for (const key in obj) {
        if (["__proto__", "constructor", "prototype"].includes(key)) return false;
        if (!isSafeObject((obj as Record<string, unknown>)[key])) return false;
    }

    return true;
}

function getStoredFavoriteGifs() {
    return UserSettingsProtoStore.frecencyWithoutFetchingLatest.favoriteGifs as FavoriteGifs | undefined;
}

async function loadFavoriteGifs() {
    await UserSettingsActionCreators.FrecencyUserSettingsActionCreators.loadIfNecessary();
    return getStoredFavoriteGifs();
}

function normalizeFavoriteGif(gif: unknown): FavoriteGif | null {
    if (gif == null || typeof gif !== "object") return null;

    const raw = gif as Record<string, unknown>;
    const normalized: FavoriteGif = {};

    if (typeof raw.src === "string") normalized.src = raw.src;
    if (typeof raw.gifSrc === "string") normalized.gifSrc = raw.gifSrc;
    if (typeof raw.format === "number" || typeof raw.format === "string") normalized.format = raw.format;
    if (typeof raw.width === "number") normalized.width = raw.width;
    if (typeof raw.height === "number") normalized.height = raw.height;
    if (typeof raw.order === "number") normalized.order = raw.order;

    return normalized.src || normalized.gifSrc ? normalized : null;
}

function parseBackup(data: string) {
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch (error) {
        throw new Error("Failed to parse JSON: " + String(error));
    }

    if (!isSafeObject(parsed)) throw new Error("Backup contains unsafe object keys.");
    if (parsed == null || typeof parsed !== "object") throw new Error("Backup is not an object.");

    const backup = parsed as Partial<GifStorageBackup>;
    if (backup.format !== "VencordGifStorageBackup" || backup.version !== 1) {
        throw new Error("Invalid GIF storage backup file.");
    }

    const gifs = backup.favoriteGifs?.gifs;
    if (gifs == null || typeof gifs !== "object") {
        throw new Error("Backup has no favorite GIFs.");
    }

    const normalizedGifs: Record<string, FavoriteGif> = {};
    for (const [url, gif] of Object.entries(gifs)) {
        if (typeof url !== "string") continue;

        const normalized = normalizeFavoriteGif(gif);
        if (normalized != null) normalizedGifs[url] = normalized;
    }

    return {
        gifs: normalizedGifs,
        hideTooltip: Object.keys(normalizedGifs).length > 2
    };
}

async function readBackupFile() {
    if (IS_DISCORD_DESKTOP) {
        const [file] = await DiscordNative.fileManager.openFiles({
            filters: [
                { name: "Vencord GIF Storage Backup", extensions: ["json"] },
                { name: "all", extensions: ["*"] }
            ]
        });

        return file ? new TextDecoder().decode(file.data) : null;
    }

    const file = await chooseFile("application/json,.json");
    return file ? await file.text() : null;
}

async function writeBackupFile(data: string) {
    const filename = `vencord-gif-storage-${moment().format("YYYY-MM-DD")}.json`;
    const encoded = new TextEncoder().encode(data);

    if (IS_DISCORD_DESKTOP) {
        DiscordNative.fileManager.saveWithDialog(encoded, filename);
        return;
    }

    saveFile(new File([encoded], filename, { type: "application/json" }));
}

async function exportGifStorage() {
    const favoriteGifs = await loadFavoriteGifs();
    const gifs = favoriteGifs?.gifs ?? {};

    const backup: GifStorageBackup = {
        format: "VencordGifStorageBackup",
        version: 1,
        exportedAt: new Date().toISOString(),
        favoriteGifs: {
            gifs,
            hideTooltip: favoriteGifs?.hideTooltip
        }
    };

    await writeBackupFile(JSON.stringify(backup, null, 4));
    return Object.keys(gifs).length;
}

async function importGifStorage() {
    const data = await readBackupFile();
    if (data == null) return null;

    const imported = parseBackup(data);
    const importedCount = Object.keys(imported.gifs).length;

    await UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync("favoriteGifs", (favoriteGifs: FavoriteGifs) => {
        favoriteGifs.gifs = imported.gifs;
        favoriteGifs.hideTooltip = imported.hideTooltip;
    });

    return importedCount;
}

function GifStorageBackupPanel() {
    const [busy, setBusy] = useState<"export" | "import" | null>(null);
    const [summary, setSummary] = useState("");

    async function runExport() {
        if (busy) return;

        setBusy("export");
        setSummary("");

        try {
            const count = await exportGifStorage();
            const message = `Exported ${count} favorite ${count === 1 ? "GIF" : "GIFs"}.`;
            setSummary(message);
            showToast(message, Toasts.Type.SUCCESS);
        } catch (error) {
            const message = `Failed to export GIF storage: ${error instanceof Error ? error.message : String(error)}`;
            setSummary(message);
            showToast(message, Toasts.Type.FAILURE);
        } finally {
            setBusy(null);
        }
    }

    async function runImport() {
        if (busy) return;

        setBusy("import");
        setSummary("");

        try {
            const count = await importGifStorage();
            if (count == null) return;

            const message = `Imported ${count} favorite ${count === 1 ? "GIF" : "GIFs"}.`;
            setSummary(message);
            showToast(message, Toasts.Type.SUCCESS);
        } catch (error) {
            const message = `Failed to import GIF storage: ${error instanceof Error ? error.message : String(error)}`;
            setSummary(message);
            showToast(message, Toasts.Type.FAILURE);
        } finally {
            setBusy(null);
        }
    }

    return (
        <Flex flexDirection="column" gap={8}>
            <Forms.FormText>
                Export your favorite GIF storage to a JSON file or replace it from a backup file.
            </Forms.FormText>
            <Flex gap={8}>
                <Button onClick={runExport} disabled={busy != null}>
                    {busy === "export" ? "Exporting..." : "Export GIF storage"}
                </Button>
                <Button onClick={runImport} disabled={busy != null} variant="secondary">
                    {busy === "import" ? "Importing..." : "Import GIF storage"}
                </Button>
            </Flex>
            {summary !== "" && (
                <Forms.FormText>
                    {summary}
                </Forms.FormText>
            )}
        </Flex>
    );
}

export default definePlugin({
    name: "GifStorageBackup",
    description: "Export and import your favorite GIF storage.",
    authors: [Devs.Yuppers],
    tags: ["Emotes", "Utility"],

    settings
});
