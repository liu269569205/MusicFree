/**
 * 歌曲「指定使用文件」映射。
 *
 * 场景：下载目录里同名歌曲可能有多个版本（不同作者、不同插件源），
 * 按「歌名@作者」自动匹配容易串文件。这里允许用户在某首歌的下载文件面板里
 * 手动指定「这首歌播放时用哪个文件」，映射持久化保存，优先级高于自动匹配。
 *
 * 存储键：`歌名@作者`（与下载文件命名规则一致，都经过 escapeCharacter 处理），
 * 值：文件的裸路径（不带 file://）。
 */

import getOrCreateMMKV from "@/utils/getOrCreateMMKV";
import { escapeCharacter } from "@/utils/fileUtils";
import EventEmitter from "eventemitter3";

const STORE_NAME = "App.SongFileOverride";
const STORE_KEY = "overrides";

let cache: Record<string, string> | null = null;
const emitter = new EventEmitter();

function getStore() {
    return getOrCreateMMKV(STORE_NAME);
}

function load(): Record<string, string> {
    if (cache) {
        return cache;
    }
    try {
        const raw = getStore().getString(STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        cache =
            parsed && typeof parsed === "object"
                ? (parsed as Record<string, string>)
                : {};
    } catch {
        cache = {};
    }
    return cache!;
}

function persist() {
    try {
        getStore().set(STORE_KEY, JSON.stringify(cache ?? {}));
    } catch {
        // 持久化失败不影响本次会话
    }
}

function toBarePath(path: string): string {
    return path.startsWith("file://") ? path.slice("file://".length) : path;
}

/** 某首歌的映射键（歌名@作者） */
export function getSongFileKey(
    mediaItem: ICommon.IMediaBase | null | undefined,
): string {
    const title = escapeCharacter(mediaItem?.title ?? "");
    const artist = escapeCharacter(mediaItem?.artist ?? "");
    if (!title) {
        return "";
    }
    return `${title}@${artist}`;
}

/** 取某首歌手动指定的文件路径（裸路径），没有指定时返回 null */
export function getSongFileOverride(
    mediaItem: ICommon.IMediaBase | null | undefined,
): string | null {
    const key = getSongFileKey(mediaItem);
    if (!key) {
        return null;
    }
    const map = load();
    return map[key] ?? null;
}

/** 指定某首歌使用哪个文件（后续播放/已下载判定优先使用它） */
export function setSongFileOverride(
    mediaItem: ICommon.IMediaBase | null | undefined,
    filePath: string,
) {
    const key = getSongFileKey(mediaItem);
    if (!key || !filePath) {
        return;
    }
    const map = load();
    map[key] = toBarePath(filePath);
    persist();
    emitter.emit("change", key);
}

/** 取消指定，回到自动匹配 */
export function clearSongFileOverride(
    mediaItem: ICommon.IMediaBase | null | undefined,
) {
    const key = getSongFileKey(mediaItem);
    if (!key) {
        return;
    }
    const map = load();
    if (map[key] === undefined) {
        return;
    }
    delete map[key];
    persist();
    emitter.emit("change", key);
}

/** 订阅指定文件变化（返回取消订阅函数） */
export function onSongFileOverrideChanged(cb: () => void): () => void {
    emitter.on("change", cb);
    return () => {
        emitter.off("change", cb);
    };
}

/** 判断某个文件是否是这首歌「当前指定使用」的文件 */
export function isSongFileOverridden(
    mediaItem: ICommon.IMediaBase | null | undefined,
    filePath: string,
): boolean {
    const current = getSongFileOverride(mediaItem);
    return !!current && !!filePath && current === toBarePath(filePath);
}
