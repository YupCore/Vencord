/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "ExtendedGifStorage",
    description: "Removes Discord's client-side favorite GIF storage byte cap.",
    authors: [Devs.Yuppers],
    tags: ["Emotes", "Utility"],

    patches: [
        {
            find: 'updateAsync("favoriteGifs"',
            replacement: [
                {
                    match: /(toBinary\(\i\)\.length\s*>\s*)762880/,
                    replace: "$1Number.MAX_SAFE_INTEGER"
                }
            ]
        },
        {
            find: "favoriteGifs.gifs",
            replacement: [
                {
                    match: /(\i\s*\+\s*\i\s*>\s*)762880/,
                    replace: "$1Number.MAX_SAFE_INTEGER"
                },
                {
                    match: /(\i\s*>\s*)762880(?=;)/,
                    replace: "$1Number.MAX_SAFE_INTEGER"
                }
            ]
        },
        {
            find: 'sortBy("order").reverse().value()',
            replacement: {
                match: /(\.sortBy\("order"\)\.reverse\(\)\.value\(\),\s*\[)(\i)(,\s*\i\]\))/,
                replace: "$1$2,Object.keys($2).length$3"
            }
        }
    ],
});
